import { NextRequest, NextResponse } from "next/server";
import { getBookById } from "@/lib/queries";
import fs from "fs";
import path from "path";

const EPUB_OUTPUT_DIR =
  process.env.EPUB_OUTPUT_DIR || path.resolve(process.cwd(), "../epub-converter/epub-output");

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
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

  const dir = path.join(EPUB_OUTPUT_DIR, String(bookId));
  let epubExists = false;
  let epubFilename = "";
  let epubSizeBytes = 0;

  if (fs.existsSync(dir)) {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".epub"));
    if (files.length > 0) {
      epubExists = true;
      epubFilename = files[0];
      const stat = fs.statSync(path.join(dir, files[0]));
      epubSizeBytes = stat.size;
    }
  }

  return NextResponse.json({
    epub_exists: epubExists,
    epub_filename: epubFilename,
    epub_size_bytes: epubSizeBytes,
    book_status: book.status,
    needs_regeneration: epubExists && book.status !== 2,
  });
}
