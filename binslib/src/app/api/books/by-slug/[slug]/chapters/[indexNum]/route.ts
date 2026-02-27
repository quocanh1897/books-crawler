import { NextResponse } from "next/server";
import { getBookBySlug, getChapter } from "@/lib/queries";
import { logApi } from "@/lib/api-logger";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string; indexNum: string }> },
) {
  const t0 = performance.now();
  const { slug, indexNum: indexNumStr } = await params;
  const indexNum = parseInt(indexNumStr, 10);

  if (isNaN(indexNum) || indexNum < 1) {
    logApi(_request, 400, performance.now() - t0, {
      slug,
      indexNum: indexNumStr,
    });
    return NextResponse.json(
      { error: "Invalid chapter index" },
      { status: 400 },
    );
  }

  const book = await getBookBySlug(slug);
  if (!book) {
    logApi(_request, 404, performance.now() - t0, { slug, indexNum });
    return NextResponse.json({ error: "Book not found" }, { status: 404 });
  }

  const chapter = await getChapter(book.id, indexNum);
  if (!chapter) {
    logApi(_request, 404, performance.now() - t0, {
      slug,
      indexNum,
      bookId: book.id,
    });
    return NextResponse.json({ error: "Chapter not found" }, { status: 404 });
  }

  logApi(_request, 200, performance.now() - t0, {
    slug,
    indexNum,
    bookId: book.id,
    title: chapter.title,
  });

  return NextResponse.json({
    bookId: book.id,
    bookSlug: book.slug,
    indexNum: chapter.indexNum,
    title: chapter.title,
    body: chapter.body,
    wordCount: chapter.wordCount,
  });
}
