import { NextResponse } from "next/server";
import { getGenresWithCounts } from "@/lib/queries";
import { logApi } from "@/lib/api-logger";

export async function GET(request: Request) {
  const t0 = performance.now();
  const genres = await getGenresWithCounts();
  logApi(request, 200, performance.now() - t0, { genres: genres.length });
  return NextResponse.json(genres);
}
