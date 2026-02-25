import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";

const EPUB_CACHE_DIR = path.resolve(
  process.env.EPUB_CACHE_DIR || path.join(process.cwd(), "data/epub"),
);

/**
 * Find a cached EPUB for a book.  Cache filenames follow the pattern
 * `{book_id}_{chapter_count}.epub`.
 */
function findCachedEpub(
  bookId: number,
): { fullPath: string; filename: string } | null {
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
      return {
        fullPath: path.join(EPUB_CACHE_DIR, file),
        filename: file,
      };
    }
  }

  return null;
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

  const cached = findCachedEpub(bookId);
  if (!cached) {
    return NextResponse.json({ error: "EPUB not found" }, { status: 404 });
  }

  const buffer = fs.readFileSync(cached.fullPath);

  return new NextResponse(buffer, {
    headers: {
      "Content-Type": "application/epub+zip",
      "Content-Disposition": `attachment; filename="${encodeURIComponent(cached.filename)}"`,
      "Content-Length": String(buffer.length),
    },
  });
}
