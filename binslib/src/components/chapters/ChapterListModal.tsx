"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";

interface ChapterEntry {
  indexNum: number;
  title: string;
}

interface ChapterListModalProps {
  bookId: number;
  bookSlug: string;
  currentIndex: number;
  totalChapters: number;
}

export function ChapterListModal({
  bookId,
  bookSlug,
  currentIndex,
  totalChapters,
}: ChapterListModalProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [chapters, setChapters] = useState<ChapterEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const activeRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const fetchChapters = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/books/${bookId}/chapters`);
      if (res.ok) setChapters(await res.json());
    } finally {
      setLoading(false);
    }
  }, [bookId]);

  useEffect(() => {
    if (open && chapters.length === 0) fetchChapters();
  }, [open, chapters.length, fetchChapters]);

  useEffect(() => {
    if (open && !loading && activeRef.current) {
      setTimeout(() => {
        activeRef.current?.scrollIntoView({ block: "center", behavior: "instant" });
      }, 50);
    }
  }, [open, loading]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open]);

  const filtered = search.trim()
    ? chapters.filter(
        (ch) =>
          ch.title.toLowerCase().includes(search.toLowerCase()) ||
          String(ch.indexNum).includes(search)
      )
    : chapters;

  function goToChapter(indexNum: number) {
    setOpen(false);
    router.push(`/doc-truyen/${bookSlug}/chuong-${indexNum}`);
  }

  return (
    <>
      <TocButton onClick={() => setOpen(true)} />

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          onClick={() => setOpen(false)}
        >
          <div className="absolute inset-0 bg-black/40" />
          <div
            className="relative bg-white rounded-xl shadow-2xl w-full max-w-lg mx-4 max-h-[80vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--color-border)]">
              <h2 className="font-bold text-base">
                Mục lục
                <span className="text-xs font-normal text-[var(--color-text-secondary)] ml-2">
                  {totalChapters} chương
                </span>
              </h2>
              <button
                onClick={() => setOpen(false)}
                className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-gray-100 transition-colors text-[var(--color-text-secondary)]"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Search */}
            <div className="px-5 py-3 border-b border-[var(--color-border)]">
              <div className="relative">
                <svg
                  className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-secondary)]"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                <input
                  type="text"
                  placeholder="Tìm chương (tên hoặc số)..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="w-full pl-10 pr-4 py-2 text-sm border border-[var(--color-border)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/30 focus:border-[var(--color-primary)]"
                  autoFocus
                />
              </div>
            </div>

            {/* Chapter List */}
            <div ref={listRef} className="flex-1 overflow-y-auto">
              {loading ? (
                <div className="flex items-center justify-center py-12">
                  <div className="w-6 h-6 border-2 border-[var(--color-primary)] border-t-transparent rounded-full animate-spin" />
                </div>
              ) : filtered.length === 0 ? (
                <p className="text-sm text-[var(--color-text-secondary)] text-center py-12">
                  Không tìm thấy chương nào.
                </p>
              ) : (
                <div className="py-1">
                  {filtered.map((ch) => {
                    const isCurrent = ch.indexNum === currentIndex;
                    return (
                      <button
                        key={ch.indexNum}
                        ref={isCurrent ? activeRef : undefined}
                        onClick={() => goToChapter(ch.indexNum)}
                        className={`w-full text-left px-5 py-2.5 text-sm transition-colors flex items-baseline gap-3 ${
                          isCurrent
                            ? "bg-[var(--color-primary)]/10 text-[var(--color-primary)] font-medium"
                            : "hover:bg-gray-50 text-[var(--color-text)]"
                        }`}
                      >
                        <span className={`shrink-0 w-12 text-right tabular-nums text-xs ${
                          isCurrent ? "text-[var(--color-primary)]" : "text-[var(--color-text-secondary)]"
                        }`}>
                          {ch.indexNum}
                        </span>
                        <span className="line-clamp-1">{ch.title}</span>
                        {isCurrent && (
                          <span className="shrink-0 ml-auto text-[10px] bg-[var(--color-primary)] text-white px-1.5 py-0.5 rounded">
                            đang đọc
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function TocButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="text-[var(--color-primary)] hover:underline flex items-center gap-1 text-sm"
    >
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
      </svg>
      Mục lục
    </button>
  );
}

export function TocButtonBottom({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="px-4 py-2 text-sm font-medium rounded border border-[var(--color-border)] hover:bg-gray-50 transition-colors flex items-center gap-1"
    >
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
      </svg>
      Mục lục
    </button>
  );
}
