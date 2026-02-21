import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";

const EPUB_OUTPUT_DIR =
  process.env.EPUB_OUTPUT_DIR || path.resolve(process.cwd(), "../epub-converter/epub-output");

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: idStr } = await params;
  const bookId = parseInt(idStr, 10);
  if (isNaN(bookId)) {
    return NextResponse.json({ error: "Invalid book ID" }, { status: 400 });
  }

  const dir = path.join(EPUB_OUTPUT_DIR, String(bookId));
  if (!fs.existsSync(dir)) {
    return NextResponse.json({ error: "EPUB not found" }, { status: 404 });
  }

  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".epub"));
  if (files.length === 0) {
    return NextResponse.json({ error: "EPUB not found" }, { status: 404 });
  }

  const epubPath = path.join(dir, files[0]);
  const buffer = fs.readFileSync(epubPath);
  const filename = files[0];

  return new NextResponse(buffer, {
    headers: {
      "Content-Type": "application/epub+zip",
      "Content-Disposition": `attachment; filename="${encodeURIComponent(filename)}"`,
      "Content-Length": String(buffer.length),
    },
  });
}
