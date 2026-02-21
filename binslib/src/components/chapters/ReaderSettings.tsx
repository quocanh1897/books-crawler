"use client";

import { useState, useEffect, useRef } from "react";

const THEMES = [
  { id: "light", bg: "#ffffff", text: "#333333", label: "Sáng", border: "#e5e5e5" },
  { id: "sepia", bg: "#f5eed9", text: "#5b4636", label: "Giấy", border: "#ddd0b1" },
  { id: "green", bg: "#c7edcc", text: "#2d4a2e", label: "Xanh", border: "#a3d4a8" },
  { id: "blue", bg: "#d6e8f5", text: "#2a3a4a", label: "Biển", border: "#b0cfe0" },
  { id: "gray", bg: "#e8e8e8", text: "#333333", label: "Xám", border: "#cccccc" },
  { id: "dark", bg: "#1a1a2e", text: "#c8c8c8", label: "Tối", border: "#2a2a3e" },
];

const FONTS = [
  { id: "palatino", label: "Palatino", family: "'Palatino Linotype', 'Book Antiqua', Palatino, serif" },
  { id: "times", label: "Times", family: "'Times New Roman', Times, serif" },
  { id: "arial", label: "Arial", family: "Arial, Helvetica, sans-serif" },
  { id: "georgia", label: "Georgia", family: "Georgia, 'Times New Roman', serif" },
  { id: "noto-serif", label: "Noto Serif", family: "'Noto Serif', Georgia, serif" },
];

const MIN_SIZE = 14;
const MAX_SIZE = 36;
const MIN_WIDTH = 600;
const MAX_WIDTH = 1200;
const WIDTH_STEP = 50;

interface ReaderConfig {
  theme: string;
  font: string;
  fontSize: number;
  maxWidth: number;
}

const STORAGE_KEY = "binslib-reader-settings";

function loadConfig(): ReaderConfig {
  if (typeof window === "undefined") {
    return { theme: "light", font: "georgia", fontSize: 18, maxWidth: 800 };
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return { theme: "light", font: "georgia", fontSize: 18, maxWidth: 800 };
}

function saveConfig(config: ReaderConfig) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch { /* ignore */ }
}

export function useReaderConfig() {
  const [config, setConfig] = useState<ReaderConfig>(() => loadConfig());
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setConfig(loadConfig());
    setHydrated(true);
  }, []);

  const update = (partial: Partial<ReaderConfig>) => {
    setConfig((prev) => {
      const next = { ...prev, ...partial };
      saveConfig(next);
      return next;
    });
  };

  return { config, update, hydrated };
}

export function getTheme(id: string) {
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}

export function getFontFamily(id: string) {
  return FONTS.find((f) => f.id === id)?.family ?? FONTS[3].family;
}

interface ReaderSettingsProps {
  config: ReaderConfig;
  onUpdate: (partial: Partial<ReaderConfig>) => void;
}

export function ReaderSettingsButton({ config, onUpdate }: ReaderSettingsProps) {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function handleEsc(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    if (open) {
      document.addEventListener("mousedown", handleClick);
      document.addEventListener("keydown", handleEsc);
    }
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleEsc);
    };
  }, [open]);

  const theme = getTheme(config.theme);

  return (
    <div ref={panelRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="p-2 rounded-lg border transition-colors hover:bg-gray-100"
        style={{ borderColor: theme.border }}
        title="Tuỳ chỉnh"
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
      </button>

      {open && (
        <div
          className="absolute right-0 top-full mt-2 w-80 rounded-lg shadow-xl border z-50 p-5 space-y-5"
          style={{ backgroundColor: theme.bg, borderColor: theme.border, color: theme.text }}
        >
          <div className="flex items-center justify-between">
            <h3 className="font-bold text-base" style={{ color: theme.text }}>Tuỳ chỉnh</h3>
            <button onClick={() => setOpen(false)} className="p-1 rounded hover:opacity-70">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Theme */}
          <div>
            <label className="text-xs font-medium opacity-70 block mb-2">Theme</label>
            <div className="flex gap-2.5">
              {THEMES.map((t) => (
                <button
                  key={t.id}
                  onClick={() => onUpdate({ theme: t.id })}
                  className="w-8 h-8 rounded-full border-2 transition-all flex items-center justify-center"
                  style={{
                    backgroundColor: t.bg,
                    borderColor: config.theme === t.id ? "#c9302c" : t.border,
                  }}
                  title={t.label}
                >
                  {config.theme === t.id && (
                    <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="#c9302c">
                      <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                    </svg>
                  )}
                </button>
              ))}
            </div>
          </div>

          {/* Font */}
          <div>
            <label className="text-xs font-medium opacity-70 block mb-2">Font chữ</label>
            <div className="flex flex-wrap gap-1.5">
              {FONTS.map((f) => (
                <button
                  key={f.id}
                  onClick={() => onUpdate({ font: f.id })}
                  className="px-3 py-1.5 text-sm border rounded transition-all"
                  style={{
                    fontFamily: f.family,
                    borderColor: config.font === f.id ? "#c9302c" : theme.border,
                    color: config.font === f.id ? "#c9302c" : theme.text,
                  }}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          {/* Font size */}
          <div>
            <label className="text-xs font-medium opacity-70 block mb-2">Cỡ chữ</label>
            <div className="flex items-center gap-3">
              <button
                onClick={() => onUpdate({ fontSize: Math.max(MIN_SIZE, config.fontSize - 2) })}
                className="px-3 py-1.5 text-sm border rounded hover:opacity-70 transition-all"
                style={{ borderColor: theme.border }}
              >
                A-
              </button>
              <span className="flex-1 text-center font-medium text-base">{config.fontSize}</span>
              <button
                onClick={() => onUpdate({ fontSize: Math.min(MAX_SIZE, config.fontSize + 2) })}
                className="px-3 py-1.5 text-sm border rounded hover:opacity-70 transition-all"
                style={{ borderColor: theme.border }}
              >
                A+
              </button>
            </div>
          </div>

          {/* Max width */}
          <div>
            <label className="text-xs font-medium opacity-70 block mb-2">Màn hình</label>
            <div className="flex items-center gap-3">
              <button
                onClick={() => onUpdate({ maxWidth: Math.max(MIN_WIDTH, config.maxWidth - WIDTH_STEP) })}
                className="px-2.5 py-1.5 text-sm border rounded hover:opacity-70 transition-all"
                style={{ borderColor: theme.border }}
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 9V4.5M9 9H4.5M9 9L3.75 3.75M9 15v4.5M9 15H4.5M9 15l-5.25 5.25M15 9h4.5M15 9V4.5M15 9l5.25-5.25M15 15h4.5M15 15v4.5m0-4.5l5.25 5.25" />
                </svg>
              </button>
              <span className="flex-1 text-center font-medium text-base">{config.maxWidth}</span>
              <button
                onClick={() => onUpdate({ maxWidth: Math.min(MAX_WIDTH, config.maxWidth + WIDTH_STEP) })}
                className="px-2.5 py-1.5 text-sm border rounded hover:opacity-70 transition-all"
                style={{ borderColor: theme.border }}
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
