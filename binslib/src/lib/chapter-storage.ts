/**
 * Chapter Storage Module — Per-book Bundle Format
 *
 * Stores all chapters for a book in a single binary bundle file instead of
 * individual .zst files per chapter. This reduces file count from millions
 * to thousands, eliminating filesystem overhead and improving I/O performance.
 *
 * Bundle format (little-endian):
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
 * Legacy support:
 *   Reads fall back to individual .zst/.gz files if no bundle exists,
 *   enabling gradual migration from the old per-file storage format.
 *
 * File layout:
 *   data/compressed/{book_id}.bundle    — new bundle format (one file per book)
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
const BUNDLE_VERSION = 1;
const BUNDLE_HEADER_SIZE = 12; // magic(4) + version(4) + count(4)
const BUNDLE_ENTRY_SIZE = 16; // indexNum(4) + offset(4) + compLen(4) + rawLen(4)

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
  offset: number;
  compressedLen: number;
  uncompressedLen: number;
}

interface BundleIndex {
  filePath: string;
  mtime: number;
  entries: Map<number, BundleEntry>;
  sortedIndices: number[];
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
    if (stat.size < BUNDLE_HEADER_SIZE) return null;

    // Read header
    const headerBuf = Buffer.alloc(BUNDLE_HEADER_SIZE);
    fs.readSync(fd, headerBuf, 0, BUNDLE_HEADER_SIZE, 0);

    if (!headerBuf.subarray(0, 4).equals(BUNDLE_MAGIC)) return null;
    const version = headerBuf.readUInt32LE(4);
    if (version !== BUNDLE_VERSION) return null;
    const count = headerBuf.readUInt32LE(8);
    if (count === 0) {
      // Valid but empty bundle
      const bi: BundleIndex = {
        filePath: bp,
        mtime: stat.mtimeMs,
        entries: new Map(),
        sortedIndices: [],
      };
      invalidateBookCache(bookId);
      indexCache.set(bookId, bi);
      touchCacheOrder(bookId);
      evictIndexCache();
      return bi;
    }

    const indexBufSize = count * BUNDLE_ENTRY_SIZE;
    if (stat.size < BUNDLE_HEADER_SIZE + indexBufSize) return null;

    // Read index section
    const indexBuf = Buffer.alloc(indexBufSize);
    fs.readSync(fd, indexBuf, 0, indexBufSize, BUNDLE_HEADER_SIZE);

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
    fs.readSync(fd, buf, 0, entry.compressedLen, entry.offset);
    return getDecompressor().decompress(buf).toString("utf-8");
  } finally {
    fs.closeSync(fd);
  }
}

// ─── Bundle bulk reader (all chapters raw) ───────────────────────────────────

function readAllBundleRaw(
  bookId: number,
): Map<number, { compressed: Buffer; rawLen: number }> {
  const result = new Map<number, { compressed: Buffer; rawLen: number }>();
  const bp = bundlePath(bookId);

  let fileBuf: Buffer;
  try {
    fileBuf = fs.readFileSync(bp);
  } catch {
    return result;
  }

  if (fileBuf.length < BUNDLE_HEADER_SIZE) return result;
  if (!fileBuf.subarray(0, 4).equals(BUNDLE_MAGIC)) return result;
  if (fileBuf.readUInt32LE(4) !== BUNDLE_VERSION) return result;

  const count = fileBuf.readUInt32LE(8);
  const indexEnd = BUNDLE_HEADER_SIZE + count * BUNDLE_ENTRY_SIZE;
  if (fileBuf.length < indexEnd) return result;

  for (let i = 0; i < count; i++) {
    const base = BUNDLE_HEADER_SIZE + i * BUNDLE_ENTRY_SIZE;
    const indexNum = fileBuf.readUInt32LE(base);
    const offset = fileBuf.readUInt32LE(base + 4);
    const compLen = fileBuf.readUInt32LE(base + 8);
    const rawLen = fileBuf.readUInt32LE(base + 12);

    if (offset + compLen <= fileBuf.length) {
      // Copy the slice so the large fileBuf can be GC'd
      const compressed = Buffer.alloc(compLen);
      fileBuf.copy(compressed, 0, offset, offset + compLen);
      result.set(indexNum, { compressed, rawLen });
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
  chapters: Map<number, { compressed: Buffer; rawLen: number }>,
): void {
  if (chapters.size === 0) return;

  fs.mkdirSync(CHAPTERS_DIR, { recursive: true });

  // Sort entries by chapter index
  const sorted = [...chapters.entries()].sort((a, b) => a[0] - b[0]);
  const count = sorted.length;
  const dataStart = BUNDLE_HEADER_SIZE + count * BUNDLE_ENTRY_SIZE;

  // Compute data offsets
  interface LayoutEntry {
    indexNum: number;
    offset: number;
    compLen: number;
    rawLen: number;
    compressed: Buffer;
  }
  const layout: LayoutEntry[] = [];
  let cursor = dataStart;

  for (const [indexNum, { compressed, rawLen }] of sorted) {
    layout.push({
      indexNum,
      offset: cursor,
      compLen: compressed.length,
      rawLen,
      compressed,
    });
    cursor += compressed.length;
  }

  const totalSize = cursor;

  // Assemble the file
  const buf = Buffer.alloc(totalSize);

  // Header
  BUNDLE_MAGIC.copy(buf, 0);
  buf.writeUInt32LE(BUNDLE_VERSION, 4);
  buf.writeUInt32LE(count, 8);

  // Index entries
  for (let i = 0; i < layout.length; i++) {
    const base = BUNDLE_HEADER_SIZE + i * BUNDLE_ENTRY_SIZE;
    const e = layout[i];
    buf.writeUInt32LE(e.indexNum, base);
    buf.writeUInt32LE(e.offset, base + 4);
    buf.writeUInt32LE(e.compLen, base + 8);
    buf.writeUInt32LE(e.rawLen, base + 12);
  }

  // Chapter data
  for (const e of layout) {
    e.compressed.copy(buf, e.offset);
  }

  // Atomic write: temp file → rename
  const bp = bundlePath(bookId);
  const tmpPath = bp + `.tmp.${process.pid}`;
  try {
    fs.writeFileSync(tmpPath, buf);
    // On Windows, rename over an existing file works in Node.js
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
  private chapters = new Map<number, { compressed: Buffer; rawLen: number }>();

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

  // Read-modify-write the bundle
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
