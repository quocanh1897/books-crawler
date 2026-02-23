#!/usr/bin/env python3
"""
Batch download all bookmarked books.

Simple approach: for each bookmarked book, call the same search-based
flow that works in grab_book.py. Books not found in the app's search
are skipped gracefully.

Usage:
    python3 batch_grab.py              # download all pending
    python3 batch_grab.py --list       # just show the book list
    python3 batch_grab.py --limit 5    # download at most 5 books
"""
from __future__ import annotations

import argparse
import os
import sqlite3
import sys
import time

from grab_book import (
    pull_db, search_book_api, launch_app,
    ui_search_and_download,
    wait_for_download, extract_chapters,
    set_device,
)

OUTPUT_DIR = "output"


def get_bookmarked_books() -> list[dict]:
    """Get bookmarked books ordered by bookmarkId DESC (app display order)."""
    db_path = pull_db()
    conn = sqlite3.connect(db_path)
    rows = conn.execute("""
        SELECT id, name, latestIndex
        FROM BaseBook
        WHERE following = 1
        ORDER BY bookmarkId DESC
    """).fetchall()
    conn.close()
    return [{"id": r[0], "name": r[1], "latest_index": r[2] or 0} for r in rows]


def get_extracted_counts() -> dict[int, int]:
    """Return {book_id: txt_file_count} from output/."""
    counts = {}
    if not os.path.isdir(OUTPUT_DIR):
        return counts
    for name in os.listdir(OUTPUT_DIR):
        path = os.path.join(OUTPUT_DIR, name)
        if os.path.isdir(path):
            try:
                bid = int(name)
            except ValueError:
                continue
            counts[bid] = sum(1 for f in os.listdir(path)
                              if f.endswith(".txt") and f[0].isdigit())
    return counts


def print_book_list(books, extracted):
    print(f"\n{'#':>3}  {'ID':>7}  {'Chaps':>6}  {'Saved':>6}  Status    Name")
    print("-" * 80)
    for i, b in enumerate(books):
        bid = b["id"]
        latest = b["latest_index"]
        saved = extracted.get(bid, 0)
        status = "DONE" if saved >= latest and latest > 0 else "pending"
        print(f"{i:3d}  {bid:7d}  {latest:6d}  {saved:6d}  {status:<8s}  {b['name'][:45]}")
    done = sum(1 for b in books if extracted.get(b["id"], 0) >= b["latest_index"] > 0)
    print(f"\n  {done}/{len(books)} fully extracted")


def main():
    parser = argparse.ArgumentParser(description="Batch download bookmarked books")
    parser.add_argument("--list", action="store_true", help="List books and exit")
    parser.add_argument("--limit", type=int, default=0, help="Max books to download")
    parser.add_argument("--device", default="emulator-5554",
                        help="ADB device serial (default: emulator-5554)")
    args = parser.parse_args()

    set_device(args.device)

    print("=" * 60)
    print("  Batch Book Grabber")
    print("=" * 60)

    print("\n[1] Reading bookmarks from DB...")
    books = get_bookmarked_books()
    extracted = get_extracted_counts()
    print(f"  {len(books)} bookmarked books")

    if args.list:
        print_book_list(books, extracted)
        return

    # Filter to pending
    pending = []
    for b in books:
        if extracted.get(b["id"], 0) >= b["latest_index"] and b["latest_index"] > 0:
            continue
        pending.append(b)

    if not pending:
        print("  All books already downloaded!")
        return

    if args.limit > 0:
        pending = pending[:args.limit]

    # Pre-fetch chapter counts from API
    print(f"\n[2] Fetching chapter counts for {len(pending)} books...")
    for b in pending:
        api = search_book_api(b["name"])
        if api and api.get("chapter_count"):
            b["chapter_count"] = api["chapter_count"]
        else:
            b["chapter_count"] = b["latest_index"]
        time.sleep(0.3)

    print(f"\n[3] Downloading {len(pending)} books...\n")

    succeeded = 0
    failed = 0
    skipped_names = []

    for i, b in enumerate(pending):
        bid = b["id"]
        name = b["name"]
        ch = b["chapter_count"]

        print(f"\n{'='*60}")
        print(f"  [{i+1}/{len(pending)}] {name[:50]}")
        print(f"  ID={bid}, Chapters={ch}")
        print(f"{'='*60}")

        try:
            launch_app()
            ok = ui_search_and_download(name, ch)

            if not ok:
                print(f"  SKIP: Not found in app search")
                skipped_names.append(name)
                failed += 1
                continue

            # Verify download started
            time.sleep(10)
            conn = sqlite3.connect(pull_db())
            count = conn.execute(
                "SELECT COUNT(*) FROM Chapter WHERE bookId=?", (bid,)
            ).fetchone()[0]
            conn.close()
            print(f"  DB check: {count} chapters")

            if count == 0:
                print(f"  SKIP: Download didn't start")
                skipped_names.append(name)
                failed += 1
                continue

            # Wait + extract
            final = wait_for_download(bid, ch)
            saved = extract_chapters(bid, name)
            print(f"  Result: {saved}/{ch} chapters")
            succeeded += 1

        except Exception as e:
            print(f"  ERROR: {e}")
            skipped_names.append(name)
            failed += 1

    # Summary
    print(f"\n{'='*60}")
    print(f"  Batch complete: {succeeded} succeeded, {failed} failed")
    if skipped_names:
        print(f"  Skipped books:")
        for n in skipped_names:
            print(f"    - {n[:60]}")
    print(f"{'='*60}")


if __name__ == "__main__":
    main()
