import { cn } from "@/lib/utils";
import { STATUS_LABELS, STATUS_COLORS } from "@/types";

export function StatusBadge({ status }: { status: number }) {
  return (
    <span
      className={cn(
        "inline-block px-2 py-0.5 text-xs font-medium rounded border",
        STATUS_COLORS[status] || "text-gray-600 bg-gray-50 border-gray-200"
      )}
    >
      {STATUS_LABELS[status] || "Unknown"}
    </span>
  );
}
