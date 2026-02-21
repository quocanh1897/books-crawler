"use client";

import Link from "next/link";
import { cn } from "@/lib/utils";

interface PaginationProps {
  currentPage: number;
  totalPages: number;
  baseUrl: string;
  searchParams?: Record<string, string>;
}

export function Pagination({ currentPage, totalPages, baseUrl, searchParams = {} }: PaginationProps) {
  if (totalPages <= 1) return null;

  const pages: (number | "...")[] = [];
  const delta = 2;

  for (let i = 1; i <= totalPages; i++) {
    if (i === 1 || i === totalPages || (i >= currentPage - delta && i <= currentPage + delta)) {
      pages.push(i);
    } else if (pages[pages.length - 1] !== "...") {
      pages.push("...");
    }
  }

  function buildUrl(page: number) {
    const params = new URLSearchParams(searchParams);
    params.set("page", String(page));
    return `${baseUrl}?${params.toString()}`;
  }

  return (
    <nav className="flex items-center justify-center gap-1 mt-6">
      {currentPage > 1 && (
        <Link
          href={buildUrl(currentPage - 1)}
          className="px-3 py-1.5 text-sm border rounded hover:bg-gray-50 transition-colors"
        >
          &laquo;
        </Link>
      )}
      {pages.map((p, i) =>
        p === "..." ? (
          <span key={`dots-${i}`} className="px-2 py-1.5 text-sm text-gray-400">
            ...
          </span>
        ) : (
          <Link
            key={p}
            href={buildUrl(p)}
            className={cn(
              "px-3 py-1.5 text-sm border rounded transition-colors",
              p === currentPage
                ? "bg-[var(--color-primary)] text-white border-[var(--color-primary)]"
                : "hover:bg-gray-50"
            )}
          >
            {p}
          </Link>
        )
      )}
      {currentPage < totalPages && (
        <Link
          href={buildUrl(currentPage + 1)}
          className="px-3 py-1.5 text-sm border rounded hover:bg-gray-50 transition-colors"
        >
          &raquo;
        </Link>
      )}
    </nav>
  );
}
