import Link from "next/link";
import { StatusBadge } from "@/components/ui/Badge";
import { BookCover } from "@/components/books/BookCover";
import { QuickDownloadButton } from "@/components/books/QuickDownloadButton";
import { formatNumber, truncate } from "@/lib/utils";
import type { BookWithAuthor } from "@/types";

export function BookCard({ book }: { book: BookWithAuthor }) {
  return (
    <div className="bg-white rounded-lg border border-[var(--color-border)] overflow-hidden card-hover">
      <div className="flex p-3 gap-3">
        <Link href={`/doc-truyen/${book.slug}`} className="shrink-0 w-16 h-22">
          <BookCover bookId={book.id} name={book.name} size="sm" />
        </Link>
        <div className="flex-1 min-w-0">
          <Link href={`/doc-truyen/${book.slug}`}>
            <h3 className="font-semibold text-sm text-[var(--color-text)] line-clamp-1 hover:text-[var(--color-primary)] transition-colors">
              {book.name}
            </h3>
          </Link>
          {book.author && (
            <Link
              href={`/tac-gia/${book.author.id}`}
              className="text-xs text-[var(--color-text-secondary)] mt-0.5 hover:text-[var(--color-primary)] transition-colors block"
            >
              {book.author.name}
            </Link>
          )}
          <div className="flex items-center gap-3 mt-1.5 text-xs text-[var(--color-text-secondary)]">
            <span>{formatNumber(book.chapterCount)} ch</span>
            <span>{formatNumber(book.voteCount)} đề cử</span>
            <QuickDownloadButton bookId={book.id} />
            <StatusBadge status={book.status} />
          </div>
          {book.synopsis && (
            <p className="text-xs text-[var(--color-text-secondary)] mt-1.5 line-clamp-2">
              {truncate(book.synopsis.replace(/\\n/g, " "), 120)}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
