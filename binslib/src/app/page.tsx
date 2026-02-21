import { getRankedBooks, getBooks, getBookPrimaryGenres } from "@/lib/queries";
import { getSource } from "@/lib/source";
import { RankingGrid } from "@/components/rankings/RankingGrid";
import { Sidebar } from "@/components/layout/Sidebar";
import { BookCard } from "@/components/books/BookCard";
import { StatusBadge } from "@/components/ui/Badge";
import { QuickDownloadButton } from "@/components/books/QuickDownloadButton";
import { formatNumber, timeAgo } from "@/lib/utils";
import type { RankingMetric } from "@/types";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const source = await getSource();

  const rankingMetrics: RankingMetric[] =
    source === "ttv"
      ? ["bookmark_count", "vote_count", "view_count"]
      : ["bookmark_count", "vote_count", "comment_count"];

  const [
    metric1Ranked,
    metric2Ranked,
    metric3Ranked,
    recentlyUpdated,
    completedBooks,
  ] = await Promise.all([
    getRankedBooks(rankingMetrics[0], 30, undefined, undefined, true, source),
    getRankedBooks(rankingMetrics[1], 30, undefined, undefined, true, source),
    getRankedBooks(rankingMetrics[2], 30, undefined, undefined, true, source),
    getBooks({ sort: "updated_at", order: "desc", limit: 15, source }),
    getBooks({ sort: "bookmark_count", order: "desc", status: 2, limit: 8, source }),
  ]);

  const rankingData: Partial<Record<RankingMetric, typeof metric1Ranked>> = {
    [rankingMetrics[0]]: metric1Ranked,
    [rankingMetrics[1]]: metric2Ranked,
    [rankingMetrics[2]]: metric3Ranked,
  };

  const recentBookIds = recentlyUpdated.data.map((b) => b.id);
  const genreMap = getBookPrimaryGenres(recentBookIds);

  return (
    <div className="max-w-7xl mx-auto px-4 py-6">
      {/* Ranking Grid — full width */}
      <RankingGrid data={rankingData} source={source} />

      <div className="flex gap-6 mt-6">
        {/* Main Content */}
        <div className="flex-1 min-w-0 space-y-6">
          {/* Recently Updated */}
          <div className="bg-white rounded-lg border border-[var(--color-border)]">
            <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)]">
              <h2 className="font-bold text-sm">Mới cập nhật</h2>
              <Link
                href="/tong-hop?sort=updated_at"
                className="text-xs text-[var(--color-primary)] hover:underline"
              >
                Xem thêm &raquo;
              </Link>
            </div>
            <div className="divide-y divide-[var(--color-border)]">
              {recentlyUpdated.data.map((book) => {
                const genre = genreMap[book.id];
                return (
                  <div
                    key={book.id}
                    className="flex items-center gap-3 px-4 py-2 hover:bg-gray-50 transition-colors text-sm"
                  >
                    {genre ? (
                      <span className="shrink-0 text-xs text-[var(--color-primary)] w-20 truncate">
                        {genre.name}
                      </span>
                    ) : (
                      <StatusBadge status={book.status} />
                    )}
                    <Link
                      href={`/doc-truyen/${book.slug}`}
                      className="flex-1 min-w-0 font-medium text-[var(--color-text)] truncate hover:text-[var(--color-primary)] transition-colors"
                    >
                      {book.name}
                    </Link>
                    <span className="shrink-0 text-xs text-[var(--color-text-secondary)]">
                      {formatNumber(book.chapterCount)} ch
                    </span>
                    <span className="shrink-0 text-xs text-[var(--color-text-secondary)] w-16 text-right" title="Đề cử">
                      {formatNumber(book.voteCount)} đề cử
                    </span>
                    <QuickDownloadButton bookId={book.id} />
                    <span className="shrink-0 text-xs text-[var(--color-text-secondary)] w-24 text-right">
                      {timeAgo(book.updatedAt)}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Completed Books */}
          <div className="bg-white rounded-lg border border-[var(--color-border)]">
            <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)]">
              <h2 className="font-bold text-sm">Truyện đã hoàn thành</h2>
              <Link
                href="/tong-hop?status=2"
                className="text-xs text-[var(--color-primary)] hover:underline"
              >
                Xem thêm &raquo;
              </Link>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 p-4">
              {completedBooks.data.map((book) => (
                <BookCard key={book.id} book={book} />
              ))}
            </div>
          </div>
        </div>

        {/* Sidebar */}
        <div className="hidden lg:block w-72 shrink-0">
          <Sidebar />
        </div>
      </div>
    </div>
  );
}
