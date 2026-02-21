import { NextRequest, NextResponse } from "next/server";
import { hashSync } from "bcryptjs";
import { sqlite } from "@/db";

export async function POST(request: NextRequest) {
  try {
    const { email, username, password } = await request.json();

    if (!email || !username || !password) {
      return NextResponse.json(
        { error: "Email, username, and password are required" },
        { status: 400 }
      );
    }

    if (password.length < 6) {
      return NextResponse.json(
        { error: "Password must be at least 6 characters" },
        { status: 400 }
      );
    }

    // Check if email or username already exists
    const existing = sqlite
      .prepare("SELECT id FROM users WHERE email = ? OR username = ?")
      .get(email, username);

    if (existing) {
      return NextResponse.json(
        { error: "Email or username already exists" },
        { status: 409 }
      );
    }

    const passwordHash = hashSync(password, 12);
    const now = new Date().toISOString();

    const result = sqlite
      .prepare(
        "INSERT INTO users (email, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
      )
      .run(email, username, passwordHash, now, now);

    return NextResponse.json({
      id: result.lastInsertRowid,
      email,
      username,
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Registration failed" },
      { status: 500 }
    );
  }
}
