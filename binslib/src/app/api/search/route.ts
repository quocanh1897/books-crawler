import { NextRequest, NextResponse } from "next/server";
import { searchBooks, searchAuthors } from "@/lib/queries";
import type { BookSource } from "@/lib/queries";
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
  return (
    q
      // Strip FTS5 operator characters
      .replace(/[\u201C\u201D\u2018\u2019"'()*^:]/g, "")
      // Normalize đ/Đ → d/D to match the FTS index which applies the
      // same substitution.  The unicode61 tokenizer's remove_diacritics
      // does NOT handle the Vietnamese đ (d-with-stroke) because the
      // stroke is a letter variant, not a combining diacritic mark.
      .replace(/đ/g, "d")
      .replace(/Đ/g, "D")
      .split(/\s+/)
      .filter((w) => w.length > 0)
      .map((w) => `"${w}"`)
      .join(" ")
  );
}

/**
 * Resolve the source filter from the request.
 *
 * Priority:
 *   1. Explicit `source` query parameter (`mtc`, `ttv`, `all`)
 *   2. `book_source` cookie (used by the web UI)
 *
 * `all` (or any unrecognised value) disables the source filter so results
 * span every source — this is what the vbook-extension uses.
 */
async function resolveSource(
  searchParams: URLSearchParams,
): Promise<BookSource | undefined> {
  const explicit = searchParams.get("source");
  if (explicit) {
    if (explicit === "mtc" || explicit === "ttv") return explicit;
    // "all" or anything else → no filter
    return undefined;
  }
  // No explicit param — fall back to cookie (web UI behaviour)
  return await getSource();
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
  const source = await resolveSource(searchParams);

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
