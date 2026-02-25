import { NextRequest, NextResponse } from "next/server";
import { getBookById } from "@/lib/queries";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";

const EPUB_CACHE_DIR = path.resolve(
  process.env.EPUB_CACHE_DIR || path.join(process.cwd(), "data/epub"),
);
const EPUB_CONVERTER_DIR =
  process.env.EPUB_CONVERTER_DIR ||
  path.resolve(process.cwd(), "../epub-converter");

const generationLocks = new Set<number>();

/**
 * Find a cached EPUB for a book.  Cache filenames follow the pattern
 * `{book_id}_{chapter_count}.epub` so we can check freshness by
 * comparing the embedded chapter count against the DB.
 */
function findCachedEpub(bookId: number): {
  path: string;
  chapterCount: number;
} | null {
  if (!fs.existsSync(EPUB_CACHE_DIR)) return null;

  const prefix = `${bookId}_`;
  const files = fs
    .readdirSync(EPUB_CACHE_DIR)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".epub"));

  if (files.length === 0) return null;

  // Parse chapter count from the first match
  for (const file of files) {
    const stem = file.replace(/\.epub$/, "");
    const parts = stem.split("_");
    if (parts.length === 2 && /^\d+$/.test(parts[1])) {
      return {
        path: path.join(EPUB_CACHE_DIR, file),
        chapterCount: parseInt(parts[1], 10),
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

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: idStr } = await params;
  const bookId = parseInt(idStr, 10);
  if (isNaN(bookId)) {
    return NextResponse.json(
      { status: "error", message: "Invalid book ID" },
      { status: 400 },
    );
  }

  const book = await getBookById(bookId);
  if (!book) {
    return NextResponse.json(
      { status: "error", message: "Book not found" },
      { status: 404 },
    );
  }

  const cached = findCachedEpub(bookId);
  const dbChapterCount = getDbChapterCount(bookId);

  // Cache hit: serve immediately if chapter count is current
  // (completed books never need regeneration once cached at full count)
  if (cached && cached.chapterCount >= dbChapterCount && dbChapterCount > 0) {
    return NextResponse.json({
      status: "ready",
      url: `/api/books/${bookId}/epub`,
    });
  }

  // Need to generate (or re-generate because new chapters exist)
  if (generationLocks.has(bookId)) {
    return NextResponse.json(
      {
        status: "error",
        message: "EPUB generation already in progress for this book",
      },
      { status: 409 },
    );
  }

  generationLocks.add(bookId);
  try {
    const convertScript = path.join(EPUB_CONVERTER_DIR, "convert.py");
    if (!fs.existsSync(convertScript)) {
      return NextResponse.json(
        { status: "error", message: "epub-converter not found" },
        { status: 500 },
      );
    }

    execSync(`python3 "${convertScript}" --ids ${bookId} --force`, {
      cwd: EPUB_CONVERTER_DIR,
      stdio: "pipe",
      timeout: 120000,
    });

    const newCached = findCachedEpub(bookId);
    if (newCached) {
      return NextResponse.json({
        status: "ready",
        url: `/api/books/${bookId}/epub`,
      });
    } else {
      return NextResponse.json(
        {
          status: "error",
          message: "EPUB generation completed but file not found",
        },
        { status: 500 },
      );
    }
  } catch (err) {
    const message =
      err instanceof Error ? err.message.slice(0, 200) : "Unknown error";
    return NextResponse.json({ status: "error", message }, { status: 500 });
  } finally {
    generationLocks.delete(bookId);
  }
}
