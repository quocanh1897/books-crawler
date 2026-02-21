import { notFound } from "next/navigation";
import { getBookBySlug, getChapter } from "@/lib/queries";
import { ChapterReader } from "@/components/chapters/ChapterReader";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ slug: string; chapter: string }>;
}

export default async function ChapterReaderPage({ params }: Props) {
  const { slug, chapter: chapterSegment } = await params;

  const match = chapterSegment.match(/^chuong-(\d+)$/);
  if (!match) notFound();
  const indexNum = parseInt(match[1], 10);
  if (isNaN(indexNum) || indexNum < 1) notFound();

  const book = await getBookBySlug(slug);
  if (!book) notFound();

  const chapter = await getChapter(book.id, indexNum);
  if (!chapter) notFound();

  return (
    <ChapterReader
      bookId={book.id}
      bookSlug={book.slug}
      bookName={book.name}
      currentIndex={indexNum}
      totalChapters={book.chapterCount}
      chapter={{ title: chapter.title, body: chapter.body }}
    />
  );
}
