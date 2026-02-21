import Link from "next/link";
import { getAuthorsWithBookCounts } from "@/lib/queries";
import type { AuthorSortField } from "@/lib/queries";
import { Pagination } from "@/components/ui/Pagination";
import { Sidebar } from "@/components/layout/Sidebar";
import { getSource } from "@/lib/source";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

const SORT_OPTIONS: { id: AuthorSortField; label: string }[] = [
  { id: "book_count", label: "Số truyện" },
  { id: "word_count", label: "Số chữ" },
];

function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString("vi-VN");
}

interface Props {
  searchParams: Promise<{ page?: string; q?: string; sort?: string }>;
}

export default async function AuthorsListingPage({ searchParams }: Props) {
  const { page: pageStr, q, sort: sortParam } = await searchParams;
  const page = Math.max(1, parseInt(pageStr || "1", 10));
  const sort: AuthorSortField =
    sortParam === "word_count" ? "word_count" : "book_count";
  const source = await getSource();

  const authors = getAuthorsWithBookCounts(page, 60, q || undefined, sort, source);

  function buildUrl(overrides: { sort?: string; page?: number }) {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    const s = overrides.sort ?? sort;
    if (s !== "book_count") params.set("sort", s);
    const p = overrides.page ?? 1;
    if (p > 1) params.set("page", String(p));
    const qs = params.toString();
    return `/tac-gia${qs ? `?${qs}` : ""}`;
  }

  return (
    <div className="max-w-7xl mx-auto px-4 py-6">
      <nav className="text-xs text-[var(--color-text-secondary)] mb-4">
        <Link href="/" className="hover:text-[var(--color-primary)]">
          Trang chủ
        </Link>
        <span className="mx-1">&rsaquo;</span>
        <span className="text-[var(--color-text)]">Tác giả</span>
      </nav>

      <div className="flex gap-6">
        <div className="flex-1 min-w-0">
          <div className="bg-white rounded-lg border border-[var(--color-border)]">
            <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)]">
              <div className="flex items-center gap-4">
                <h1 className="font-bold text-sm">
                  Tất cả tác giả
                  <span className="font-normal text-[var(--color-text-secondary)] ml-2">
                    ({authors.total})
                  </span>
                </h1>
                <div className="flex border border-[var(--color-border)] rounded-md overflow-hidden">
                  {SORT_OPTIONS.map((opt) => (
                    <Link
                      key={opt.id}
                      href={buildUrl({ sort: opt.id })}
                      className={cn(
                        "px-3 py-1 text-xs font-medium transition-colors",
                        sort === opt.id
                          ? "bg-[var(--color-primary)] text-white"
                          : "text-[var(--color-text-secondary)] hover:bg-gray-50"
                      )}
                    >
                      {opt.label}
                    </Link>
                  ))}
                </div>
              </div>
              <form method="GET" className="flex items-center gap-2">
                {sort !== "book_count" && (
                  <input type="hidden" name="sort" value={sort} />
                )}
                <input
                  type="text"
                  name="q"
                  defaultValue={q || ""}
                  placeholder="Tìm tác giả..."
                  className="px-3 py-1.5 text-sm border border-[var(--color-border)] rounded-md focus:outline-none focus:ring-1 focus:ring-[var(--color-primary)] w-48"
                />
                <button
                  type="submit"
                  className="px-3 py-1.5 text-sm bg-[var(--color-primary)] text-white rounded-md hover:opacity-90 transition-opacity"
                >
                  Tìm
                </button>
              </form>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 p-4">
              {authors.data.map((author) => (
                <Link
                  key={author.id}
                  href={`/tac-gia/${author.id}`}
                  className="flex items-center gap-3 p-3 rounded-lg border border-[var(--color-border)] hover:border-[var(--color-primary)] card-hover"
                >
                  <div className="w-11 h-11 rounded-full bg-[var(--color-primary)] flex items-center justify-center text-white font-bold text-lg shrink-0">
                    {author.name.charAt(0).toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-[var(--color-text)] truncate">
                      {author.name}
                    </p>
                    {author.localName && (
                      <p className="text-xs text-[var(--color-text-secondary)] truncate">
                        {author.localName}
                      </p>
                    )}
                    <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
                      {author.bookCount} truyện
                      <span className="mx-1">&middot;</span>
                      {formatCompact(author.totalWordCount)} chữ
                    </p>
                  </div>
                </Link>
              ))}
            </div>

            {authors.data.length === 0 && (
              <div className="px-4 py-8 text-center text-sm text-[var(--color-text-secondary)]">
                Không tìm thấy tác giả nào.
              </div>
            )}

            {authors.totalPages > 1 && (
              <div className="px-4 py-3">
                <Pagination
                  currentPage={page}
                  totalPages={authors.totalPages}
                  baseUrl="/tac-gia"
                  searchParams={{
                    ...(q ? { q } : {}),
                    ...(sort !== "book_count" ? { sort } : {}),
                  }}
                />
              </div>
            )}
          </div>
        </div>

        <div className="hidden lg:block w-72 shrink-0">
          <Sidebar />
        </div>
      </div>
    </div>
  );
}
