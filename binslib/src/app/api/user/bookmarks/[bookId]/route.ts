import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { sqlite } from "@/db";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ bookId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { bookId: bookIdStr } = await params;
  const bookId = parseInt(bookIdStr, 10);
  const userId = parseInt(session.user.id, 10);

  // Toggle: if exists, remove; otherwise, add
  const existing = sqlite
    .prepare("SELECT 1 FROM user_bookmarks WHERE user_id = ? AND book_id = ?")
    .get(userId, bookId);

  if (existing) {
    sqlite
      .prepare("DELETE FROM user_bookmarks WHERE user_id = ? AND book_id = ?")
      .run(userId, bookId);
    return NextResponse.json({ bookmarked: false });
  } else {
    sqlite
      .prepare("INSERT INTO user_bookmarks (user_id, book_id, created_at) VALUES (?, ?, ?)")
      .run(userId, bookId, new Date().toISOString());
    return NextResponse.json({ bookmarked: true });
  }
}
