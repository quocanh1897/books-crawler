"use client";

import { useState } from "react";

export function QuickDownloadButton({ bookId }: { bookId: number }) {
  const [state, setState] = useState<"idle" | "generating" | "error">("idle");

  async function handleDownload(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setState("generating");

    try {
      const res = await fetch(`/api/books/${bookId}/download`, { method: "POST" });
      const data = await res.json();

      if (data.status === "ready" && data.url) {
        window.location.href = data.url;
        setState("idle");
      } else {
        setState("error");
        setTimeout(() => setState("idle"), 2000);
      }
    } catch {
      setState("error");
      setTimeout(() => setState("idle"), 2000);
    }
  }

  return (
    <button
      onClick={handleDownload}
      disabled={state === "generating"}
      title={state === "error" ? "Lỗi tải epub" : "Tải epub"}
      className="inline-flex items-center justify-center w-6 h-6 rounded hover:bg-gray-200 transition-colors text-[var(--color-text-secondary)] hover:text-[var(--color-primary)] disabled:opacity-50"
    >
      {state === "generating" ? (
        <svg className="animate-spin w-3.5 h-3.5" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      ) : state === "error" ? (
        <svg className="w-3.5 h-3.5 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      ) : (
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
      )}
    </button>
  );
}
