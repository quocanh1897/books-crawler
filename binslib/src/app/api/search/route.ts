import { NextRequest, NextResponse } from "next/server";
import { searchBooks, searchAuthors } from "@/lib/queries";
import { getSource } from "@/lib/source";

/**
 * Sanitize user input into a valid FTS5 query.
 *
 * Strips characters that are FTS5 operators or could break syntax
 * (smart quotes, parens, asterisks, carets, colons), then wraps
 * each remaining word in double quotes for exact-token matching.
 *
 * Must stay in sync with the search page (tim-kiem/page.tsx).
 */
function buildFtsQuery(q: string): string {
  return q
    .replace(/[\u201C\u201D\u2018\u2019"'()*^:]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .map((w) => `"${w}"`)
    .join(" ");
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const q = (searchParams.get("q") || "").trim();
  const scope = searchParams.get("scope") || "books";
  const limit = Math.min(
    Math.max(1, parseInt(searchParams.get("limit") || "20", 10) || 20),
    50,
  );
  const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10) || 1);
  const offset = (page - 1) * limit;
  const source = await getSource();

  if (q.length < 2) {
    return NextResponse.json({ results: [] });
  }

  if (scope === "authors") {
    try {
      const results = searchAuthors(q, limit);
      return NextResponse.json({ results });
    } catch {
      return NextResponse.json({ results: [], error: "Author search failed" });
    }
  }

  // Default: scope === "books"
  const ftsQuery = buildFtsQuery(q);
  if (!ftsQuery) {
    return NextResponse.json({ results: [] });
  }

  try {
    const results = searchBooks(ftsQuery, limit, offset, source);
    return NextResponse.json({ results });
  } catch {
    return NextResponse.json({ results: [], error: "Search failed" });
  }
}
