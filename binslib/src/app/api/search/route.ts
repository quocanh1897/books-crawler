import { NextRequest, NextResponse } from "next/server";
import { searchBooks } from "@/lib/queries";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const q = searchParams.get("q") || "";
  const limit = Math.min(parseInt(searchParams.get("limit") || "10", 10), 50);

  if (q.length < 2) {
    return NextResponse.json({ results: [] });
  }

  const ftsQuery = q.split(/\s+/).map(w => `"${w}"`).join(" ");

  try {
    const results = searchBooks(ftsQuery, limit);
    return NextResponse.json({ results });
  } catch {
    return NextResponse.json({ results: [], error: "Search failed" });
  }
}
