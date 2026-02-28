import { NextRequest, NextResponse } from "next/server";
import { getRankedBooks, getRankedBooksPaginated } from "@/lib/queries";
import type { RankingMetric } from "@/types";
import { logApi } from "@/lib/api-logger";

const VALID_METRICS: RankingMetric[] = [
  "vote_count",
  "view_count",
  "comment_count",
  "bookmark_count",
  "review_score",
  "review_count",
];

export async function GET(request: NextRequest) {
  const t0 = performance.now();
  const { searchParams } = new URL(request.url);
  const metric = (
    VALID_METRICS.includes(searchParams.get("metric") as RankingMetric)
      ? searchParams.get("metric")
      : "view_count"
  ) as RankingMetric;
  const genre = searchParams.get("genre") || undefined;
  const status = searchParams.get("status")
    ? parseInt(searchParams.get("status")!, 10)
    : undefined;
  const limit = Math.min(parseInt(searchParams.get("limit") || "50", 10), 100);
  const page = searchParams.has("page")
    ? Math.max(1, parseInt(searchParams.get("page")!, 10))
    : undefined;

  if (page !== undefined) {
    const result = await getRankedBooksPaginated(
      metric,
      page,
      limit,
      genre,
      status,
    );
    logApi(request, 200, performance.now() - t0, {
      metric,
      page,
      genre: genre ?? "-",
      status: status ?? "-",
      results: result.data.length,
      total: result.total,
    });
    return NextResponse.json(result);
  }

  const books = await getRankedBooks(metric, limit, genre, status);
  logApi(request, 200, performance.now() - t0, {
    metric,
    genre: genre ?? "-",
    status: status ?? "-",
    results: books.length,
  });
  return NextResponse.json(books);
}
