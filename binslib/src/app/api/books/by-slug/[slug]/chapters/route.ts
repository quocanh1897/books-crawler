import { NextResponse } from "next/server";
import { getBookBySlug, getAllChapterTitles } from "@/lib/queries";
import { logApi } from "@/lib/api-logger";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const t0 = performance.now();
  const { slug } = await params;

  const book = await getBookBySlug(slug);
  if (!book) {
    logApi(_request, 404, performance.now() - t0, { slug });
    return NextResponse.json({ error: "Book not found" }, { status: 404 });
  }

  const chapters = getAllChapterTitles(book.id);
  logApi(_request, 200, performance.now() - t0, {
    slug,
    bookId: book.id,
    chapters: chapters.length,
  });
  return NextResponse.json({ bookId: book.id, slug: book.slug, chapters });
}
