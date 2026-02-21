import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { sqlite } from "@/db";

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ bookId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { bookId: bookIdStr } = await params;
  const bookId = parseInt(bookIdStr, 10);
  const userId = parseInt(session.user.id, 10);
  const { chapterIndex, progressPct } = await request.json();

  const now = new Date().toISOString();

  // Upsert reading progress
  sqlite
    .prepare(
      `INSERT INTO reading_progress (user_id, book_id, chapter_index, progress_pct, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, book_id)
       DO UPDATE SET chapter_index = excluded.chapter_index,
                     progress_pct = excluded.progress_pct,
                     updated_at = excluded.updated_at`
    )
    .run(userId, bookId, chapterIndex, progressPct || 0, now);

  // Add to reading history
  sqlite
    .prepare(
      "INSERT INTO reading_history (user_id, book_id, chapter_index, read_at) VALUES (?, ?, ?, ?)"
    )
    .run(userId, bookId, chapterIndex, now);

  return NextResponse.json({ success: true });
}
