import { cookies } from "next/headers";
import type { BookSource } from "./queries";

export const SOURCE_COOKIE = "book_source";

const VALID_SOURCES: Set<string> = new Set(["mtc", "ttv", "tf"]);

export async function getSource(): Promise<BookSource> {
  const c = await cookies();
  const val = c.get(SOURCE_COOKIE)?.value;
  if (val && VALID_SOURCES.has(val)) return val as BookSource;
  return "mtc";
}
