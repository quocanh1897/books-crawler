"use client";

import { useState, useRef, useEffect, type ReactNode } from "react";
import { useSource, type BookSource } from "./SourceContext";

interface SourceInfo {
  key: BookSource;
  label: string;
  description: string;
  accentClass: string;
  activeClass: string;
  icon: ReactNode;
}

const SOURCES: SourceInfo[] = [
  {
    key: "mtc",
    label: "MTC",
    description: "metruyencv",
    accentClass: "text-amber-600",
    activeClass: "bg-amber-50 border-amber-200",
    icon: (
      <svg
        className="w-5 h-5"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M4 19.5v-15A2.5 2.5 0 016.5 2H20v20H6.5a2.5 2.5 0 010-5H20" />
        <path d="M12 7v4m0 0v4m0-4h3m-3 0H9" />
      </svg>
    ),
  },
  {
    key: "ttv",
    label: "TTV",
    description: "tangthuvien",
    accentClass: "text-emerald-600",
    activeClass: "bg-emerald-50 border-emerald-200",
    icon: (
      <svg
        className="w-5 h-5"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M4 19.5v-15A2.5 2.5 0 016.5 2H20v20H6.5a2.5 2.5 0 010-5H20" />
        <circle cx="12" cy="10" r="3" />
        <path d="M12 13v2" />
      </svg>
    ),
  },
  {
    key: "tf",
    label: "TruyenFull",
    description: "truyenfull",
    accentClass: "text-blue-600",
    activeClass: "bg-blue-50 border-blue-200",
    icon: (
      <svg
        className="w-5 h-5"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M4 19.5v-15A2.5 2.5 0 016.5 2H20v20H6.5a2.5 2.5 0 010-5H20" />
        <path d="M9.5 9l2 2 4-4" />
      </svg>
    ),
  },
];

function CheckIcon() {
  return (
    <svg
      className="w-4 h-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M5 13l4 4L19 7" />
    </svg>
  );
}

export function SourceSelector() {
  const { source, setSource } = useSource();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const current = SOURCES.find((s) => s.key === source) ?? SOURCES[0];

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
        className="flex items-center gap-1.5 text-[var(--color-text-secondary)] hover:text-[var(--color-primary)] transition-colors text-sm"
      >
        <span className={current.accentClass}>{current.icon}</span>
        <span className="hidden sm:inline">{current.label}</span>
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
        <div className="absolute top-full right-0 mt-2 w-56 bg-white rounded-lg shadow-xl border border-[var(--color-border)] z-50 overflow-hidden py-1">
          <div className="px-3 py-2 border-b border-[var(--color-border)]">
            <span className="text-xs font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider">
              Nguồn truyện
            </span>
          </div>
          {SOURCES.map((s) => {
            const isActive = s.key === source;
            return (
              <button
                key={s.key}
                onClick={() => {
                  setSource(s.key);
                  setOpen(false);
                }}
                className={`w-full flex items-center gap-3 px-3 py-2.5 text-sm transition-colors ${
                  isActive
                    ? `${s.activeClass} border-l-2`
                    : "border-l-2 border-transparent hover:bg-gray-50"
                }`}
              >
                <span className={s.accentClass}>{s.icon}</span>
                <div className="flex flex-col items-start min-w-0">
                  <span
                    className={`font-medium ${isActive ? s.accentClass : "text-[var(--color-text)]"}`}
                  >
                    {s.label}
                  </span>
                  <span className="text-xs text-[var(--color-text-secondary)]">
                    {s.description}
                  </span>
                </div>
                {isActive && (
                  <span className={`ml-auto ${s.accentClass}`}>
                    <CheckIcon />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
