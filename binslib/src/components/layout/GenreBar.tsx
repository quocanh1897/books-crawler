import Link from "next/link";
import { getGenresWithCounts } from "@/lib/queries";

export async function GenreBar() {
  const genres = await getGenresWithCounts();

  return (
    <div className="bg-[var(--color-genre-bar)] text-white">
      <div className="max-w-7xl mx-auto px-4">
        <div className="flex items-center gap-1 overflow-x-auto genre-bar-scroll py-2 text-sm">
          <Link
            href="/"
            className="shrink-0 px-3 py-1 rounded hover:bg-white/10 transition-colors text-gray-300 hover:text-white"
          >
            Tất cả
          </Link>
          {genres.map((genre) => (
            <Link
              key={genre.id}
              href={`/the-loai/${genre.slug}`}
              className="shrink-0 px-3 py-1 rounded hover:bg-white/10 transition-colors text-gray-300 hover:text-white"
            >
              {genre.name}
              <span className="ml-1 text-xs text-gray-500">({genre.bookCount})</span>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
