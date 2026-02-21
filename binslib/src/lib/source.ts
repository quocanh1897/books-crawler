import { cookies } from "next/headers";
import type { BookSource } from "./queries";

export const SOURCE_COOKIE = "book_source";

export async function getSource(): Promise<BookSource> {
  const c = await cookies();
  const val = c.get(SOURCE_COOKIE)?.value;
  return val === "ttv" ? "ttv" : "mtc";
}
