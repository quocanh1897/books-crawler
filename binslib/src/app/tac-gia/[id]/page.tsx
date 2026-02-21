import { notFound } from "next/navigation";
import Link from "next/link";
import {
  getAuthorById,
  getBooksByAuthorId,
  getAuthorStats,
  getLatestChaptersByAuthor,
} from "@/lib/queries";
import { Pagination } from "@/components/ui/Pagination";
import { BookCover } from "@/components/books/BookCover";
import { getSource } from "@/lib/source";
import { STATUS_LABELS } from "@/types";

export const dynamic = "force-dynamic";

function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString("vi-VN");
}

interface Props {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ page?: string }>;
}

export default async function AuthorPage({ params, searchParams }: Props) {
  const { id: idStr } = await params;
  const { page: pageStr } = await searchParams;
  const authorId = parseInt(idStr, 10);
  if (isNaN(authorId)) notFound();

  const author = await getAuthorById(authorId);
  if (!author) notFound();

  const page = Math.max(1, parseInt(pageStr || "1", 10));
  const source = await getSource();
  const [books, stats, latestBooks] = await Promise.all([
    getBooksByAuthorId(authorId, page, 20, source),
    Promise.resolve(getAuthorStats(authorId, source)),
    Promise.resolve(getLatestChaptersByAuthor(authorId, 10, 3, source)),
  ]);

  return (
    <div className="max-w-5xl mx-auto px-4 py-6">
      {/* Breadcrumb */}
      <nav className="text-xs text-[var(--color-text-secondary)] mb-4">
        <Link href="/" className="hover:text-[var(--color-primary)]">Trang chủ</Link>
        <span className="mx-1">&rsaquo;</span>
        <Link href="/tac-gia" className="hover:text-[var(--color-primary)]">Tác giả</Link>
        <span className="mx-1">&rsaquo;</span>
        <span className="text-[var(--color-text)]">{author.name}</span>
      </nav>

      {/* Author header */}
      <div className="bg-gradient-to-r from-orange-50 to-amber-50 rounded-lg border border-orange-200 p-6 mb-6">
        <div className="flex items-center gap-5">
          <div className="w-16 h-16 rounded-full bg-gradient-to-br from-orange-400 to-amber-500 flex items-center justify-center text-white font-bold text-2xl shrink-0 shadow-md">
            {author.name.charAt(0).toUpperCase()}
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="text-xl font-bold text-[var(--color-text)]">{author.name}</h1>
            {author.localName && (
              <p className="text-sm text-[var(--color-text-secondary)] mt-0.5">{author.localName}</p>
            )}
          </div>
        </div>
        <div className="flex gap-8 mt-5 pl-1">
          <div className="text-center">
            <div className="text-2xl font-bold text-orange-600">{stats.totalBooks}</div>
            <div className="text-xs text-[var(--color-text-secondary)] mt-0.5">Tác phẩm</div>
          </div>
          <div className="w-px bg-orange-200" />
          <div className="text-center">
            <div className="text-2xl font-bold text-orange-600">{formatCompact(stats.totalWords)}</div>
            <div className="text-xs text-[var(--color-text-secondary)] mt-0.5">Chữ</div>
          </div>
          <div className="w-px bg-orange-200" />
          <div className="text-center">
            <div className="text-2xl font-bold text-orange-600">{formatCompact(stats.totalChapters)}</div>
            <div className="text-xs text-[var(--color-text-secondary)] mt-0.5">Chương</div>
          </div>
        </div>
      </div>

      {/* Books with latest chapters */}
      <div className="mb-6">
        <h2 className="text-lg font-bold text-[var(--color-primary)] mb-4 flex items-center gap-2">
          <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
            <path d="M9 4.804A7.968 7.968 0 005.5 4c-1.255 0-2.443.29-3.5.804v10A7.969 7.969 0 015.5 14c1.669 0 3.218.51 4.5 1.385A7.962 7.962 0 0114.5 14c1.255 0 2.443.29 3.5.804v-10A7.968 7.968 0 0014.5 4c-1.255 0-2.443.29-3.5.804V12a1 1 0 11-2 0V4.804z" />
          </svg>
          Truyện của tác giả
        </h2>
        <div className="space-y-4">
          {latestBooks.map((b) => (
            <div
              key={b.bookId}
              className="bg-white rounded-lg border border-[var(--color-border)] p-4 flex gap-4 card-hover"
            >
              <Link href={`/doc-truyen/${b.bookSlug}`} className="shrink-0">
                <BookCover bookId={b.bookId} name={b.bookName} size="md" />
              </Link>
              <div className="flex-1 min-w-0">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <Link
                      href={`/doc-truyen/${b.bookSlug}`}
                      className="text-base font-bold text-[var(--color-text)] hover:text-[var(--color-primary)] transition-colors line-clamp-1"
                    >
                      {b.bookName}
                    </Link>
                    <div className="mt-1">
                      <span className="inline-block text-xs px-2 py-0.5 rounded-full bg-orange-100 text-orange-700 font-medium">
                        {b.chapterCount} Chương &middot; {STATUS_LABELS[b.status] ?? "Còn tiếp"}
                      </span>
                    </div>
                  </div>
                  <Link
                    href={`/doc-truyen/${b.bookSlug}/chuong-1`}
                    className="shrink-0 px-3 py-1.5 text-xs font-medium rounded-full bg-[var(--color-primary)] text-white hover:opacity-90 transition-opacity"
                  >
                    Đọc ngay
                  </Link>
                </div>
                {b.synopsis && (
                  <p className="text-sm text-[var(--color-text-secondary)] mt-2 line-clamp-2 leading-relaxed">
                    {b.synopsis}
                  </p>
                )}
                {b.chapters.length > 0 && (
                  <div className="mt-3 space-y-1">
                    {b.chapters.map((ch) => (
                      <div key={ch.indexNum} className="flex items-center text-sm">
                        <Link
                          href={`/doc-truyen/${b.bookSlug}/chuong-${ch.indexNum}`}
                          className="text-[var(--color-primary)] hover:underline truncate"
                        >
                          Chương {ch.indexNum}: {ch.title}
                        </Link>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Full book grid with pagination */}
      {books.total > latestBooks.length && (
        <div className="bg-white rounded-lg border border-[var(--color-border)]">
          <div className="px-4 py-3 border-b border-[var(--color-border)]">
            <h2 className="font-bold text-sm">
              Tất cả truyện
              <span className="font-normal text-[var(--color-text-secondary)] ml-2">
                ({books.total} truyện)
              </span>
            </h2>
          </div>
          <div className="p-4 space-y-3">
            {books.data.map((book) => (
              <Link
                key={book.id}
                href={`/doc-truyen/${book.slug}`}
                className="flex items-center gap-3 p-2 rounded hover:bg-gray-50 transition-colors"
              >
                <BookCover bookId={book.id} name={book.name} size="xs" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-[var(--color-text)] truncate">{book.name}</div>
                  <div className="text-xs text-[var(--color-text-secondary)]">
                    {book.chapterCount} chương &middot; {STATUS_LABELS[book.status] ?? "Còn tiếp"}
                  </div>
                </div>
              </Link>
            ))}
          </div>
          {books.totalPages > 1 && (
            <div className="px-4 py-3 border-t border-[var(--color-border)]">
              <Pagination
                currentPage={page}
                totalPages={books.totalPages}
                baseUrl={`/tac-gia/${authorId}`}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
