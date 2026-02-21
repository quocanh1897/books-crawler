import { NextResponse } from "next/server";
import { getBookBySlug, getChapter } from "@/lib/queries";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string; indexNum: string }> }
) {
  const { slug, indexNum: indexNumStr } = await params;
  const indexNum = parseInt(indexNumStr, 10);

  if (isNaN(indexNum) || indexNum < 1) {
    return NextResponse.json({ error: "Invalid chapter index" }, { status: 400 });
  }

  const book = await getBookBySlug(slug);
  if (!book) {
    return NextResponse.json({ error: "Book not found" }, { status: 404 });
  }

  const chapter = await getChapter(book.id, indexNum);
  if (!chapter) {
    return NextResponse.json({ error: "Chapter not found" }, { status: 404 });
  }

  return NextResponse.json({
    bookId: book.id,
    bookSlug: book.slug,
    indexNum: chapter.indexNum,
    title: chapter.title,
    body: chapter.body,
    wordCount: chapter.wordCount,
  });
}
