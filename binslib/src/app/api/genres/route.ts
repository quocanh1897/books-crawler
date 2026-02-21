import { NextResponse } from "next/server";
import { getGenresWithCounts } from "@/lib/queries";

export async function GET() {
  const genres = await getGenresWithCounts();
  return NextResponse.json(genres);
}
