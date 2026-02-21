"use client";

import { cn } from "@/lib/utils";
import { useSource } from "./SourceContext";

export function SourceToggle() {
  const { source, toggle } = useSource();

  return (
    <label className="flex items-center gap-1.5 cursor-pointer select-none">
      <span
        className={cn(
          "text-xs font-bold transition-colors",
          source === "mtc"
            ? "text-[var(--color-primary)]"
            : "text-[var(--color-text-secondary)]"
        )}
      >
        MTC
      </span>
      <button
        role="switch"
        aria-checked={source === "ttv"}
        aria-label="Toggle book source"
        onClick={toggle}
        className={cn(
          "relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1",
          source === "ttv" ? "bg-emerald-500" : "bg-blue-500"
        )}
      >
        <span
          className={cn(
            "pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200",
            source === "ttv" ? "translate-x-4" : "translate-x-0"
          )}
        />
      </button>
      <span
        className={cn(
          "text-xs font-bold transition-colors",
          source === "ttv"
            ? "text-emerald-600"
            : "text-[var(--color-text-secondary)]"
        )}
      >
        TTV
      </span>
    </label>
  );
}
