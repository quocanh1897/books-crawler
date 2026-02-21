import { getLibraryStats, getBooks } from "@/lib/queries";
import { getSource } from "@/lib/source";
import { formatNumber, timeAgo } from "@/lib/utils";
import { BookCover } from "@/components/books/BookCover";
import Link from "next/link";

export async function Sidebar() {
  const source = await getSource();
  const [stats, recentBooks] = await Promise.all([
    getLibraryStats(source),
    getBooks({ sort: "updated_at", order: "desc", limit: 10, source }),
  ]);

  return (
    <aside className="space-y-6">
      {/* Recently Updated (Truyện mới xem) */}
      <div className="bg-white rounded-lg border border-[var(--color-border)] p-4">
        <h3 className="font-bold text-sm mb-3 text-[var(--color-text)]">
          Truyện mới cập nhật
        </h3>
        <div className="space-y-3">
          {recentBooks.data.slice(0, 10).map((book) => (
            <Link
              key={book.id}
              href={`/doc-truyen/${book.slug}`}
              className="flex gap-2 group"
            >
              <BookCover bookId={book.id} name={book.name} size="xs" />
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-[var(--color-text)] truncate group-hover:text-[var(--color-primary)] transition-colors">
                  {book.name}
                </p>
                <p className="text-xs text-[var(--color-text-secondary)]">
                  {book.author?.name}
                </p>
                <p className="text-xs text-[var(--color-text-secondary)]">
                  {timeAgo(book.updatedAt)}
                </p>
              </div>
            </Link>
          ))}
        </div>
      </div>

      {/* Library Stats */}
      <div className="bg-white rounded-lg border border-[var(--color-border)] p-4">
        <h3 className="font-bold text-sm mb-3 text-[var(--color-text)]">
          Thống kê thư viện
        </h3>
        <div className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-[var(--color-text-secondary)]">Truyện</span>
            <span className="font-semibold">{formatNumber(stats.totalBooks)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-[var(--color-text-secondary)]">Chương</span>
            <span className="font-semibold">{formatNumber(stats.totalChapters)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-[var(--color-text-secondary)]">Hoàn thành</span>
            <span className="font-semibold">{formatNumber(stats.completedBooks)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-[var(--color-text-secondary)]">Tổng từ</span>
            <span className="font-semibold">
              {stats.totalWords > 1_000_000
                ? `${(stats.totalWords / 1_000_000).toFixed(0)}M+`
                : formatNumber(stats.totalWords)}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-[var(--color-text-secondary)]">Thể loại</span>
            <span className="font-semibold">{stats.totalGenres}</span>
          </div>
        </div>
      </div>
    </aside>
  );
}
