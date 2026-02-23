import { gunzipSync } from "node:zlib";
import { Compressor, Decompressor } from "zstd-napi";
import fs from "node:fs";
import path from "node:path";

const CHAPTERS_DIR = path.resolve(
  process.env.CHAPTERS_DIR || "./data/compressed",
);

const DICT_PATH = path.resolve(
  process.env.ZSTD_DICT_PATH || "./data/global.dict",
);

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

export function writeChapterBody(
  bookId: number,
  indexNum: number,
  body: string,
): void {
  const dir = path.join(CHAPTERS_DIR, String(bookId));
  fs.mkdirSync(dir, { recursive: true });
  const compressed = getCompressor().compress(Buffer.from(body, "utf-8"));
  fs.writeFileSync(path.join(dir, `${indexNum}.txt.zst`), compressed);
}

export function readChapterBody(
  bookId: number,
  indexNum: number,
): string | null {
  const dir = path.join(CHAPTERS_DIR, String(bookId));

  const zstPath = path.join(dir, `${indexNum}.txt.zst`);
  if (fs.existsSync(zstPath)) {
    return getDecompressor().decompress(fs.readFileSync(zstPath)).toString("utf-8");
  }

  const gzPath = path.join(dir, `${indexNum}.txt.gz`);
  if (fs.existsSync(gzPath)) {
    return gunzipSync(fs.readFileSync(gzPath)).toString("utf-8");
  }

  return null;
}

/**
 * Disk-first resolution: returns the compressed file content if it exists,
 * otherwise falls back to the body stored in the DB row.
 * This enables incremental migration where some chapters are on disk
 * and others are still only in the database.
 */
export function resolveChapterBody(
  bookId: number,
  indexNum: number,
  dbBody: string | null,
): string | null {
  return readChapterBody(bookId, indexNum) ?? dbBody;
}

export function chapterFileExists(
  bookId: number,
  indexNum: number,
): boolean {
  const dir = path.join(CHAPTERS_DIR, String(bookId));
  return (
    fs.existsSync(path.join(dir, `${indexNum}.txt.zst`)) ||
    fs.existsSync(path.join(dir, `${indexNum}.txt.gz`))
  );
}

/**
 * List all chapter indices that have compressed files (.zst or .gz) on disk.
 * Used for importing pre-compressed chapters from another machine.
 */
export function listCompressedChapters(bookId: number): number[] {
  const dir = path.join(CHAPTERS_DIR, String(bookId));
  if (!fs.existsSync(dir)) return [];

  const indices: number[] = [];
  for (const file of fs.readdirSync(dir)) {
    const match = file.match(/^(\d+)\.txt\.(zst|gz)$/);
    if (match) {
      indices.push(parseInt(match[1], 10));
    }
  }
  return indices.sort((a, b) => a - b);
}
