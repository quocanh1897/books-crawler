import Link from "next/link";
import { searchBooks, searchAuthors } from "@/lib/queries";
import { getSource } from "@/lib/source";
import { BookCover } from "@/components/books/BookCover";
import { formatNumber } from "@/lib/utils";

export const dynamic = "force-dynamic";

interface Props {
  searchParams: Promise<{ q?: string; tab?: string }>;
}

export default async function SearchPage({ searchParams }: Props) {
  const { q = "", tab = "books" } = await searchParams;
  const source = await getSource();

  if (q.length < 2) {
    return (
      <div className="max-w-7xl mx-auto px-4 py-12 text-center">
        <p className="text-[var(--color-text-secondary)]">
          Nhập ít nhất 2 ký tự để tìm kiếm.
        </p>
      </div>
    );
  }

  // Sanitize: strip FTS5 special characters that could break syntax,
  // then wrap each word in double quotes for exact-token matching.
  const ftsQuery = q
    .replace(/[\u201C\u201D\u2018\u2019"'()*^:]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .map((w) => `"${w}"`)
    .join(" ");
  const bookResults =
    tab === "books" ? searchBooks(ftsQuery, 20, 0, source) : [];
  const authorResults = tab === "authors" ? searchAuthors(q, 20) : [];

  return (
    <div className="max-w-7xl mx-auto px-4 py-6">
      <h1 className="text-lg font-bold mb-4">
        Kết quả tìm kiếm:{" "}
        <span className="text-[var(--color-primary)]">&ldquo;{q}&rdquo;</span>
      </h1>

      {/* Tabs */}
      <div className="flex border-b border-[var(--color-border)] mb-4">
        <Link
          href={`/tim-kiem?q=${encodeURIComponent(q)}&tab=books`}
          className={`px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
            tab === "books"
              ? "border-[var(--color-primary)] text-[var(--color-primary)]"
              : "border-transparent text-[var(--color-text-secondary)]"
          }`}
        >
          Truyện
        </Link>
        <Link
          href={`/tim-kiem?q=${encodeURIComponent(q)}&tab=authors`}
          className={`px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
            tab === "authors"
              ? "border-[var(--color-primary)] text-[var(--color-primary)]"
              : "border-transparent text-[var(--color-text-secondary)]"
          }`}
        >
          Tác giả
        </Link>
      </div>

      {/* Book Results */}
      {tab === "books" && (
        <div className="space-y-3">
          {bookResults.length === 0 ? (
            <p className="text-sm text-[var(--color-text-secondary)] py-8 text-center">
              Không tìm thấy truyện nào.
            </p>
          ) : (
            bookResults.map(
              (
                row: Record<string, unknown> & {
                  hl_name: string;
                  hl_synopsis: string;
                },
              ) => (
                <Link
                  key={row.id as number}
                  href={`/doc-truyen/${row.slug as string}`}
                  className="flex gap-3 p-3 bg-white rounded-lg border border-[var(--color-border)] hover:shadow-md transition-shadow"
                >
                  <BookCover
                    bookId={row.id as number}
                    name={row.name as string}
                    size="sm"
                  />
                  <div className="flex-1 min-w-0">
                    <h3
                      className="font-semibold text-sm text-[var(--color-text)]"
                      dangerouslySetInnerHTML={{ __html: row.hl_name }}
                    />
                    <div className="text-xs text-[var(--color-text-secondary)] mt-1">
                      {formatNumber(row.chapter_count as number)} chương
                      &middot; {formatNumber(row.bookmark_count as number)} yêu
                      thích
                    </div>
                    {row.hl_synopsis && (
                      <p
                        className="text-xs text-[var(--color-text-secondary)] mt-1 line-clamp-2"
                        dangerouslySetInnerHTML={{ __html: row.hl_synopsis }}
                      />
                    )}
                  </div>
                </Link>
              ),
            )
          )}
        </div>
      )}

      {/* Author Results */}
      {tab === "authors" && (
        <div className="space-y-3">
          {authorResults.length === 0 ? (
            <p className="text-sm text-[var(--color-text-secondary)] py-8 text-center">
              Không tìm thấy tác giả nào.
            </p>
          ) : (
            authorResults.map((author) => (
              <Link
                key={author.id}
                href={`/tac-gia/${author.id}`}
                className="flex items-center gap-3 p-3 bg-white rounded-lg border border-[var(--color-border)] hover:shadow-md transition-shadow"
              >
                <div className="w-10 h-10 rounded-full bg-[var(--color-primary)] flex items-center justify-center text-white font-bold text-sm shrink-0">
                  {author.name.charAt(0).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-sm text-[var(--color-text)]">
                    {author.name}
                  </p>
                  {author.local_name && (
                    <p className="text-xs text-[var(--color-text-secondary)]">
                      {author.local_name}
                    </p>
                  )}
                </div>
                <span className="text-xs text-[var(--color-text-secondary)] shrink-0">
                  {author.book_count} truyện
                </span>
              </Link>
            ))
          )}
        </div>
      )}
    </div>
  );
}
