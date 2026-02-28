import Link from "next/link";
import { AuthorLink, ClickableRow } from "@/components/rankings/AuthorLink";
import { getRankedBooksPaginated, getGenresWithCounts } from "@/lib/queries";
import { getSource } from "@/lib/source";
import { BookCover } from "@/components/books/BookCover";
import { StatusBadge } from "@/components/ui/Badge";
import { Pagination } from "@/components/ui/Pagination";
import { formatNumber, timeAgo, cn } from "@/lib/utils";
import { METRIC_LABELS, SOURCE_RANKING_TABS } from "@/types";
import type { RankingMetric, BookSourceType } from "@/types";

export const dynamic = "force-dynamic";

const ITEMS_PER_PAGE = 50;

interface Props {
  searchParams: Promise<{
    metric?: string;
    genre?: string;
    status?: string;
    page?: string;
    viet?: string;
  }>;
}

export default async function RankingsPage({ searchParams }: Props) {
  const params = await searchParams;
  const source = await getSource();

  // Source-specific ranking tabs (TF shows different metrics than MTC/TTV)
  const tabs =
    SOURCE_RANKING_TABS[source as BookSourceType] ?? SOURCE_RANKING_TABS.mtc;
  const validMetrics = tabs.map((t) => t.metric);
  const defaultMetric = tabs[0].metric;

  const metric = (
    validMetrics.includes(params.metric as RankingMetric)
      ? params.metric
      : defaultMetric
  ) as RankingMetric;
  const genreSlug = params.genre || undefined;
  const status = params.status ? parseInt(params.status, 10) : undefined;
  const page = Math.max(1, parseInt(params.page || "1", 10));
  const vietnameseOnly = params.viet === "1";

  const [result, genres] = await Promise.all([
    getRankedBooksPaginated(
      metric,
      page,
      ITEMS_PER_PAGE,
      genreSlug,
      status,
      vietnameseOnly,
      source,
    ),
    getGenresWithCounts(source),
  ]);

  const books = result.data;

  function buildUrl(overrides: Record<string, string | undefined>) {
    const p = new URLSearchParams();
    const merged = {
      metric,
      genre: genreSlug,
      status: status?.toString(),
      viet: vietnameseOnly ? "1" : undefined,
      ...overrides,
    };
    for (const [k, v] of Object.entries(merged)) {
      if (v) p.set(k, v);
    }
    return `/bang-xep-hang?${p.toString()}`;
  }

  const rankOffset = (page - 1) * ITEMS_PER_PAGE;

  return (
    <div className="max-w-7xl mx-auto px-4 py-6">
      <h1 className="text-lg font-bold mb-4">Bảng xếp hạng</h1>

      {/* Filters */}
      <div className="bg-white rounded-lg border border-[var(--color-border)] p-4 mb-4 space-y-3">
        {/* Metric */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-[var(--color-text-secondary)] w-16">
            Xếp hạng:
          </span>
          {tabs.map((tab) => (
            <Link
              key={tab.metric}
              href={buildUrl({ metric: tab.metric })}
              className={cn(
                "px-3 py-1 text-xs rounded-full border transition-colors",
                metric === tab.metric
                  ? "bg-[var(--color-primary)] text-white border-[var(--color-primary)]"
                  : "border-[var(--color-border)] text-[var(--color-text-secondary)] hover:border-[var(--color-primary)]",
              )}
            >
              {tab.label}
            </Link>
          ))}
        </div>

        {/* Genre */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-[var(--color-text-secondary)] w-16">
            Thể loại:
          </span>
          <Link
            href={buildUrl({ genre: undefined })}
            className={cn(
              "px-3 py-1 text-xs rounded-full border transition-colors",
              !genreSlug
                ? "bg-[var(--color-primary)] text-white border-[var(--color-primary)]"
                : "border-[var(--color-border)] text-[var(--color-text-secondary)] hover:border-[var(--color-primary)]",
            )}
          >
            Tất cả
          </Link>
          {genres.map((g) => (
            <Link
              key={g.id}
              href={buildUrl({ genre: g.slug })}
              className={cn(
                "px-3 py-1 text-xs rounded-full border transition-colors",
                genreSlug === g.slug
                  ? "bg-[var(--color-primary)] text-white border-[var(--color-primary)]"
                  : "border-[var(--color-border)] text-[var(--color-text-secondary)] hover:border-[var(--color-primary)]",
              )}
            >
              {g.name}
            </Link>
          ))}
        </div>

        {/* Status */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-[var(--color-text-secondary)] w-16">
            Trạng thái:
          </span>
          {[
            { v: undefined, l: "Tất cả" },
            { v: "1", l: "Đang ra" },
            { v: "2", l: "Hoàn thành" },
            { v: "3", l: "Tạm dừng" },
          ].map(({ v, l }) => (
            <Link
              key={l}
              href={buildUrl({ status: v })}
              className={cn(
                "px-3 py-1 text-xs rounded-full border transition-colors",
                (v === undefined ? !status : String(status) === v)
                  ? "bg-[var(--color-primary)] text-white border-[var(--color-primary)]"
                  : "border-[var(--color-border)] text-[var(--color-text-secondary)] hover:border-[var(--color-primary)]",
              )}
            >
              {l}
            </Link>
          ))}
          <span className="mx-2 w-px h-5 bg-[var(--color-border)]" />
          <Link
            href={buildUrl({ viet: vietnameseOnly ? undefined : "1" })}
            className="flex items-center gap-1.5"
          >
            <span
              className={cn(
                "text-xs font-medium transition-colors",
                vietnameseOnly
                  ? "text-[var(--color-accent)]"
                  : "text-[var(--color-text-secondary)]",
              )}
            >
              Truyện Việt
            </span>
            <span
              className={cn(
                "relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors duration-200",
                vietnameseOnly ? "bg-[var(--color-accent)]" : "bg-gray-300",
              )}
            >
              <span
                className={cn(
                  "inline-block h-4 w-4 mt-0.5 rounded-full bg-white shadow-sm transition-transform duration-200",
                  vietnameseOnly
                    ? "translate-x-4 ml-0.5"
                    : "translate-x-0 ml-0.5",
                )}
              />
            </span>
          </Link>
        </div>
      </div>

      {/* Results Table */}
      <div className="bg-white rounded-lg border border-[var(--color-border)] overflow-hidden">
        <div className="px-4 py-3 border-b border-[var(--color-border)] flex items-center justify-between">
          <span className="text-sm text-[var(--color-text-secondary)]">
            {result.total} truyện
          </span>
          <span className="text-xs text-[var(--color-text-secondary)]">
            Trang {page}/{result.totalPages}
          </span>
        </div>
        <div className="divide-y divide-[var(--color-border)]">
          {books.length === 0 ? (
            <p className="text-sm text-[var(--color-text-secondary)] py-12 text-center">
              Không có truyện nào.
            </p>
          ) : (
            books.map((book, i) => (
              <ClickableRow
                key={book.id}
                href={`/doc-truyen/${book.slug}`}
                className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50 cursor-pointer transition-all duration-200 hover:translate-x-1"
              >
                <span
                  className={cn(
                    "w-7 h-7 rounded flex items-center justify-center text-xs font-bold shrink-0",
                    rankOffset + i < 3
                      ? "bg-[var(--color-accent)] text-white"
                      : "bg-gray-100 text-[var(--color-text-secondary)]",
                  )}
                >
                  {rankOffset + i + 1}
                </span>
                <BookCover bookId={book.id} name={book.name} size="sm" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-[var(--color-text)] line-clamp-1">
                    {book.name}
                  </p>
                  <p className="text-xs text-[var(--color-text-secondary)]">
                    {book.author && (
                      <AuthorLink
                        href={`/tac-gia/${book.author.id}`}
                        className="hover:text-[var(--color-primary)] transition-colors"
                      >
                        {book.author.name}
                      </AuthorLink>
                    )}
                    {book.author && <> &middot; </>}
                    {formatNumber(book.chapterCount)} ch
                  </p>
                </div>
                <div className="hidden sm:block">
                  <StatusBadge status={book.status} />
                </div>
                <div className="shrink-0 text-right min-w-[80px]">
                  <span className="text-sm font-bold text-[var(--color-primary)]">
                    {formatNumber(
                      metric === "vote_count"
                        ? book.voteCount
                        : metric === "view_count"
                          ? book.viewCount
                          : metric === "comment_count"
                            ? book.commentCount
                            : metric === "review_score"
                              ? (book.reviewScore ?? 0)
                              : book.bookmarkCount,
                    )}
                  </span>
                  <div className="text-[10px] text-[var(--color-text-secondary)]">
                    {METRIC_LABELS[metric]}
                  </div>
                </div>
              </ClickableRow>
            ))
          )}
        </div>
      </div>

      {result.totalPages > 1 && (
        <div className="mt-4">
          <Pagination
            currentPage={page}
            totalPages={result.totalPages}
            baseUrl="/bang-xep-hang"
            searchParams={{
              metric,
              ...(genreSlug ? { genre: genreSlug } : {}),
              ...(status ? { status: String(status) } : {}),
              ...(vietnameseOnly ? { viet: "1" } : {}),
            }}
          />
        </div>
      )}
    </div>
  );
}
