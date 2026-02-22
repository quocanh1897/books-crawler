import { gunzipSync } from "node:zlib";
import { compressSync, decompressSync } from "@aspect/zstd";
import fs from "node:fs";
import path from "node:path";

const CHAPTERS_DIR = path.resolve(
  process.env.CHAPTERS_DIR || "./data/compressed",
);

export function writeChapterBody(
  bookId: number,
  indexNum: number,
  body: string,
): void {
  const dir = path.join(CHAPTERS_DIR, String(bookId));
  fs.mkdirSync(dir, { recursive: true });
  const compressed = compressSync(Buffer.from(body, "utf-8"), 3);
  fs.writeFileSync(path.join(dir, `${indexNum}.txt.zst`), compressed);
}

export function readChapterBody(
  bookId: number,
  indexNum: number,
): string | null {
  const dir = path.join(CHAPTERS_DIR, String(bookId));

  const zstPath = path.join(dir, `${indexNum}.txt.zst`);
  if (fs.existsSync(zstPath)) {
    return decompressSync(fs.readFileSync(zstPath)).toString("utf-8");
  }

  const gzPath = path.join(dir, `${indexNum}.txt.gz`);
  if (fs.existsSync(gzPath)) {
    return gunzipSync(fs.readFileSync(gzPath)).toString("utf-8");
  }

  return null;
}

/**
 * Disk-first resolution: returns the gzipped file content if it exists,
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
