#!/usr/bin/env python3
"""Repair chapter titles in the binslib DB.

The old import.ts extracted chapter titles from the *body text* stored in
bundles (first non-empty line), which produced wrong titles like "đau"
instead of the correct API name "Chương 1: ửng đỏ".

This script:
  1. Finds books whose chapter titles don't match the expected "Chương …"
     format (or optionally, ALL books with --full).
  2. Fetches the correct titles from the bulk chapters API in a single
     request per book:  GET /api/chapters?filter[book_id]=X
  3. Batch-updates the DB rows.

Usage:
    cd book-ingest
    python3 repair_titles.py                    # fix books with bad titles
    python3 repair_titles.py --full             # re-sync ALL chapter titles
    python3 repair_titles.py --book-ids 101380 101037
    python3 repair_titles.py --dry-run          # preview without writing
    python3 repair_titles.py --workers 20       # parallel API requests
"""

from __future__ import annotations

import argparse
import os
import sqlite3
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import httpx

# ── API config ────────────────────────────────────────────────────────────────

BASE_URL = "https://android.lonoapp.net"
BEARER_TOKEN = os.environ.get(
    "MTC_BEARER_TOKEN",
    "7045826|W0GmBOqfeWO0wWZUD7QpikPjvMsP1tq7Ayjq48pX",
)
HEADERS = {
    "authorization": f"Bearer {BEARER_TOKEN}",
    "x-app": "app.android",
    "user-agent": "Dart/3.5 (dart:io)",
    "content-type": "application/json",
}

DEFAULT_DB_PATH = os.path.join(
    os.path.dirname(__file__), "..", "binslib", "data", "binslib.db"
)

# ── Helpers ───────────────────────────────────────────────────────────────────


def open_db(db_path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def fetch_chapter_titles(
    client: httpx.Client,
    book_id: int,
    retries: int = 3,
) -> list[dict] | None:
    """Fetch ALL chapter titles for a book in a single API call.

    Returns a list of dicts with keys: id, name, index.
    Returns None on failure.
    """
    for attempt in range(retries):
        try:
            r = client.get(
                f"{BASE_URL}/api/chapters",
                params={"filter[book_id]": book_id, "limit": 100000},
                timeout=60,
            )
        except httpx.TransportError as e:
            if attempt < retries - 1:
                time.sleep(2 ** (attempt + 1))
                continue
            print(f"  ✗ {book_id}: transport error — {e}", file=sys.stderr)
            return None

        if r.status_code == 429:
            wait = int(r.headers.get("Retry-After", 2 ** (attempt + 2)))
            if attempt < retries - 1:
                time.sleep(wait)
                continue
            print(f"  ✗ {book_id}: rate limited", file=sys.stderr)
            return None

        if r.status_code == 404:
            return None

        if r.status_code != 200:
            if attempt < retries - 1:
                time.sleep(2 ** (attempt + 1))
                continue
            print(
                f"  ✗ {book_id}: HTTP {r.status_code}",
                file=sys.stderr,
            )
            return None

        data = r.json()
        if not data.get("success"):
            print(f"  ✗ {book_id}: API error — {data}", file=sys.stderr)
            return None

        chapters = data.get("data")
        if not isinstance(chapters, list):
            print(
                f"  ✗ {book_id}: unexpected data type {type(chapters)}",
                file=sys.stderr,
            )
            return None

        return chapters

    return None


def get_books_with_bad_titles(conn: sqlite3.Connection) -> list[tuple[int, str, int]]:
    """Return (book_id, book_name, bad_chapter_count) for books with wrong titles."""
    cur = conn.execute(
        """
        SELECT b.id, b.name, COUNT(*) AS bad_count
        FROM chapters c
        JOIN books b ON b.id = c.book_id
        WHERE c.title NOT LIKE 'Chương %'
        GROUP BY b.id
        ORDER BY bad_count DESC
        """
    )
    return [(row[0], row[1], row[2]) for row in cur]


def get_all_books_with_chapters(conn: sqlite3.Connection) -> list[tuple[int, str, int]]:
    """Return (book_id, book_name, chapter_count) for ALL books."""
    cur = conn.execute(
        """
        SELECT b.id, b.name, COUNT(*) AS ch_count
        FROM chapters c
        JOIN books b ON b.id = c.book_id
        GROUP BY b.id
        ORDER BY ch_count DESC
        """
    )
    return [(row[0], row[1], row[2]) for row in cur]


def get_specific_books(
    conn: sqlite3.Connection, book_ids: list[int]
) -> list[tuple[int, str, int]]:
    """Return (book_id, book_name, chapter_count) for specific book IDs."""
    placeholders = ",".join("?" for _ in book_ids)
    cur = conn.execute(
        f"""
        SELECT b.id, b.name, COUNT(*) AS ch_count
        FROM chapters c
        JOIN books b ON b.id = c.book_id
        WHERE b.id IN ({placeholders})
        GROUP BY b.id
        """,
        book_ids,
    )
    return [(row[0], row[1], row[2]) for row in cur]


def slugify(text: str) -> str:
    """Vietnamese-aware slugification (matching import.ts / db.py)."""
    import re

    fr = "àáảãạăắằẳẵặâấầẩẫậèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵđ"
    to = "aaaaaaaaaaaaaaaaaeeeeeeeeeeeiiiiiooooooooooooooooouuuuuuuuuuuyyyyyd"
    slug = text.lower().strip()
    for i, c in enumerate(fr):
        slug = slug.replace(c, to[i])
    slug = re.sub(r"[^a-z0-9\s-]", "", slug)
    slug = re.sub(r"[\s-]+", "-", slug)
    slug = slug.strip("-")
    return slug


# ── Core repair ───────────────────────────────────────────────────────────────


def repair_book(
    client: httpx.Client,
    conn: sqlite3.Connection,
    book_id: int,
    book_name: str,
    dry_run: bool,
) -> dict:
    """Repair chapter titles for a single book.

    Returns stats dict: {updated, skipped, api_chapters, errors}.
    """
    stats = {"updated": 0, "skipped": 0, "api_chapters": 0, "errors": 0}

    api_chapters = fetch_chapter_titles(client, book_id)
    if api_chapters is None:
        stats["errors"] = 1
        return stats

    stats["api_chapters"] = len(api_chapters)

    # Build a map: index -> (name, slug) from the API
    api_map: dict[int, tuple[str, str]] = {}
    for ch in api_chapters:
        idx = ch.get("index")
        name = ch.get("name", "")
        if idx is not None and name:
            # The API doesn't return slug in the bulk listing; derive it.
            slug = ch.get("slug") or slugify(name)
            api_map[idx] = (name, slug)

    if not api_map:
        return stats

    # Read current DB titles for this book
    cur = conn.execute(
        "SELECT index_num, title, slug FROM chapters WHERE book_id = ?",
        (book_id,),
    )
    db_rows = {row[0]: (row[1], row[2]) for row in cur}

    # Find chapters that need updating
    updates: list[tuple[str, str, int, int]] = []  # (title, slug, book_id, index_num)
    for idx, (api_title, api_slug) in api_map.items():
        if idx not in db_rows:
            continue
        db_title, db_slug = db_rows[idx]
        if db_title == api_title:
            stats["skipped"] += 1
            continue
        updates.append((api_title, api_slug, book_id, idx))

    if not updates and not dry_run:
        stats["skipped"] = len(db_rows)
        return stats

    if dry_run:
        stats["updated"] = len(updates)
        stats["skipped"] = len(db_rows) - len(updates)
        return stats

    # Batch update in a transaction
    conn.execute("BEGIN")
    try:
        conn.executemany(
            "UPDATE chapters SET title = ?, slug = ? WHERE book_id = ? AND index_num = ?",
            updates,
        )
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise

    stats["updated"] = len(updates)
    stats["skipped"] = len(db_rows) - len(updates)
    return stats


def run_repair(
    db_path: str,
    full: bool,
    book_ids: list[int] | None,
    dry_run: bool,
    workers: int,
    request_delay: float,
) -> None:
    conn = open_db(db_path)

    # Determine which books to repair
    if book_ids:
        books = get_specific_books(conn, book_ids)
        mode = f"{len(books)} specific books"
    elif full:
        books = get_all_books_with_chapters(conn)
        mode = f"ALL {len(books)} books (--full)"
    else:
        books = get_books_with_bad_titles(conn)
        mode = f"{len(books)} books with bad titles"

    if not books:
        print("No books to repair.")
        conn.close()
        return

    total_chapters_in_scope = sum(c for _, _, c in books)
    print(f"Repair mode: {mode}")
    print(f"Chapters in scope: {total_chapters_in_scope:,}")
    if dry_run:
        print("DRY RUN — no changes will be written")
    print()

    total_updated = 0
    total_skipped = 0
    total_errors = 0
    start_time = time.time()

    if workers <= 1:
        # Sequential mode — simpler for debugging / small batches
        with httpx.Client(headers=HEADERS, timeout=60) as client:
            for i, (bid, bname, bcount) in enumerate(books):
                stats = repair_book(client, conn, bid, bname, dry_run)
                total_updated += stats["updated"]
                total_skipped += stats["skipped"]
                total_errors += stats["errors"]

                marker = "✓" if stats["errors"] == 0 else "✗"
                detail = (
                    f"+{stats['updated']}"
                    if stats["updated"] > 0
                    else "ok"
                    if stats["errors"] == 0
                    else "ERR"
                )
                elapsed = time.time() - start_time
                rate = (i + 1) / elapsed if elapsed > 0 else 0
                eta = (len(books) - i - 1) / rate if rate > 0 else 0

                print(
                    f'  [{i + 1}/{len(books)}] {marker} {bid} "{bname[:40]}" '
                    f"— {detail} ({stats['api_chapters']} api ch) "
                    f"[{rate:.1f} books/s, ETA {eta:.0f}s]"
                )

                if request_delay > 0:
                    time.sleep(request_delay)
    else:
        # Parallel mode — fetch from API in threads, write to DB sequentially
        results: dict[int, tuple[str, list[dict] | None]] = {}

        def _fetch(bid: int, bname: str) -> tuple[int, str, list[dict] | None]:
            with httpx.Client(headers=HEADERS, timeout=60) as client:
                chapters = fetch_chapter_titles(client, bid)
            if request_delay > 0:
                time.sleep(request_delay)
            return bid, bname, chapters

        with ThreadPoolExecutor(max_workers=workers) as pool:
            futures = {
                pool.submit(_fetch, bid, bname): (bid, bname, bcount)
                for bid, bname, bcount in books
            }

            done_count = 0
            for future in as_completed(futures):
                bid, bname, bcount = futures[future]
                done_count += 1

                try:
                    _, _, api_chapters = future.result()
                except Exception as e:
                    print(
                        f'  [{done_count}/{len(books)}] ✗ {bid} "{bname[:40]}" — exception: {e}',
                        file=sys.stderr,
                    )
                    total_errors += 1
                    continue

                results[bid] = (bname, api_chapters)

                elapsed = time.time() - start_time
                rate = done_count / elapsed if elapsed > 0 else 0
                eta = (len(books) - done_count) / rate if rate > 0 else 0
                print(
                    f"  [fetch {done_count}/{len(books)}] {bid} "
                    f"— {len(api_chapters) if api_chapters else 'ERR'} chapters "
                    f"[{rate:.1f}/s, ETA {eta:.0f}s]"
                )

        # Now apply updates sequentially (SQLite doesn't like concurrent writes)
        print(f"\nApplying updates for {len(results)} books...")
        apply_count = 0
        for bid, (bname, api_chapters) in results.items():
            apply_count += 1
            if api_chapters is None:
                total_errors += 1
                continue

            api_map: dict[int, tuple[str, str]] = {}
            for ch in api_chapters:
                idx = ch.get("index")
                name = ch.get("name", "")
                if idx is not None and name:
                    slug = ch.get("slug") or slugify(name)
                    api_map[idx] = (name, slug)

            cur = conn.execute(
                "SELECT index_num, title FROM chapters WHERE book_id = ?",
                (bid,),
            )
            db_rows = {row[0]: row[1] for row in cur}

            updates: list[tuple[str, str, int, int]] = []
            for idx, (api_title, api_slug) in api_map.items():
                if idx not in db_rows:
                    continue
                if db_rows[idx] == api_title:
                    continue
                updates.append((api_title, api_slug, bid, idx))

            if updates and not dry_run:
                conn.execute("BEGIN")
                try:
                    conn.executemany(
                        "UPDATE chapters SET title = ?, slug = ? WHERE book_id = ? AND index_num = ?",
                        updates,
                    )
                    conn.execute("COMMIT")
                except Exception:
                    conn.execute("ROLLBACK")
                    raise

            total_updated += len(updates)
            total_skipped += len(db_rows) - len(updates)

            if apply_count % 500 == 0 or apply_count == len(results):
                print(f"  ... applied {apply_count}/{len(results)} books")

    elapsed = time.time() - start_time
    conn.close()

    print()
    print("=" * 60)
    print(f"  Books processed : {len(books):>10,}")
    print(f"  Chapters updated: {total_updated:>10,}")
    print(f"  Chapters skipped: {total_skipped:>10,}")
    print(f"  API errors      : {total_errors:>10,}")
    print(f"  Duration        : {elapsed:>10.1f}s")
    if elapsed > 0:
        print(f"  Rate            : {len(books) / elapsed:>10.1f} books/s")
    print("=" * 60)

    if dry_run:
        print("\nDRY RUN complete — no changes were written.")
        print("Run without --dry-run to apply fixes.")


# ── CLI ───────────────────────────────────────────────────────────────────────


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Repair chapter titles from the MTC API",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "--db",
        default=os.environ.get("DATABASE_PATH", DEFAULT_DB_PATH),
        help="Path to binslib.db (default: %(default)s)",
    )
    parser.add_argument(
        "--full",
        action="store_true",
        help="Re-sync titles for ALL books, not just those with bad titles",
    )
    parser.add_argument(
        "--book-ids",
        nargs="+",
        type=int,
        help="Repair only these specific book IDs",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Preview changes without writing to the DB",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=1,
        help="Number of parallel API workers (default: 1)",
    )
    parser.add_argument(
        "--delay",
        type=float,
        default=0.02,
        help="Delay between API requests in seconds (default: 0.02)",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    db_path = os.path.abspath(args.db)
    if not os.path.isfile(db_path):
        print(f"Database not found: {db_path}", file=sys.stderr)
        sys.exit(1)

    print(f"Database: {db_path}")
    print()

    run_repair(
        db_path=db_path,
        full=args.full,
        book_ids=args.book_ids,
        dry_run=args.dry_run,
        workers=args.workers,
        request_delay=args.delay,
    )


if __name__ == "__main__":
    main()
