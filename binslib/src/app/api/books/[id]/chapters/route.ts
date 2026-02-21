import { NextResponse } from "next/server";
import { getAllChapterTitles } from "@/lib/queries";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const bookId = parseInt(id, 10);
  if (isNaN(bookId)) {
    return NextResponse.json({ error: "Invalid book ID" }, { status: 400 });
  }

  const chapters = getAllChapterTitles(bookId);
  return NextResponse.json(chapters);
}
