import { NextRequest, NextResponse } from "next/server";
import { getRankedBooks } from "@/lib/queries";
import type { RankingMetric } from "@/types";

const VALID_METRICS: RankingMetric[] = ["view_count", "comment_count", "bookmark_count", "review_score"];

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const metric = (VALID_METRICS.includes(searchParams.get("metric") as RankingMetric)
    ? searchParams.get("metric")
    : "view_count") as RankingMetric;
  const genre = searchParams.get("genre") || undefined;
  const status = searchParams.get("status") ? parseInt(searchParams.get("status")!, 10) : undefined;
  const limit = Math.min(parseInt(searchParams.get("limit") || "50", 10), 100);

  const books = await getRankedBooks(metric, limit, genre, status);
  return NextResponse.json(books);
}
