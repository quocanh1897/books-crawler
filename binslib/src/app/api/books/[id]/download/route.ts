import { NextRequest, NextResponse } from "next/server";
import { getBookById } from "@/lib/queries";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";

const EPUB_OUTPUT_DIR =
  process.env.EPUB_OUTPUT_DIR || path.resolve(process.cwd(), "../epub-converter/epub-output");
const EPUB_CONVERTER_DIR =
  process.env.EPUB_CONVERTER_DIR || path.resolve(process.cwd(), "../epub-converter");

const generationLocks = new Set<number>();

function findEpub(bookId: number): string | null {
  const dir = path.join(EPUB_OUTPUT_DIR, String(bookId));
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".epub"));
  return files.length > 0 ? path.join(dir, files[0]) : null;
}

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: idStr } = await params;
  const bookId = parseInt(idStr, 10);
  if (isNaN(bookId)) {
    return NextResponse.json({ status: "error", message: "Invalid book ID" }, { status: 400 });
  }

  const book = await getBookById(bookId);
  if (!book) {
    return NextResponse.json({ status: "error", message: "Book not found" }, { status: 404 });
  }

  const existingEpub = findEpub(bookId);
  const isCompleted = book.status === 2;

  // If epub exists and book is completed, serve immediately
  if (existingEpub && isCompleted) {
    return NextResponse.json({
      status: "ready",
      url: `/api/books/${bookId}/epub`,
    });
  }

  // Need to generate (or re-generate)
  if (generationLocks.has(bookId)) {
    return NextResponse.json({
      status: "error",
      message: "EPUB generation already in progress for this book",
    }, { status: 409 });
  }

  generationLocks.add(bookId);
  try {
    const convertScript = path.join(EPUB_CONVERTER_DIR, "convert.py");
    if (!fs.existsSync(convertScript)) {
      return NextResponse.json({
        status: "error",
        message: "epub-converter not found",
      }, { status: 500 });
    }

    execSync(
      `python3 "${convertScript}" --ids ${bookId} --force --no-audit`,
      {
        cwd: EPUB_CONVERTER_DIR,
        stdio: "pipe",
        timeout: 120000,
      }
    );

    const newEpub = findEpub(bookId);
    if (newEpub) {
      return NextResponse.json({
        status: "ready",
        url: `/api/books/${bookId}/epub`,
      });
    } else {
      return NextResponse.json({
        status: "error",
        message: "EPUB generation completed but file not found",
      }, { status: 500 });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message.slice(0, 200) : "Unknown error";
    return NextResponse.json({ status: "error", message }, { status: 500 });
  } finally {
    generationLocks.delete(bookId);
  }
}
