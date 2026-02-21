import { notFound } from "next/navigation";
import Link from "next/link";
import { getBookBySlug, getChaptersByBookId, getBooksByAuthorId, getBooks } from "@/lib/queries";
import { BookCover } from "@/components/books/BookCover";
import { DownloadButton } from "@/components/books/DownloadButton";
import { Pagination } from "@/components/ui/Pagination";
import { STATUS_LABELS } from "@/types";
import { formatNumber } from "@/lib/utils";
import { BookDetailTabs } from "@/components/books/BookDetailTabs";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ page?: string; tab?: string }>;
}

export default async function BookDetailPage({ params, searchParams }: Props) {
  const { slug } = await params;
  const { page: pageStr, tab } = await searchParams;
  const page = Math.max(1, parseInt(pageStr || "1", 10));
  const activeTab = tab === "chapters" || tab === "info" ? tab : "info";

  const book = await getBookBySlug(slug);
  if (!book) notFound();

  const primaryGenre = book.genres[0] ?? null;

  const [chapters, authorBooks, genreBooks] = await Promise.all([
    getChaptersByBookId(book.id, activeTab === "chapters" ? page : 1, 50),
    book.author
      ? getBooksByAuthorId(book.author.id, 1, 15)
      : Promise.resolve({ data: [], total: 0, page: 1, limit: 15, totalPages: 0 }),
    primaryGenre
      ? getBooks({ genre: primaryGenre.slug, sort: "bookmark_count", order: "desc", limit: 12 })
      : Promise.resolve({ data: [], total: 0, page: 1, limit: 12, totalPages: 0 }),
  ]);

  const sameAuthorBooks = authorBooks.data.filter((b) => b.id !== book.id);
  const sameGenreBooks = genreBooks.data.filter((b) => b.id !== book.id).slice(0, 6);
  const reviewScore = book.reviewScore ?? 0;
  const fullStars = Math.floor(reviewScore);
  const hasHalf = reviewScore - fullStars >= 0.3;

  return (
    <div className="max-w-7xl mx-auto px-4 py-6">
      {/* Breadcrumb */}
      <nav className="text-xs text-[var(--color-text-secondary)] mb-4">
        <Link href="/" className="hover:text-[var(--color-primary)]">Trang chủ</Link>
        {book.genres[0] && (
          <>
            <span className="mx-1">&rsaquo;</span>
            <Link href={`/the-loai/${book.genres[0].slug}`} className="hover:text-[var(--color-primary)]">
              {book.genres[0].name}
            </Link>
          </>
        )}
        <span className="mx-1">&rsaquo;</span>
        <span className="text-[var(--color-text)]">{book.name}</span>
      </nav>

      {/* Hero Header */}
      <div className="bg-white rounded-lg border border-[var(--color-border)] overflow-hidden">
        <div className="bg-gradient-to-r from-[#2a2a2a] to-[#3d3d3d] px-6 py-6">
          <div className="flex gap-6">
            {/* Cover */}
            <div className="shrink-0 shadow-lg rounded overflow-hidden border-2 border-white/20">
              <BookCover bookId={book.id} name={book.name} size="lg" />
            </div>

            {/* Info */}
            <div className="flex-1 min-w-0 text-white">
              <h1 className="text-2xl font-bold mb-3">{book.name}</h1>

              {/* Badges row */}
              <div className="flex flex-wrap items-center gap-2 mb-3">
                {book.author && (
                  <Link
                    href={`/tac-gia/${book.author.id}`}
                    className="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded border border-white/30 text-white/90 hover:bg-white/10 transition-colors"
                  >
                    {book.author.name}
                  </Link>
                )}
                <span className="inline-flex items-center px-2.5 py-1 text-xs rounded border border-white/30 text-white/90">
                  {STATUS_LABELS[book.status] || "Unknown"}
                </span>
                {book.genres.map((g) => (
                  <Link
                    key={g.id}
                    href={`/the-loai/${g.slug}`}
                    className="inline-flex items-center px-2.5 py-1 text-xs rounded border border-white/30 text-white/90 hover:bg-white/10 transition-colors"
                  >
                    {g.name}
                  </Link>
                ))}
              </div>

              {/* Synopsis teaser */}
              {book.synopsis && (
                <p className="text-sm text-white/70 line-clamp-2 mb-4 max-w-2xl leading-relaxed">
                  {book.synopsis.replace(/\\n/g, " ").slice(0, 200)}...
                </p>
              )}

              {/* Stats */}
              <div className="flex flex-wrap gap-6 mb-4 text-sm">
                <div>
                  <span className="font-bold text-white">{formatNumber(book.bookmarkCount)}</span>
                  <span className="text-white/60 ml-1">Lượt đánh dấu</span>
                </div>
                <div className="border-l border-white/20 pl-6">
                  <span className="font-bold text-white">{formatNumber(book.commentCount)}</span>
                  <span className="text-white/60 ml-1">Bình luận</span>
                </div>
                <div className="border-l border-white/20 pl-6">
                  <span className="font-bold text-white">{formatNumber(book.voteCount)}</span>
                  <span className="text-white/60 ml-1">Đề cử</span>
                </div>
              </div>

              {/* Action Buttons */}
              <div className="flex flex-wrap gap-2">
                {chapters.data.length > 0 && (
                  <Link
                    href={`/doc-truyen/${book.slug}/chuong-1`}
                    className="px-6 py-2 text-sm font-medium rounded bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent-dark)] transition-colors"
                  >
                    Đọc truyện
                  </Link>
                )}
                <DownloadButton bookId={book.id} bookStatus={book.status} />
              </div>
            </div>

            {/* Rating (right side) */}
            <div className="hidden md:flex flex-col items-center justify-start shrink-0 pt-1">
              <div className="text-3xl font-bold text-white">{reviewScore > 0 ? reviewScore.toFixed(1) : "N/A"}</div>
              <div className="flex gap-0.5 my-1.5">
                {[1, 2, 3, 4, 5].map((star) => (
                  <svg
                    key={star}
                    className={`w-4 h-4 ${
                      star <= fullStars
                        ? "text-yellow-400"
                        : star === fullStars + 1 && hasHalf
                        ? "text-yellow-400"
                        : "text-white/30"
                    }`}
                    fill="currentColor"
                    viewBox="0 0 20 20"
                  >
                    {star <= fullStars ? (
                      <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                    ) : star === fullStars + 1 && hasHalf ? (
                      <>
                        <defs>
                          <linearGradient id={`half-${star}`}>
                            <stop offset="50%" stopColor="currentColor" />
                            <stop offset="50%" stopColor="rgba(255,255,255,0.3)" />
                          </linearGradient>
                        </defs>
                        <path fill={`url(#half-${star})`} d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                      </>
                    ) : (
                      <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                    )}
                  </svg>
                ))}
              </div>
              <div className="text-xs text-white/50">
                {book.reviewCount > 0 ? `${book.reviewCount} đánh giá` : "Chưa có đánh giá"}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Tabs + Content */}
      <div className="flex gap-6 mt-4">
        {/* Main content */}
        <div className="flex-1 min-w-0">
          {/* Tab navigation */}
          <BookDetailTabs slug={book.slug} activeTab={activeTab} chapterCount={chapters.total} />

          {/* Tab content */}
          {activeTab === "info" ? (
            <div className="bg-white rounded-b-lg border border-t-0 border-[var(--color-border)] p-6">
              {/* Synopsis */}
              {book.synopsis ? (
                <div className="text-sm text-[var(--color-text)] leading-relaxed whitespace-pre-line">
                  {book.synopsis.replace(/\\n/g, "\n")}
                </div>
              ) : (
                <p className="text-sm text-[var(--color-text-secondary)] italic">
                  Chưa có giới thiệu.
                </p>
              )}

              {/* Tags */}
              {book.tags.length > 0 && (
                <div className="mt-6 pt-4 border-t border-[var(--color-border)]">
                  <span className="text-xs font-medium text-[var(--color-text-secondary)]">Tags: </span>
                  {book.tags.map((t) => (
                    <span
                      key={t.id}
                      className="inline-block text-xs px-2 py-0.5 rounded bg-gray-100 text-[var(--color-text-secondary)] mr-1.5 mb-1"
                    >
                      {t.name}
                    </span>
                  ))}
                </div>
              )}

              {/* Book info table */}
              <div className="mt-6 pt-4 border-t border-[var(--color-border)]">
                <div className="grid grid-cols-2 gap-y-2 text-sm">
                  <div className="text-[var(--color-text-secondary)]">Số chương</div>
                  <div>{formatNumber(book.chapterCount)} chương</div>
                  <div className="text-[var(--color-text-secondary)]">Số từ</div>
                  <div>{formatNumber(book.wordCount)}</div>
                  {book.createdAt && (
                    <>
                      <div className="text-[var(--color-text-secondary)]">Ngày đăng</div>
                      <div>{new Date(book.createdAt).toLocaleDateString("vi-VN")}</div>
                    </>
                  )}
                  {book.updatedAt && (
                    <>
                      <div className="text-[var(--color-text-secondary)]">Cập nhật</div>
                      <div>{new Date(book.updatedAt).toLocaleDateString("vi-VN")}</div>
                    </>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="bg-white rounded-b-lg border border-t-0 border-[var(--color-border)]">
              <div className="divide-y divide-[var(--color-border)]">
                {chapters.data.map((ch) => (
                  <Link
                    key={ch.id}
                    href={`/doc-truyen/${book.slug}/chuong-${ch.indexNum}`}
                    className="flex items-center justify-between px-4 py-2.5 text-sm hover:bg-gray-50 transition-colors text-[var(--color-text)] hover:text-[var(--color-primary)]"
                  >
                    <span className="truncate">{ch.title}</span>
                  </Link>
                ))}
              </div>
              {chapters.totalPages > 1 && (
                <div className="px-4 py-3 border-t border-[var(--color-border)]">
                  <Pagination
                    currentPage={page}
                    totalPages={chapters.totalPages}
                    baseUrl={`/doc-truyen/${book.slug}`}
                    searchParams={{ tab: "chapters" }}
                  />
                </div>
              )}
            </div>
          )}
        </div>

        {/* Sidebar */}
        <div className="hidden lg:block w-72 shrink-0 space-y-4">
          {/* Author card */}
          {book.author && (
            <div className="bg-white rounded-lg border border-[var(--color-border)] p-4">
              <Link href={`/tac-gia/${book.author.id}`} className="flex flex-col items-center gap-2 group">
                <div className="w-16 h-16 rounded-full bg-[var(--color-primary)] flex items-center justify-center text-white font-bold text-2xl">
                  {book.author.name.charAt(0).toUpperCase()}
                </div>
                <span className="text-sm font-medium text-[var(--color-text)] group-hover:text-[var(--color-primary)] transition-colors">
                  {book.author.name}
                </span>
              </Link>
            </div>
          )}

          {/* Quick stats card */}
          <div className="bg-white rounded-lg border border-[var(--color-border)] p-4">
            <h3 className="text-xs font-semibold text-[var(--color-text-secondary)] mb-3">Thống kê</h3>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-[var(--color-text-secondary)]">Đề cử</span>
                <span className="font-medium">{formatNumber(book.voteCount)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[var(--color-text-secondary)]">Yêu thích</span>
                <span className="font-medium">{formatNumber(book.bookmarkCount)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[var(--color-text-secondary)]">Bình luận</span>
                <span className="font-medium">{formatNumber(book.commentCount)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[var(--color-text-secondary)]">Đánh giá</span>
                <span className="font-medium">{reviewScore > 0 ? reviewScore.toFixed(1) : "—"}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Same author books — horizontal cards */}
      {sameAuthorBooks.length > 0 && (
        <div className="mt-6">
          <div className="bg-white rounded-lg border border-[var(--color-border)]">
            <div className="px-5 py-3 border-b border-[var(--color-border)] flex items-center justify-between">
              <h2 className="font-bold text-sm">Truyện cùng tác giả</h2>
              {book.author && (
                <Link
                  href={`/tac-gia/${book.author.id}`}
                  className="text-xs text-[var(--color-primary)] hover:underline"
                >
                  Xem tất cả &raquo;
                </Link>
              )}
            </div>
            <div className="p-5 overflow-x-auto">
              <div className="flex gap-5" style={{ minWidth: "max-content" }}>
                {sameAuthorBooks.slice(0, 8).map((b) => (
                  <Link
                    key={b.id}
                    href={`/doc-truyen/${b.slug}`}
                    className="group w-[120px] shrink-0 card-hover rounded-lg p-1"
                  >
                    <BookCover bookId={b.id} name={b.name} size="md" />
                    <h3 className="mt-2 text-sm font-medium text-[var(--color-text)] line-clamp-2 group-hover:text-[var(--color-primary)] transition-colors leading-snug">
                      {b.name}
                    </h3>
                    {b.author && (
                      <p className="text-xs text-[var(--color-text-secondary)] mt-0.5 truncate">
                        {b.author.name}
                      </p>
                    )}
                  </Link>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Same genre books — horizontal cards */}
      {sameGenreBooks.length > 0 && primaryGenre && (
        <div className="mt-4">
          <div className="bg-white rounded-lg border border-[var(--color-border)]">
            <div className="px-5 py-3 border-b border-[var(--color-border)] flex items-center justify-between">
              <h2 className="font-bold text-sm">Có thể bạn sẽ thích</h2>
              <Link
                href={`/the-loai/${primaryGenre.slug}`}
                className="text-xs text-[var(--color-primary)] hover:underline"
              >
                {primaryGenre.name} &raquo;
              </Link>
            </div>
            <div className="p-5 overflow-x-auto">
              <div className="flex gap-5" style={{ minWidth: "max-content" }}>
                {sameGenreBooks.map((b) => (
                  <Link
                    key={b.id}
                    href={`/doc-truyen/${b.slug}`}
                    className="group w-[120px] shrink-0 card-hover rounded-lg p-1"
                  >
                    <BookCover bookId={b.id} name={b.name} size="md" />
                    <h3 className="mt-2 text-sm font-medium text-[var(--color-text)] line-clamp-2 group-hover:text-[var(--color-primary)] transition-colors leading-snug">
                      {b.name}
                    </h3>
                    {b.author && (
                      <p className="text-xs text-[var(--color-text-secondary)] mt-0.5 truncate">
                        {b.author.name}
                      </p>
                    )}
                  </Link>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
