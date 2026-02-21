import { getLibraryStats } from "@/lib/queries";
import { formatNumber } from "@/lib/utils";

export async function Footer() {
  const stats = await getLibraryStats();

  return (
    <footer className="bg-white border-t border-[var(--color-border)] mt-8">
      <div className="max-w-7xl mx-auto px-4 py-6 text-center text-sm text-[var(--color-text-secondary)]">
        <p className="font-medium text-[var(--color-text)]">Binslib</p>
        <p className="mt-1">Personal book library &amp; statistics dashboard</p>
        <div className="flex items-center justify-center gap-4 mt-3 text-xs">
          <span>{formatNumber(stats.totalBooks)} truyện</span>
          <span className="text-[var(--color-border)]">&middot;</span>
          <span>{formatNumber(stats.totalChapters)} chương</span>
          <span className="text-[var(--color-border)]">&middot;</span>
          <span>{formatNumber(stats.completedBooks)} hoàn thành</span>
          <span className="text-[var(--color-border)]">&middot;</span>
          <span>{stats.totalGenres} thể loại</span>
        </div>
      </div>
    </footer>
  );
}
