import { NextRequest, NextResponse } from "next/server";
import { getBookById } from "@/lib/queries";
import fs from "fs";
import path from "path";

const EPUB_CACHE_DIR = path.resolve(
  process.env.EPUB_CACHE_DIR || path.join(process.cwd(), "data/epub"),
);

/**
 * Find a cached EPUB for a book.  Cache filenames follow the pattern
 * `{book_id}_{chapter_count}.epub` so we can check freshness by
 * comparing the embedded chapter count against the DB.
 */
function findCachedEpub(bookId: number): {
  filename: string;
  fullPath: string;
  chapterCount: number;
  sizeBytes: number;
} | null {
  if (!fs.existsSync(EPUB_CACHE_DIR)) return null;

  const prefix = `${bookId}_`;
  const files = fs
    .readdirSync(EPUB_CACHE_DIR)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".epub"));

  if (files.length === 0) return null;

  for (const file of files) {
    const stem = file.replace(/\.epub$/, "");
    const parts = stem.split("_");
    if (parts.length === 2 && /^\d+$/.test(parts[1])) {
      const fullPath = path.join(EPUB_CACHE_DIR, file);
      const stat = fs.statSync(fullPath);
      return {
        filename: file,
        fullPath,
        chapterCount: parseInt(parts[1], 10),
        sizeBytes: stat.size,
      };
    }
  }

  return null;
}

function getDbChapterCount(bookId: number): number {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require("better-sqlite3");
    const dbPath =
      process.env.DATABASE_URL?.replace("file:", "") || "./data/binslib.db";
    const db = new Database(dbPath, { readonly: true });
    const row = db
      .prepare("SELECT COUNT(*) as count FROM chapters WHERE book_id = ?")
      .get(bookId) as { count: number } | undefined;
    db.close();
    return row?.count ?? 0;
  } catch {
    return 0;
  }
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: idStr } = await params;
  const bookId = parseInt(idStr, 10);
  if (isNaN(bookId)) {
    return NextResponse.json({ error: "Invalid book ID" }, { status: 400 });
  }

  const book = await getBookById(bookId);
  if (!book) {
    return NextResponse.json({ error: "Book not found" }, { status: 404 });
  }

  const cached = findCachedEpub(bookId);
  const dbChapterCount = getDbChapterCount(bookId);

  const epubExists = cached !== null;
  const epubFilename = cached?.filename ?? "";
  const epubSizeBytes = cached?.sizeBytes ?? 0;
  const cachedChapterCount = cached?.chapterCount ?? 0;

  // Needs regeneration when:
  // - The cached EPUB has fewer chapters than the DB (new chapters ingested)
  // - The book is ongoing and could have more chapters coming
  const needsRegeneration = epubExists && cachedChapterCount < dbChapterCount;

  return NextResponse.json({
    epub_exists: epubExists,
    epub_filename: epubFilename,
    epub_size_bytes: epubSizeBytes,
    epub_chapter_count: cachedChapterCount,
    db_chapter_count: dbChapterCount,
    book_status: book.status,
    needs_regeneration: needsRegeneration,
  });
}
