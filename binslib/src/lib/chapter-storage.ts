/**
 * Chapter Storage Module — Per-book Bundle Format (BLIB v1 & v2)
 *
 * Stores all chapters for a book in a single binary bundle file instead of
 * individual .zst files per chapter. This reduces file count from millions
 * to thousands, eliminating filesystem overhead and improving I/O performance.
 *
 * v1 format (little-endian, 12-byte header):
 *   [4 bytes]  magic: "BLIB"
 *   [4 bytes]  uint32: version (1)
 *   [4 bytes]  uint32: entry count (N)
 *   [N × 16 bytes] index entries (sorted by chapter index):
 *     [4 bytes] uint32: chapter index number
 *     [4 bytes] uint32: data offset (from file start)
 *     [4 bytes] uint32: compressed data length
 *     [4 bytes] uint32: uncompressed data length
 *   [variable] concatenated zstd-compressed chapter bodies
 *
 * v2 format (little-endian, 16-byte header):
 *   [4 bytes]  magic: "BLIB"
 *   [4 bytes]  uint32: version (2)
 *   [4 bytes]  uint32: entry count (N)
 *   [2 bytes]  uint16: meta entry size M (256)
 *   [2 bytes]  uint16: reserved (0)
 *   [N × 16 bytes] index entries (sorted by chapter index):
 *     [4 bytes] uint32: chapter index number
 *     [4 bytes] uint32: block offset (from file start, points to meta+data)
 *     [4 bytes] uint32: compressed data length (excludes metadata prefix)
 *     [4 bytes] uint32: uncompressed data length
 *   Per chapter block (at block offset):
 *     [M bytes] fixed-size metadata (title, slug, word_count — zero-padded)
 *     [variable] zstd-compressed chapter body
 *
 * Readers accept both v1 and v2.  New writes always produce v2.
 *
 * Legacy support:
 *   Reads fall back to individual .zst/.gz files if no bundle exists,
 *   enabling gradual migration from the old per-file storage format.
 *
 * File layout:
 *   data/compressed/{book_id}.bundle    — bundle format (one file per book)
 *   data/compressed/{book_id}/          — legacy individual files
 *     {index}.txt.zst
 *     {index}.txt.gz
 */

import { gunzipSync } from "node:zlib";
import { Compressor, Decompressor } from "zstd-napi";
import fs from "node:fs";
import path from "node:path";

// ─── Configuration ───────────────────────────────────────────────────────────

const CHAPTERS_DIR = path.resolve(
  process.env.CHAPTERS_DIR || "./data/compressed",
);

const DICT_PATH = path.resolve(
  process.env.ZSTD_DICT_PATH || "./data/global.dict",
);

// ─── Bundle format constants ─────────────────────────────────────────────────

const BUNDLE_MAGIC = Buffer.from("BLIB");
const BUNDLE_VERSION_1 = 1;
const BUNDLE_VERSION_2 = 2;
const BUNDLE_HEADER_SIZE_V1 = 12; // magic(4) + version(4) + count(4)
const BUNDLE_HEADER_SIZE_V2 = 16; // magic(4) + version(4) + count(4) + metaSize(2) + reserved(2)
const BUNDLE_ENTRY_SIZE = 16; // indexNum(4) + offset(4) + compLen(4) + rawLen(4)
const META_ENTRY_SIZE = 256; // fixed per-chapter metadata block size for v2

// ─── Compressor / Decompressor singletons ────────────────────────────────────

let compressor: Compressor | null = null;
let decompressor: Decompressor | null = null;

function getCompressor(): Compressor {
  if (!compressor) {
    compressor = new Compressor();
    compressor.setParameters({ compressionLevel: 3 });
    if (fs.existsSync(DICT_PATH)) {
      compressor.loadDictionary(fs.readFileSync(DICT_PATH));
    }
  }
  return compressor;
}

function getDecompressor(): Decompressor {
  if (!decompressor) {
    decompressor = new Decompressor();
    if (fs.existsSync(DICT_PATH)) {
      decompressor.loadDictionary(fs.readFileSync(DICT_PATH));
    }
  }
  return decompressor;
}

// ─── Bundle index types & cache ──────────────────────────────────────────────

interface BundleEntry {
  indexNum: number;
  offset: number; // v1: points to compressed data; v2: points to meta+data block
  compressedLen: number; // compressed data length (excludes metadata prefix)
  uncompressedLen: number;
}

interface BundleIndex {
  filePath: string;
  mtime: number;
  entries: Map<number, BundleEntry>;
  sortedIndices: number[];
  metaEntrySize: number; // 0 for v1, META_ENTRY_SIZE for v2
  headerSize: number; // 12 for v1, 16 for v2
}

const INDEX_CACHE_MAX = 128;
const indexCache = new Map<number, BundleIndex>();
const indexCacheOrder: number[] = []; // LRU order — most recent at end

function evictIndexCache(): void {
  while (indexCacheOrder.length > INDEX_CACHE_MAX) {
    const oldest = indexCacheOrder.shift()!;
    indexCache.delete(oldest);
  }
}

function invalidateBookCache(bookId: number): void {
  indexCache.delete(bookId);
  const idx = indexCacheOrder.indexOf(bookId);
  if (idx !== -1) indexCacheOrder.splice(idx, 1);
}

function touchCacheOrder(bookId: number): void {
  const idx = indexCacheOrder.indexOf(bookId);
  if (idx !== -1) indexCacheOrder.splice(idx, 1);
  indexCacheOrder.push(bookId);
}

// ─── Path helpers ────────────────────────────────────────────────────────────

function bundlePath(bookId: number): string {
  return path.join(CHAPTERS_DIR, `${bookId}.bundle`);
}

function legacyDir(bookId: number): string {
  return path.join(CHAPTERS_DIR, String(bookId));
}

// ─── Bundle index reader (cached) ────────────────────────────────────────────

function readBundleIndex(bookId: number): BundleIndex | null {
  const bp = bundlePath(bookId);

  // Check cache — validate mtime hasn't changed
  const cached = indexCache.get(bookId);
  if (cached) {
    try {
      const stat = fs.statSync(bp);
      if (stat.mtimeMs === cached.mtime) {
        touchCacheOrder(bookId);
        return cached;
      }
    } catch {
      // File removed since cached
      invalidateBookCache(bookId);
      return null;
    }
  }

  // Read from disk
  let fd: number;
  try {
    fd = fs.openSync(bp, "r");
  } catch {
    return null;
  }

  try {
    const stat = fs.fstatSync(fd);
    if (stat.size < BUNDLE_HEADER_SIZE_V1) return null;

    // Read max header size (v2 = 16 bytes; v1 = 12 bytes fits inside)
    const headerBuf = Buffer.alloc(BUNDLE_HEADER_SIZE_V2);
    fs.readSync(fd, headerBuf, 0, BUNDLE_HEADER_SIZE_V2, 0);

    if (!headerBuf.subarray(0, 4).equals(BUNDLE_MAGIC)) return null;
    const version = headerBuf.readUInt32LE(4);
    if (version !== BUNDLE_VERSION_1 && version !== BUNDLE_VERSION_2)
      return null;

    const isV2 = version === BUNDLE_VERSION_2;
    const headerSize = isV2 ? BUNDLE_HEADER_SIZE_V2 : BUNDLE_HEADER_SIZE_V1;
    const metaEntrySize = isV2 ? headerBuf.readUInt16LE(12) : 0;

    if (stat.size < headerSize) return null;

    const count = headerBuf.readUInt32LE(8);
    if (count === 0) {
      // Valid but empty bundle
      const bi: BundleIndex = {
        filePath: bp,
        mtime: stat.mtimeMs,
        entries: new Map(),
        sortedIndices: [],
        metaEntrySize,
        headerSize,
      };
      invalidateBookCache(bookId);
      indexCache.set(bookId, bi);
      touchCacheOrder(bookId);
      evictIndexCache();
      return bi;
    }

    const indexBufSize = count * BUNDLE_ENTRY_SIZE;
    if (stat.size < headerSize + indexBufSize) return null;

    // Read index section
    const indexBuf = Buffer.alloc(indexBufSize);
    fs.readSync(fd, indexBuf, 0, indexBufSize, headerSize);

    const entries = new Map<number, BundleEntry>();
    const sortedIndices: number[] = [];

    for (let i = 0; i < count; i++) {
      const base = i * BUNDLE_ENTRY_SIZE;
      const entry: BundleEntry = {
        indexNum: indexBuf.readUInt32LE(base),
        offset: indexBuf.readUInt32LE(base + 4),
        compressedLen: indexBuf.readUInt32LE(base + 8),
        uncompressedLen: indexBuf.readUInt32LE(base + 12),
      };
      entries.set(entry.indexNum, entry);
      sortedIndices.push(entry.indexNum);
    }

    const bi: BundleIndex = {
      filePath: bp,
      mtime: stat.mtimeMs,
      entries,
      sortedIndices,
      metaEntrySize,
      headerSize,
    };

    // Populate cache
    invalidateBookCache(bookId);
    indexCache.set(bookId, bi);
    touchCacheOrder(bookId);
    evictIndexCache();

    return bi;
  } finally {
    fs.closeSync(fd);
  }
}

// ─── Bundle single-chapter reader ────────────────────────────────────────────

function readFromBundle(bookId: number, indexNum: number): string | null {
  const bi = readBundleIndex(bookId);
  if (!bi) return null;

  const entry = bi.entries.get(indexNum);
  if (!entry) return null;

  const fd = fs.openSync(bi.filePath, "r");
  try {
    const buf = Buffer.alloc(entry.compressedLen);
    // v2: offset points to meta+data block; skip metadata prefix to reach data
    const dataOffset = entry.offset + bi.metaEntrySize;
    fs.readSync(fd, buf, 0, entry.compressedLen, dataOffset);
    return getDecompressor().decompress(buf).toString("utf-8");
  } finally {
    fs.closeSync(fd);
  }
}

// ─── Bundle bulk reader (all chapters raw) ───────────────────────────────────

function readAllBundleRaw(
  bookId: number,
): Map<number, { compressed: Buffer; rawLen: number; metaBlock?: Buffer }> {
  const result = new Map<
    number,
    { compressed: Buffer; rawLen: number; metaBlock?: Buffer }
  >();
  const bp = bundlePath(bookId);

  let fileBuf: Buffer;
  try {
    fileBuf = fs.readFileSync(bp);
  } catch {
    return result;
  }

  if (fileBuf.length < BUNDLE_HEADER_SIZE_V1) return result;
  if (!fileBuf.subarray(0, 4).equals(BUNDLE_MAGIC)) return result;

  const version = fileBuf.readUInt32LE(4);
  if (version !== BUNDLE_VERSION_1 && version !== BUNDLE_VERSION_2)
    return result;

  const isV2 = version === BUNDLE_VERSION_2;
  const headerSize = isV2 ? BUNDLE_HEADER_SIZE_V2 : BUNDLE_HEADER_SIZE_V1;
  const metaEntrySize = isV2 ? fileBuf.readUInt16LE(12) : 0;

  const count = fileBuf.readUInt32LE(8);
  const indexEnd = headerSize + count * BUNDLE_ENTRY_SIZE;
  if (fileBuf.length < indexEnd) return result;

  for (let i = 0; i < count; i++) {
    const base = headerSize + i * BUNDLE_ENTRY_SIZE;
    const indexNum = fileBuf.readUInt32LE(base);
    const offset = fileBuf.readUInt32LE(base + 4);
    const compLen = fileBuf.readUInt32LE(base + 8);
    const rawLen = fileBuf.readUInt32LE(base + 12);

    const dataOffset = offset + metaEntrySize;
    if (dataOffset + compLen <= fileBuf.length) {
      // Copy the slice so the large fileBuf can be GC'd
      const compressed = Buffer.alloc(compLen);
      fileBuf.copy(compressed, 0, dataOffset, dataOffset + compLen);

      // Preserve metadata block for round-trip (v2 only)
      let metaBlock: Buffer | undefined;
      if (metaEntrySize > 0 && offset + metaEntrySize <= fileBuf.length) {
        metaBlock = Buffer.alloc(metaEntrySize);
        fileBuf.copy(metaBlock, 0, offset, offset + metaEntrySize);
      }

      result.set(indexNum, { compressed, rawLen, metaBlock });
    }
  }

  return result;
}

// ─── Legacy readers (individual .zst / .gz files) ────────────────────────────

function readLegacyZst(bookId: number, indexNum: number): string | null {
  const fp = path.join(legacyDir(bookId), `${indexNum}.txt.zst`);
  try {
    const data = fs.readFileSync(fp);
    return getDecompressor().decompress(data).toString("utf-8");
  } catch {
    return null;
  }
}

function readLegacyGz(bookId: number, indexNum: number): string | null {
  const fp = path.join(legacyDir(bookId), `${indexNum}.txt.gz`);
  try {
    return gunzipSync(fs.readFileSync(fp)).toString("utf-8");
  } catch {
    return null;
  }
}

function listLegacyChapters(bookId: number): number[] {
  const dir = legacyDir(bookId);
  try {
    const stat = fs.statSync(dir);
    if (!stat.isDirectory()) return [];
  } catch {
    return [];
  }

  const indices: number[] = [];
  for (const file of fs.readdirSync(dir)) {
    const match = file.match(/^(\d+)\.txt\.(zst|gz)$/);
    if (match) {
      indices.push(parseInt(match[1], 10));
    }
  }
  return indices.sort((a, b) => a - b);
}

// ─── Bundle writer (raw) ────────────────────────────────────────────────────

/**
 * Write an entire book's chapters as a single bundle file.
 * `chapters` maps indexNum → { compressed (zstd Buffer), rawLen }.
 * This is the lowest-level write — used by BundleWriter.flush(), migration, etc.
 */
export function writeBookBundleRaw(
  bookId: number,
  chapters: Map<
    number,
    { compressed: Buffer; rawLen: number; metaBlock?: Buffer }
  >,
): void {
  if (chapters.size === 0) return;

  fs.mkdirSync(CHAPTERS_DIR, { recursive: true });

  // Always write v2 format
  const headerSize = BUNDLE_HEADER_SIZE_V2;
  const metaSize = META_ENTRY_SIZE;

  // Sort entries by chapter index
  const sorted = [...chapters.entries()].sort((a, b) => a[0] - b[0]);
  const count = sorted.length;
  const dataStart = headerSize + count * BUNDLE_ENTRY_SIZE;

  // Compute block offsets (each block = metaSize + compressedLen)
  interface LayoutEntry {
    indexNum: number;
    blockOffset: number; // points to start of meta+data block
    compLen: number;
    rawLen: number;
    compressed: Buffer;
    metaBlock: Buffer; // META_ENTRY_SIZE bytes (preserved or zero-filled)
  }
  const layout: LayoutEntry[] = [];
  let cursor = dataStart;
  const emptyMeta = Buffer.alloc(metaSize);

  for (const [indexNum, { compressed, rawLen, metaBlock }] of sorted) {
    layout.push({
      indexNum,
      blockOffset: cursor,
      compLen: compressed.length,
      rawLen,
      compressed,
      metaBlock:
        metaBlock && metaBlock.length === metaSize ? metaBlock : emptyMeta,
    });
    cursor += metaSize + compressed.length;
  }

  const totalSize = cursor;

  // Assemble the file
  const buf = Buffer.alloc(totalSize);

  // v2 header: magic + version + count + metaEntrySize + reserved
  BUNDLE_MAGIC.copy(buf, 0);
  buf.writeUInt32LE(BUNDLE_VERSION_2, 4);
  buf.writeUInt32LE(count, 8);
  buf.writeUInt16LE(metaSize, 12);
  buf.writeUInt16LE(0, 14); // reserved

  // Index entries
  for (let i = 0; i < layout.length; i++) {
    const base = headerSize + i * BUNDLE_ENTRY_SIZE;
    const e = layout[i];
    buf.writeUInt32LE(e.indexNum, base);
    buf.writeUInt32LE(e.blockOffset, base + 4);
    buf.writeUInt32LE(e.compLen, base + 8);
    buf.writeUInt32LE(e.rawLen, base + 12);
  }

  // Chapter blocks: metadata prefix + compressed data
  for (const e of layout) {
    e.metaBlock.copy(buf, e.blockOffset);
    e.compressed.copy(buf, e.blockOffset + metaSize);
  }

  // Atomic write: temp file → rename
  const bp = bundlePath(bookId);
  const tmpPath = bp + `.tmp.${process.pid}`;
  try {
    fs.writeFileSync(tmpPath, buf, { mode: 0o644 });
    fs.renameSync(tmpPath, bp);
  } catch (err) {
    // Clean up temp on failure
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* ignore */
    }
    throw err;
  }

  // Invalidate cache so next read picks up the new file
  invalidateBookCache(bookId);
}

// ─── BundleWriter — batch API for import / export scripts ────────────────────

/**
 * Collects chapters in memory and writes them as a single bundle on flush().
 *
 * Usage (import script):
 *   const writer = new BundleWriter(bookId);
 *   // optionally load existing bundle for incremental add:
 *   // const writer = new BundleWriter(bookId, { loadExisting: true });
 *   writer.addChapter(1, bodyText1);
 *   writer.addChapter(2, bodyText2);
 *   writer.addCompressed(3, compressedBuf, rawLen);
 *   const count = writer.flush();
 */
export class BundleWriter {
  private chapters = new Map<
    number,
    { compressed: Buffer; rawLen: number; metaBlock?: Buffer }
  >();

  constructor(
    private bookId: number,
    opts?: { loadExisting?: boolean },
  ) {
    if (opts?.loadExisting) {
      const existing = readAllBundleRaw(bookId);
      for (const [idx, data] of existing) {
        this.chapters.set(idx, data);
      }
    }
  }

  /** Compress and add a chapter body. Replaces if indexNum already present. */
  addChapter(indexNum: number, body: string): void {
    const raw = Buffer.from(body, "utf-8");
    this.chapters.set(indexNum, {
      compressed: getCompressor().compress(raw),
      rawLen: raw.length,
    });
  }

  /** Add an already-compressed chapter. */
  addCompressed(indexNum: number, compressed: Buffer, rawLen: number): void {
    this.chapters.set(indexNum, { compressed, rawLen });
  }

  /** Check whether a chapter index is already in this writer's buffer. */
  has(indexNum: number): boolean {
    return this.chapters.has(indexNum);
  }

  /** Number of chapters currently buffered. */
  get size(): number {
    return this.chapters.size;
  }

  /** Return the highest chapter index in the buffer, or null if empty. */
  maxIndex(): number | null {
    if (this.chapters.size === 0) return null;
    let max = -1;
    for (const k of this.chapters.keys()) {
      if (k > max) max = k;
    }
    return max;
  }

  /** Return the set of all chapter indices currently in the buffer. */
  indices(): Set<number> {
    return new Set(this.chapters.keys());
  }

  /**
   * Write the bundle to disk. Returns number of chapters written.
   * After flush the writer is empty and can be reused or discarded.
   */
  flush(): number {
    const count = this.chapters.size;
    if (count > 0) {
      writeBookBundleRaw(this.bookId, this.chapters);
      this.chapters.clear();
    }
    return count;
  }
}

// ─── Public API (backward-compatible with old per-file interface) ────────────

/**
 * Write a single chapter body to disk.
 *
 * Opens the existing bundle (if any), adds/replaces this chapter, and rewrites.
 * For bulk writes (import), use BundleWriter instead — it is O(N) vs O(N²).
 */
export function writeChapterBody(
  bookId: number,
  indexNum: number,
  body: string,
): void {
  const raw = Buffer.from(body, "utf-8");
  const compressedBuf = getCompressor().compress(raw);

  // Read-modify-write the bundle (preserves existing metadata blocks)
  const existing = readAllBundleRaw(bookId);
  existing.set(indexNum, { compressed: compressedBuf, rawLen: raw.length });
  writeBookBundleRaw(bookId, existing);
}

/**
 * Read a chapter body from disk.
 * Tries bundle first, then falls back to legacy individual .zst/.gz files.
 * Returns null if the chapter does not exist in any format.
 */
export function readChapterBody(
  bookId: number,
  indexNum: number,
): string | null {
  // Bundle (fast path — index is cached)
  const fromBundle = readFromBundle(bookId, indexNum);
  if (fromBundle !== null) return fromBundle;

  // Legacy fallback: individual .zst
  const fromZst = readLegacyZst(bookId, indexNum);
  if (fromZst !== null) return fromZst;

  // Legacy fallback: individual .gz
  return readLegacyGz(bookId, indexNum);
}

/**
 * List all chapter indices that have compressed data on disk.
 * Merges bundle index with any legacy individual files (deduped, sorted).
 */
export function listCompressedChapters(bookId: number): number[] {
  const indices = new Set<number>();

  // From bundle (cached)
  const bi = readBundleIndex(bookId);
  if (bi) {
    for (const idx of bi.sortedIndices) indices.add(idx);
  }

  // From legacy individual files
  for (const idx of listLegacyChapters(bookId)) {
    indices.add(idx);
  }

  return [...indices].sort((a, b) => a - b);
}

// ─── Compress helper for external use ────────────────────────────────────────

/**
 * Compress a body string using the shared zstd compressor + dictionary.
 * Returns { compressed, rawLen } suitable for BundleWriter.addCompressed().
 */
export function compressBody(body: string): {
  compressed: Buffer;
  rawLen: number;
} {
  const raw = Buffer.from(body, "utf-8");
  return {
    compressed: getCompressor().compress(raw),
    rawLen: raw.length,
  };
}
