import { NextResponse } from "next/server";
import { getBookBySlug } from "@/lib/queries";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;

  const book = await getBookBySlug(slug);
  if (!book) {
    return NextResponse.json({ error: "Book not found" }, { status: 404 });
  }

  return NextResponse.json({
    id: book.id,
    name: book.name,
    slug: book.slug,
    synopsis: book.synopsis,
    status: book.status,
    statusName: book.statusName,
    viewCount: book.viewCount,
    commentCount: book.commentCount,
    bookmarkCount: book.bookmarkCount,
    voteCount: book.voteCount,
    reviewScore: book.reviewScore,
    reviewCount: book.reviewCount,
    chapterCount: book.chapterCount,
    wordCount: book.wordCount,
    coverUrl: book.coverUrl,
    createdAt: book.createdAt,
    updatedAt: book.updatedAt,
    chaptersSaved: book.chaptersSaved,
    source: book.source,
    author: book.author
      ? { id: book.author.id, name: book.author.name, localName: book.author.localName }
      : null,
    genres: book.genres.map((g) => ({ id: g.id, name: g.name, slug: g.slug })),
    tags: book.tags.map((t) => ({ id: t.id, name: t.name })),
  });
}
