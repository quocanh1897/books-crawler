"use client";

import { useState, useRef } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { cn, formatNumber } from "@/lib/utils";
import { BookCover } from "@/components/books/BookCover";
import type { BookSource } from "@/components/layout/SourceContext";
import type { BookWithAuthor, RankingMetric } from "@/types";

const MTC_COLUMNS: {
  id: RankingMetric;
  title: string;
  getValue: (b: BookWithAuthor) => number;
}[] = [
  { id: "bookmark_count", title: "TOP YÊU THÍCH", getValue: (b) => b.bookmarkCount },
  { id: "vote_count", title: "TOP ĐỀ CỬ", getValue: (b) => b.voteCount },
  { id: "comment_count", title: "TOP BÌNH LUẬN", getValue: (b) => b.commentCount },
];

const TTV_COLUMNS: typeof MTC_COLUMNS = [
  { id: "bookmark_count", title: "TOP YÊU THÍCH", getValue: (b) => b.bookmarkCount },
  { id: "vote_count", title: "TOP ĐỀ CỬ", getValue: (b) => b.voteCount },
  { id: "view_count", title: "TOP LƯỢT XEM", getValue: (b) => b.viewCount },
];

function isVietnameseAuthor(book: BookWithAuthor): boolean {
  return book.author != null && String(book.author.id).startsWith("999");
}

function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(0)}K`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return formatNumber(n);
}

const RANK_STYLES: Record<number, string> = {
  0: "bg-gradient-to-r from-amber-100 to-yellow-50 border-l-4 border-l-amber-400",
  1: "bg-gradient-to-r from-gray-100 to-slate-50 border-l-4 border-l-gray-400",
  2: "bg-gradient-to-r from-orange-50 to-amber-50 border-l-4 border-l-orange-400",
};

const RANK_BADGE: Record<number, string> = {
  0: "bg-gradient-to-br from-amber-400 to-yellow-500 text-white shadow-sm",
  1: "bg-gradient-to-br from-gray-300 to-slate-400 text-white shadow-sm",
  2: "bg-gradient-to-br from-orange-400 to-amber-600 text-white shadow-sm",
};

function BookPopup({ book, x, y }: { book: BookWithAuthor; x: number; y: number }) {
  return (
    <div
      className="fixed z-50 pointer-events-none"
      style={{ left: x + 12, top: y - 40 }}
    >
      <div className="bg-white rounded-lg shadow-xl border border-[var(--color-border)] p-3 w-64 flex gap-3">
        <div className="shrink-0">
          <BookCover bookId={book.id} name={book.name} size="xs" />
        </div>
        <div className="flex-1 min-w-0">
          <h4 className="text-sm font-semibold text-[var(--color-text)] line-clamp-2 leading-snug">
            {book.name}
          </h4>
          {book.author && (
            <p className="text-xs text-[var(--color-text-secondary)] mt-0.5 truncate">
              {book.author.name}
            </p>
          )}
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1.5 text-[10px] text-[var(--color-text-secondary)]">
            {(book.reviewScore ?? 0) > 0 && (
              <span className="flex items-center gap-0.5">
                <svg className="w-3 h-3 text-yellow-400" fill="currentColor" viewBox="0 0 20 20">
                  <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                </svg>
                {(book.reviewScore ?? 0).toFixed(1)}
              </span>
            )}
            <span>{formatCompact(book.voteCount)} đề cử</span>
            <span>{formatCompact(book.bookmarkCount)} yêu thích</span>
            <span>{formatCompact(book.commentCount)} bình luận</span>
            <span>{formatNumber(book.chapterCount)} ch</span>
          </div>
        </div>
      </div>
    </div>
  );
}

interface RankingGridProps {
  data: Partial<Record<RankingMetric, BookWithAuthor[]>>;
  source: BookSource;
  genreSlug?: string;
}

export function RankingGrid({ data, source, genreSlug }: RankingGridProps) {
  const router = useRouter();
  const [includeViet, setIncludeViet] = useState(false);
  const [hovered, setHovered] = useState<{ book: BookWithAuthor; x: number; y: number } | null>(null);
  const hoverTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const DISPLAY_LIMIT = 10;

  const COLUMNS = source === "ttv" ? TTV_COLUMNS : MTC_COLUMNS;

  function filterBooks(metricId: RankingMetric) {
    const books = data[metricId] || [];
    const filtered = includeViet ? books : books.filter((b) => !isVietnameseAuthor(b));
    return filtered.slice(0, DISPLAY_LIMIT);
  }

  function handleMouseEnter(book: BookWithAuthor, e: React.MouseEvent) {
    if (hoverTimeout.current) clearTimeout(hoverTimeout.current);
    hoverTimeout.current = setTimeout(() => {
      setHovered({ book, x: e.clientX, y: e.clientY });
    }, 200);
  }

  function handleMouseMove(e: React.MouseEvent) {
    if (hovered) {
      setHovered((prev) => prev ? { ...prev, x: e.clientX, y: e.clientY } : null);
    }
  }

  function handleMouseLeave() {
    if (hoverTimeout.current) clearTimeout(hoverTimeout.current);
    setHovered(null);
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-bold text-[var(--color-text)] flex items-center gap-2">
          <svg className="w-6 h-6 text-orange-500" fill="currentColor" viewBox="0 0 20 20">
            <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
          </svg>
          Bảng Xếp Hạng
        </h2>
        <label className="flex items-center gap-1.5 cursor-pointer select-none">
          <span className={cn("text-xs font-medium transition-colors", includeViet ? "text-[var(--color-accent)]" : "text-[var(--color-text-secondary)]")}>
            Truyện Việt
          </span>
          <button
            role="switch"
            aria-checked={includeViet}
            onClick={() => setIncludeViet((v) => !v)}
            className={cn(
              "relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors duration-200",
              includeViet ? "bg-[var(--color-accent)]" : "bg-gray-300"
            )}
          >
            <span
              className={cn(
                "pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200",
                includeViet ? "translate-x-4" : "translate-x-0"
              )}
            />
          </button>
        </label>
      </div>

      {/* 3-column grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {COLUMNS.map((col) => {
          const books = filterBooks(col.id);
          return (
            <div
              key={col.id}
              className="bg-white rounded-lg border border-[var(--color-border)] overflow-hidden"
            >
              {/* Column header */}
              <div className="flex items-center justify-between px-3 py-2.5 border-b border-[var(--color-border)]">
                <h3 className="text-xs font-bold text-[var(--color-text)] tracking-wide uppercase">
                  {col.title}
                </h3>
                <Link
                  href={`/bang-xep-hang?metric=${col.id}${genreSlug ? `&genre=${genreSlug}` : ""}${includeViet ? "&viet=1" : ""}`}
                  className="text-[10px] text-[var(--color-primary)] hover:underline whitespace-nowrap"
                >
                  Xem thêm
                </Link>
              </div>

              {/* List */}
              <div>
                {books.length === 0 ? (
                  <p className="text-xs text-[var(--color-text-secondary)] py-6 text-center">
                    Chưa có dữ liệu.
                  </p>
                ) : (
                  books.map((book, i) => {
                    const isTop3 = i < 3;
                    return (
                      <div
                        key={book.id}
                        role="link"
                        tabIndex={0}
                        onClick={() => router.push(`/doc-truyen/${book.slug}`)}
                        onKeyDown={(e) => { if (e.key === "Enter") router.push(`/doc-truyen/${book.slug}`); }}
                        onMouseEnter={(e) => handleMouseEnter(book, e)}
                        onMouseMove={handleMouseMove}
                        onMouseLeave={handleMouseLeave}
                        className={cn(
                          "flex items-center gap-2 px-3 cursor-pointer transition-all duration-200 group",
                          isTop3
                            ? cn("py-2", RANK_STYLES[i])
                            : "py-1.5 border-b border-[var(--color-border)] last:border-b-0 hover:bg-gray-50"
                        )}
                      >
                        {/* Rank badge */}
                        <span
                          className={cn(
                            "w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0",
                            isTop3
                              ? RANK_BADGE[i]
                              : "text-[var(--color-text-secondary)]"
                          )}
                        >
                          {i + 1}
                        </span>

                        {/* Cover for top 3 */}
                        {isTop3 && (
                          <BookCover bookId={book.id} name={book.name} size="xs" />
                        )}

                        {/* Title + stat */}
                        <div className="flex-1 min-w-0">
                          <span className={cn(
                            "text-xs text-[var(--color-text)] truncate block group-hover:text-[var(--color-primary)] transition-colors",
                            isTop3 && "font-medium"
                          )}>
                            {book.name}
                          </span>
                          {isTop3 && book.author && (
                            <span className="text-[10px] text-[var(--color-text-secondary)] truncate block">
                              {book.author.name}
                            </span>
                          )}
                        </div>

                        <span className={cn(
                          "shrink-0 tabular-nums",
                          isTop3
                            ? "text-xs font-semibold text-[var(--color-primary)]"
                            : "text-[10px] text-[var(--color-text-secondary)]"
                        )}>
                          {formatCompact(col.getValue(book))}
                        </span>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Hover popup */}
      {hovered && <BookPopup book={hovered.book} x={hovered.x} y={hovered.y} />}
    </div>
  );
}
