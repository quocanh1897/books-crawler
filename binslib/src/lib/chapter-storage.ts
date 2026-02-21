import { gzipSync, gunzipSync } from "node:zlib";
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
  fs.writeFileSync(path.join(dir, `${indexNum}.txt.gz`), gzipSync(body));
}

export function readChapterBody(
  bookId: number,
  indexNum: number,
): string | null {
  const fp = path.join(CHAPTERS_DIR, String(bookId), `${indexNum}.txt.gz`);
  if (!fs.existsSync(fp)) return null;
  return gunzipSync(fs.readFileSync(fp)).toString("utf-8");
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
  const fp = path.join(CHAPTERS_DIR, String(bookId), `${indexNum}.txt.gz`);
  return fs.existsSync(fp);
}
