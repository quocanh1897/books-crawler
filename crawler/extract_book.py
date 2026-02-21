#!/usr/bin/env python3
"""
Extract decrypted chapters from the app's SQLite database after manual download.

Usage:
    1. In the emulator, manually trigger download via:
       3-dot → Tải truyện → enter range → Đồng ý
    2. Run this script to monitor progress and extract when done:
       python3 extract_book.py <book_id> [total_chapters]

The script monitors the DB and extracts chapters as they download.
"""
from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import sys
import time

ADB = os.path.expanduser("~/Library/Android/sdk/platform-tools/adb")
DEVICE = "emulator-5554"
PACKAGE = "com.novelfever.app.android.debug"
OUTPUT_DIR = "output"


def pull_db() -> str:
    db_path = "/tmp/mtc_extract.db"
    data = subprocess.run(
        [ADB, "-s", DEVICE, "shell", f"run-as {PACKAGE} cat databases/app_database.db"],
        capture_output=True, timeout=30,
    ).stdout
    with open(db_path, "wb") as f:
        f.write(data)
    return db_path


def get_chapter_count(db_path: str, book_id: int) -> int:
    conn = sqlite3.connect(db_path)
    count = conn.execute("SELECT COUNT(*) FROM Chapter WHERE bookId=?", (book_id,)).fetchone()[0]
    conn.close()
    return count


def extract_chapters(db_path: str, book_id: int, output_dir: str) -> int:
    os.makedirs(output_dir, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT * FROM Chapter WHERE bookId=? ORDER BY `index`", (book_id,)
    ).fetchall()
    conn.close()

    saved = 0
    for row in rows:
        idx = row["index"] or row["id"]
        slug = row["slug"] or f"chapter-{idx}"
        name = row["name"] or f"Chapter {idx}"
        content = row["content"] or ""
        if len(content) < 10:
            continue
        filename = f"{idx:04d}_{slug}.txt"
        with open(os.path.join(output_dir, filename), "w", encoding="utf-8") as f:
            f.write(f"{name}\n\n{content}")
        saved += 1

    meta = {"book_id": book_id, "chapters_saved": saved, "total_in_db": len(rows)}
    with open(os.path.join(output_dir, "book.json"), "w") as f:
        json.dump(meta, f, indent=2, ensure_ascii=False)

    return saved


def main():
    if len(sys.argv) < 2:
        print("Usage: python3 extract_book.py <book_id> [total_chapters]")
        print("  Monitors DB and extracts chapters after manual download trigger.")
        sys.exit(1)

    book_id = int(sys.argv[1])
    total = int(sys.argv[2]) if len(sys.argv) > 2 else 0
    output_dir = os.path.join(OUTPUT_DIR, str(book_id))

    print(f"Monitoring download for book {book_id}...")
    if total:
        print(f"Expected: {total} chapters")
    print(f"Output: {output_dir}/")
    print(f"Trigger the download in the emulator now!\n")

    last_count = 0
    stale_rounds = 0
    while True:
        try:
            db_path = pull_db()
            count = get_chapter_count(db_path, book_id)
        except Exception:
            time.sleep(5)
            continue

        if count != last_count:
            pct = f" ({count*100//total}%)" if total else ""
            print(f"  {count}{f'/{total}' if total else ''} chapters{pct}")
            stale_rounds = 0
            last_count = count
        else:
            stale_rounds += 1

        if total and count >= total:
            print(f"\nDownload complete!")
            break

        if stale_rounds > 30:  # 5 min no progress
            print(f"\nNo new chapters for 5 min. Extracting {count} chapters...")
            break

        time.sleep(10)

    # Extract
    saved = extract_chapters(db_path, book_id, output_dir)
    print(f"Extracted {saved} chapters to {output_dir}/")


if __name__ == "__main__":
    main()
