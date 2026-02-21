"use client";

import Link from "next/link";
import { cn } from "@/lib/utils";
import { formatNumber } from "@/lib/utils";

interface BookDetailTabsProps {
  slug: string;
  activeTab: string;
  chapterCount: number;
}

export function BookDetailTabs({ slug, activeTab, chapterCount }: BookDetailTabsProps) {
  const tabs = [
    { id: "info", label: "Thông tin chi tiết", href: `/doc-truyen/${slug}` },
    {
      id: "chapters",
      label: `Danh sách chương (${formatNumber(chapterCount)} chương)`,
      href: `/doc-truyen/${slug}?tab=chapters`,
    },
  ];

  return (
    <div className="flex border border-[var(--color-border)] border-b-0 rounded-t-lg bg-white overflow-hidden">
      {tabs.map((tab) => (
        <Link
          key={tab.id}
          href={tab.href}
          className={cn(
            "px-5 py-3 text-sm font-medium border-b-2 transition-colors",
            activeTab === tab.id
              ? "border-[var(--color-primary)] text-[var(--color-primary)] bg-white"
              : "border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:bg-gray-50"
          )}
        >
          {tab.label}
        </Link>
      ))}
    </div>
  );
}
