import Link from "next/link";
import { getBooks, getGenresWithCounts } from "@/lib/queries";
import { getSource } from "@/lib/source";
import { BookCard } from "@/components/books/BookCard";
import { Pagination } from "@/components/ui/Pagination";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

interface Props {
  searchParams: Promise<{
    genre?: string;
    status?: string;
    sort?: string;
    min_chapters?: string;
    page?: string;
  }>;
}

const SORT_OPTIONS = [
  { value: "updated_at", label: "Mới cập nhật" },
  { value: "created_at", label: "Truyện mới" },
  { value: "view_count", label: "Lượt đọc" },
  { value: "bookmark_count", label: "Yêu thích" },
  { value: "comment_count", label: "Bình luận" },
  { value: "chapter_count", label: "Số chương" },
];

const CHAPTER_RANGES = [
  { value: undefined, label: "Tất cả" },
  { value: "2000", label: "2000+" },
  { value: "1000", label: "1000-2000" },
  { value: "300", label: "300-1000" },
];

export default async function FilterPage({ searchParams }: Props) {
  const params = await searchParams;
  const source = await getSource();
  const genreSlug = params.genre || undefined;
  const status = params.status ? parseInt(params.status, 10) : undefined;
  const sort = params.sort || "updated_at";
  const page = Math.max(1, parseInt(params.page || "1", 10));

  let minChapters: number | undefined;
  let maxChapters: number | undefined;
  if (params.min_chapters === "2000") {
    minChapters = 2000;
  } else if (params.min_chapters === "1000") {
    minChapters = 1000;
    maxChapters = 2000;
  } else if (params.min_chapters === "300") {
    minChapters = 300;
    maxChapters = 1000;
  }

  const [result, genres] = await Promise.all([
    getBooks({ sort, order: "desc", genre: genreSlug, status, minChapters, maxChapters, page, limit: 20, source }),
    getGenresWithCounts(source),
  ]);

  function buildUrl(overrides: Record<string, string | undefined>) {
    const p = new URLSearchParams();
    const merged = {
      genre: genreSlug,
      status: status?.toString(),
      sort,
      min_chapters: params.min_chapters,
      ...overrides,
      page: overrides.page || "1",
    };
    for (const [k, v] of Object.entries(merged)) {
      if (v) p.set(k, v);
    }
    return `/tong-hop?${p.toString()}`;
  }

  const allSearchParams: Record<string, string> = {};
  if (genreSlug) allSearchParams.genre = genreSlug;
  if (status) allSearchParams.status = String(status);
  if (sort !== "updated_at") allSearchParams.sort = sort;
  if (params.min_chapters) allSearchParams.min_chapters = params.min_chapters;

  return (
    <div className="max-w-7xl mx-auto px-4 py-6">
      <h1 className="text-lg font-bold mb-4">Bộ lọc</h1>

      {/* Filters */}
      <div className="bg-white rounded-lg border border-[var(--color-border)] p-4 mb-4 space-y-3">
        {/* Genre */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-[var(--color-text-secondary)] w-16 shrink-0">Thể loại:</span>
          <Link
            href={buildUrl({ genre: undefined })}
            className={cn(
              "px-3 py-1 text-xs rounded-full border transition-colors",
              !genreSlug
                ? "bg-[var(--color-primary)] text-white border-[var(--color-primary)]"
                : "border-[var(--color-border)] text-[var(--color-text-secondary)] hover:border-[var(--color-primary)]"
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
                  : "border-[var(--color-border)] text-[var(--color-text-secondary)] hover:border-[var(--color-primary)]"
              )}
            >
              {g.name}
            </Link>
          ))}
        </div>

        {/* Status */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-[var(--color-text-secondary)] w-16 shrink-0">Trạng thái:</span>
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
                  : "border-[var(--color-border)] text-[var(--color-text-secondary)] hover:border-[var(--color-primary)]"
              )}
            >
              {l}
            </Link>
          ))}
        </div>

        {/* Sort */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-[var(--color-text-secondary)] w-16 shrink-0">Sắp xếp:</span>
          {SORT_OPTIONS.map((s) => (
            <Link
              key={s.value}
              href={buildUrl({ sort: s.value })}
              className={cn(
                "px-3 py-1 text-xs rounded-full border transition-colors",
                sort === s.value
                  ? "bg-[var(--color-primary)] text-white border-[var(--color-primary)]"
                  : "border-[var(--color-border)] text-[var(--color-text-secondary)] hover:border-[var(--color-primary)]"
              )}
            >
              {s.label}
            </Link>
          ))}
        </div>

        {/* Chapter Count */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-[var(--color-text-secondary)] w-16 shrink-0">Số chương:</span>
          {CHAPTER_RANGES.map((r) => (
            <Link
              key={r.label}
              href={buildUrl({ min_chapters: r.value })}
              className={cn(
                "px-3 py-1 text-xs rounded-full border transition-colors",
                params.min_chapters === r.value || (!params.min_chapters && !r.value)
                  ? "bg-[var(--color-primary)] text-white border-[var(--color-primary)]"
                  : "border-[var(--color-border)] text-[var(--color-text-secondary)] hover:border-[var(--color-primary)]"
              )}
            >
              {r.label}
            </Link>
          ))}
        </div>
      </div>

      {/* Results */}
      <div className="mb-2 text-sm text-[var(--color-text-secondary)]">
        {result.total} truyện
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {result.data.map((book) => (
          <BookCard key={book.id} book={book} />
        ))}
      </div>

      {result.data.length === 0 && (
        <p className="text-sm text-[var(--color-text-secondary)] py-12 text-center">
          Không tìm thấy truyện nào phù hợp.
        </p>
      )}

      <Pagination
        currentPage={page}
        totalPages={result.totalPages}
        baseUrl="/tong-hop"
        searchParams={allSearchParams}
      />
    </div>
  );
}
