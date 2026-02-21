"use client";

import Link from "next/link";
import { ChapterListModal } from "./ChapterListModal";
import { ReaderSettingsButton, useReaderConfig, getTheme, getFontFamily } from "./ReaderSettings";

interface Chapter {
  title: string;
  body: string | null;
}

interface ChapterReaderProps {
  bookId: number;
  bookSlug: string;
  bookName: string;
  currentIndex: number;
  totalChapters: number;
  chapter: Chapter;
}

export function ChapterReader({
  bookId,
  bookSlug,
  bookName,
  currentIndex,
  totalChapters,
  chapter,
}: ChapterReaderProps) {
  const { config, update, hydrated } = useReaderConfig();
  const theme = getTheme(config.theme);
  const fontFamily = getFontFamily(config.font);
  const hasPrev = currentIndex > 1;
  const hasNext = currentIndex < totalChapters;

  const navBtnStyle = {
    borderColor: theme.border,
    color: theme.text,
  };

  if (!hydrated) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-6">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-200 rounded w-1/3" />
          <div className="h-96 bg-gray-100 rounded" />
        </div>
      </div>
    );
  }

  return (
    <div
      className="min-h-screen transition-colors duration-300"
      style={{ backgroundColor: theme.bg, color: theme.text }}
    >
      <div className="mx-auto px-4 py-6 transition-all duration-300" style={{ maxWidth: config.maxWidth }}>
        {/* Top nav */}
        <div className="flex items-center justify-between mb-4 text-sm">
          <Link
            href={`/doc-truyen/${bookSlug}`}
            className="hover:underline flex items-center gap-1 transition-colors"
            style={{ color: "#c9302c" }}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            {bookName}
          </Link>
          <div className="flex items-center gap-3">
            <span style={{ opacity: 0.6 }}>
              Chương {currentIndex} / {totalChapters}
            </span>
            <ChapterListModal
              bookId={bookId}
              bookSlug={bookSlug}
              currentIndex={currentIndex}
              totalChapters={totalChapters}
            />
            <ReaderSettingsButton config={config} onUpdate={update} />
          </div>
        </div>

        {/* Chapter content */}
        <article
          className="rounded-lg border p-8 transition-colors duration-300"
          style={{
            backgroundColor: theme.bg,
            borderColor: theme.border,
          }}
        >
          <h1
            className="font-bold text-center mb-6 transition-all"
            style={{ fontFamily, fontSize: config.fontSize + 2, color: theme.text }}
          >
            {chapter.title}
          </h1>
          <div
            className="leading-[1.9] transition-all"
            style={{ fontFamily, fontSize: config.fontSize, color: theme.text }}
          >
            {chapter.body?.split("\n").map((paragraph: string, i: number) => (
              <p key={i} className="mb-4 text-justify indent-8">
                {paragraph}
              </p>
            ))}
          </div>
        </article>

        {/* Bottom nav */}
        <div className="flex items-center justify-between mt-6">
          {hasPrev ? (
            <Link
              href={`/doc-truyen/${bookSlug}/chuong-${currentIndex - 1}`}
              className="px-4 py-2 text-sm font-medium rounded border transition-colors hover:opacity-80"
              style={navBtnStyle}
            >
              &laquo; Chương trước
            </Link>
          ) : (
            <div />
          )}
          <div className="flex items-center gap-3">
            <ChapterListModal
              bookId={bookId}
              bookSlug={bookSlug}
              currentIndex={currentIndex}
              totalChapters={totalChapters}
            />
            <ReaderSettingsButton config={config} onUpdate={update} />
          </div>
          {hasNext ? (
            <Link
              href={`/doc-truyen/${bookSlug}/chuong-${currentIndex + 1}`}
              className="px-4 py-2 text-sm font-medium rounded border transition-colors hover:opacity-80"
              style={navBtnStyle}
            >
              Chương sau &raquo;
            </Link>
          ) : (
            <div />
          )}
        </div>
      </div>
    </div>
  );
}
