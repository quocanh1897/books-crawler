import { notFound } from "next/navigation";
import { getRankedBooks, getGenresWithCounts, getBooks } from "@/lib/queries";
import { getSource } from "@/lib/source";
import { RankingTabs } from "@/components/rankings/RankingTabs";
import { BookCard } from "@/components/books/BookCard";
import { Sidebar } from "@/components/layout/Sidebar";
import type { RankingMetric } from "@/types";
import Link from "next/link";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ slug: string }>;
}

export default async function GenrePage({ params }: Props) {
  const { slug } = await params;
  const source = await getSource();

  const allGenres = await getGenresWithCounts(source);
  const genre = allGenres.find((g) => g.slug === slug);
  if (!genre) notFound();

  const [
    voteRanked, bookmarkRanked, commentRanked, reviewRanked,
    recentBooks, completedBooks,
  ] = await Promise.all([
    getRankedBooks("vote_count", 30, slug, undefined, true, source),
    getRankedBooks("bookmark_count", 30, slug, undefined, true, source),
    getRankedBooks("comment_count", 30, slug, undefined, true, source),
    getRankedBooks("review_score", 30, slug, undefined, true, source),
    getBooks({ sort: "updated_at", order: "desc", genre: slug, limit: 10, source }),
    getBooks({ sort: "bookmark_count", order: "desc", genre: slug, status: 2, limit: 6, source }),
  ]);

  const rankingData: Partial<Record<RankingMetric, typeof voteRanked>> = {
    vote_count: voteRanked,
    bookmark_count: bookmarkRanked,
    comment_count: commentRanked,
    review_score: reviewRanked,
  };

  return (
    <div className="max-w-7xl mx-auto px-4 py-6">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-xl font-bold text-[var(--color-text)]">
          {genre.name}
          <span className="ml-2 text-sm font-normal text-[var(--color-text-secondary)]">
            ({genre.bookCount} truyện)
          </span>
        </h1>
      </div>

      <div className="flex gap-6">
        <div className="flex-1 min-w-0 space-y-6">
          {/* Ranking Tabs */}
          <RankingTabs data={rankingData} source={source} genreSlug={slug} />

          {/* Recently Updated in Genre */}
          <div className="bg-white rounded-lg border border-[var(--color-border)]">
            <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)]">
              <h2 className="font-bold text-sm">Mới cập nhật</h2>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 p-4">
              {recentBooks.data.map((book) => (
                <BookCard key={book.id} book={book} />
              ))}
            </div>
          </div>

          {/* Completed in Genre */}
          {completedBooks.data.length > 0 && (
            <div className="bg-white rounded-lg border border-[var(--color-border)]">
              <div className="px-4 py-3 border-b border-[var(--color-border)]">
                <h2 className="font-bold text-sm">Truyện đã hoàn thành</h2>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 p-4">
                {completedBooks.data.map((book) => (
                  <BookCard key={book.id} book={book} />
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="hidden lg:block w-72 shrink-0">
          <Sidebar />
        </div>
      </div>
    </div>
  );
}
