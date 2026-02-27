"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import Link from "next/link";
import type { GenreWithCount } from "@/types";

// Fallback icon for genres not in the map (generic tag/bookmark)
const DEFAULT_ICON =
  "M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A2 2 0 013 12V7a4 4 0 014-4z";

const GENRE_ICONS: Record<string, string> = {
  // ── Tiên hiệp / Huyền huyễn ──────────────────────────────────────
  "tien-hiep": "M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5",
  "tien-hiep-ky-duyen":
    "M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5",
  "huyen-huyen": "M13 10V3L4 14h7v7l9-11h-7z",
  "ky-huyen": "M13 10V3L4 14h7v7l9-11h-7z",
  "ky-ao":
    "M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z",
  // ── Kiếm hiệp / Võ hiệp ──────────────────────────────────────────
  "kiem-hiep":
    "M14.121 14.121L7.05 21.192l-2.12-2.122 7.07-7.07L4.929 4.929A1 1 0 016.343 3.515L19.07 6.243l1.414-1.414 1.414 1.414-1.414 1.414 2.121 2.121-1.414 1.415-2.121-2.122-1.414 1.414 2.121 2.122-1.414 1.414-2.121-2.121z",
  "vo-hiep":
    "M14.121 14.121L7.05 21.192l-2.12-2.122 7.07-7.07L4.929 4.929A1 1 0 016.343 3.515L19.07 6.243l1.414-1.414 1.414 1.414-1.414 1.414 2.121 2.121-1.414 1.415-2.121-2.122-1.414 1.414 2.121 2.122-1.414 1.414-2.121-2.121z",
  // ── Đô thị / Quan trường ──────────────────────────────────────────
  "do-thi":
    "M3 21h18M5 21V7l7-4 7 4v14M9 21v-4h6v4M9 9h.01M15 9h.01M9 13h.01M15 13h.01",
  "quan-truong":
    "M3 21h18M5 21V7l7-4 7 4v14M9 21v-4h6v4M9 9h.01M15 9h.01M9 13h.01M15 13h.01",
  // ── Khoa huyễn / Hệ thống ─────────────────────────────────────────
  "khoa-huyen":
    "M12 2a4 4 0 014 4v1a1 1 0 001 1h1a4 4 0 010 8h-1a1 1 0 00-1 1v1a4 4 0 01-8 0v-1a1 1 0 00-1-1H6a4 4 0 010-8h1a1 1 0 001-1V6a4 4 0 014-4z",
  "khoa-huyen-khong-gian":
    "M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9",
  "he-thong":
    "M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.573-1.066zM15 12a3 3 0 11-6 0 3 3 0 016 0z",
  // ── Võng du / Du hí / Cạnh kỹ ─────────────────────────────────────
  "vong-du":
    "M15 5v2m0 4v2m0 4v2M5 5a2 2 0 00-2 2v3a2 2 0 002 2h14a2 2 0 002-2V7a2 2 0 00-2-2H5zM5 12a2 2 0 00-2 2v3a2 2 0 002 2h14a2 2 0 002-2v-3a2 2 0 00-2-2H5z",
  "du-hi":
    "M15 5v2m0 4v2m0 4v2M5 5a2 2 0 00-2 2v3a2 2 0 002 2h14a2 2 0 002-2V7a2 2 0 00-2-2H5zM5 12a2 2 0 00-2 2v3a2 2 0 002 2h14a2 2 0 002-2v-3a2 2 0 00-2-2H5z",
  "canh-ky":
    "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM17.5 14l3.5 7-3.5-2-3.5 2 3.5-7z",
  // ── Đồng nhân ─────────────────────────────────────────────────────
  "dong-nhan":
    "M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z",
  // ── Lịch sử / Dã sử / Quân sự ────────────────────────────────────
  "lich-su": "M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z",
  "da-su":
    "M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253",
  "quan-su":
    "M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z",
  // ── Ngôn tình ─────────────────────────────────────────────────────
  "ngon-tinh":
    "M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12z",
  "co-dai-ngon-tinh":
    "M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z",
  "hien-dai-ngon-tinh":
    "M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12z",
  "huyen-huyen-ngon-tinh":
    "M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z",
  "lang-man-thanh-xuan":
    "M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12z",
  // ── Huyền nghi / Linh dị ──────────────────────────────────────────
  "huyen-nghi":
    "M15 12a3 3 0 11-6 0 3 3 0 016 0zM2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z",
  "huyen-nghi-than-quai":
    "M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z",
  "linh-di":
    "M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z",
  // ── Light novel / Sách ────────────────────────────────────────────
  "light-novel":
    "M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253",
};

function GenreIcon({ slug }: { slug: string }) {
  const d = GENRE_ICONS[slug] ?? DEFAULT_ICON;
  return (
    <svg
      className="w-4 h-4 shrink-0 opacity-70"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={d} />
    </svg>
  );
}

function ScrollingName({ text }: { text: string }) {
  const outerRef = useRef<HTMLSpanElement>(null);
  const innerRef = useRef<HTMLSpanElement>(null);
  const [overflow, setOverflow] = useState(0);

  const measure = useCallback(() => {
    const outer = outerRef.current;
    const inner = innerRef.current;
    if (outer && inner) {
      const diff = inner.scrollWidth - outer.clientWidth;
      setOverflow(diff > 1 ? diff : 0);
    }
  }, []);

  useEffect(() => {
    measure();
  }, [measure, text]);

  const duration = overflow > 0 ? Math.max(1.5, overflow / 30) : 0;

  return (
    <span ref={outerRef} className="overflow-hidden block min-w-0">
      <span
        ref={innerRef}
        className="inline-block whitespace-nowrap"
        style={
          overflow > 0
            ? {
                // scroll left to reveal hidden text, pause, scroll back
                animation: `scrollReveal ${duration}s ease-in-out infinite alternate`,
                animationPlayState: "paused",
                // CSS variable to control the exact scroll distance
                ["--scroll-dist" as string]: `-${overflow}px`,
              }
            : undefined
        }
      >
        {text}
      </span>
    </span>
  );
}

interface CategoryDropdownProps {
  genres: GenreWithCount[];
}

export function CategoryDropdown({ genres }: CategoryDropdownProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    function handleEscape(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    if (open) {
      document.addEventListener("mousedown", handleClickOutside);
      document.addEventListener("keydown", handleEscape);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 text-[var(--color-text-secondary)] hover:text-[var(--color-primary)] transition-colors text-sm"
      >
        <svg
          className="w-4 h-4"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          strokeWidth={1.5}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5"
          />
        </svg>
        Danh mục
        <svg
          className={`w-3.5 h-3.5 transition-transform ${open ? "rotate-180" : ""}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M19 9l-7 7-7-7"
          />
        </svg>
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-2 w-[560px] bg-white rounded-lg shadow-xl border border-[var(--color-border)] z-50 overflow-hidden">
          {/* Thể loại section */}
          <div className="p-4 border-b border-[var(--color-border)]">
            <h3 className="text-xs font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider mb-3">
              Thể loại
            </h3>
            <div className="grid grid-cols-3 gap-1.5">
              {genres.map((genre) => (
                <Link
                  key={genre.id}
                  href={`/the-loai/${genre.slug}`}
                  onClick={() => setOpen(false)}
                  className="genre-item flex items-center gap-2 px-2.5 py-2 text-sm rounded-md text-[var(--color-text)] hover:bg-[var(--color-primary)] hover:text-white transition-colors group min-w-0"
                >
                  <GenreIcon slug={genre.slug} />
                  <ScrollingName text={genre.name} />
                  <span className="ml-auto text-xs opacity-50 group-hover:opacity-70 shrink-0">
                    {genre.bookCount}
                  </span>
                </Link>
              ))}
            </div>
          </div>

          {/* Tác giả section */}
          <div className="p-4">
            <h3 className="text-xs font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider mb-3">
              Tác giả
            </h3>
            <Link
              href="/tac-gia"
              onClick={() => setOpen(false)}
              className="inline-flex items-center gap-2 px-3 py-2 text-sm rounded-md bg-gray-50 text-[var(--color-text)] hover:bg-[var(--color-primary)] hover:text-white transition-colors"
            >
              <svg
                className="w-4 h-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                strokeWidth={1.5}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"
                />
              </svg>
              Xem tất cả tác giả
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
