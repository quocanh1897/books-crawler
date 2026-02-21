"use client";

import Link from "next/link";
import { ChapterListModal } from "./ChapterListModal";

interface ChapterNavProps {
  bookId: number;
  bookSlug: string;
  bookName: string;
  currentIndex: number;
  totalChapters: number;
}

export function ChapterNavTop({
  bookId,
  bookSlug,
  bookName,
  currentIndex,
  totalChapters,
}: ChapterNavProps) {
  return (
    <div className="flex items-center justify-between mb-6 text-sm">
      <Link
        href={`/doc-truyen/${bookSlug}`}
        className="text-[var(--color-primary)] hover:underline flex items-center gap-1"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
        </svg>
        {bookName}
      </Link>
      <div className="flex items-center gap-3">
        <span className="text-[var(--color-text-secondary)]">
          Chương {currentIndex} / {totalChapters}
        </span>
        <ChapterListModal
          bookId={bookId}
          bookSlug={bookSlug}
          currentIndex={currentIndex}
          totalChapters={totalChapters}
        />
      </div>
    </div>
  );
}

export function ChapterNavBottom({
  bookId,
  bookSlug,
  currentIndex,
  totalChapters,
}: Omit<ChapterNavProps, "bookName">) {
  const hasPrev = currentIndex > 1;
  const hasNext = currentIndex < totalChapters;

  return (
    <div className="flex items-center justify-between mt-6">
      {hasPrev ? (
        <Link
          href={`/doc-truyen/${bookSlug}/chuong-${currentIndex - 1}`}
          className="px-4 py-2 text-sm font-medium rounded border border-[var(--color-border)] hover:bg-gray-50 transition-colors"
        >
          &laquo; Chương trước
        </Link>
      ) : (
        <div />
      )}
      <ChapterListModal
        bookId={bookId}
        bookSlug={bookSlug}
        currentIndex={currentIndex}
        totalChapters={totalChapters}
      />
      {hasNext ? (
        <Link
          href={`/doc-truyen/${bookSlug}/chuong-${currentIndex + 1}`}
          className="px-4 py-2 text-sm font-medium rounded border border-[var(--color-border)] hover:bg-gray-50 transition-colors"
        >
          Chương sau &raquo;
        </Link>
      ) : (
        <div />
      )}
    </div>
  );
}
