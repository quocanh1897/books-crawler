"use client";

import { useState } from "react";

interface DownloadButtonProps {
  bookId: number;
  bookStatus: number;
}

export function DownloadButton({ bookId, bookStatus }: DownloadButtonProps) {
  const [state, setState] = useState<"idle" | "generating" | "error">("idle");
  const [error, setError] = useState("");

  async function handleDownload() {
    setState("generating");
    setError("");

    try {
      const res = await fetch(`/api/books/${bookId}/download`, { method: "POST" });
      const data = await res.json();

      if (data.status === "ready" && data.url) {
        window.location.href = data.url;
        setState("idle");
      } else if (data.status === "error") {
        setError(data.message || "Failed to generate EPUB");
        setState("error");
      }
    } catch {
      setError("Network error");
      setState("error");
    }
  }

  return (
    <div>
      <button
        onClick={handleDownload}
        disabled={state === "generating"}
        className="px-5 py-2 text-sm font-medium rounded bg-[var(--color-primary)] text-white hover:bg-[var(--color-primary-dark)] transition-colors disabled:opacity-60 flex items-center gap-2"
      >
        {state === "generating" ? (
          <>
            <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            <span>&#272;ANG T&#7840;O...</span>
          </>
        ) : (
          <>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            <span>DOWNLOAD EPUB</span>
          </>
        )}
      </button>
      {state === "error" && (
        <p className="text-xs text-[var(--color-accent)] mt-1">{error}</p>
      )}
    </div>
  );
}
