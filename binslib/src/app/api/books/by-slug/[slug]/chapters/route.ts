import { NextResponse } from "next/server";
import { getBookBySlug, getAllChapterTitles } from "@/lib/queries";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;

  const book = await getBookBySlug(slug);
  if (!book) {
    return NextResponse.json({ error: "Book not found" }, { status: 404 });
  }

  const chapters = getAllChapterTitles(book.id);
  return NextResponse.json({ bookId: book.id, slug: book.slug, chapters });
}
