#!/usr/bin/env python3
"""Repair missing chapter rows in SQLite for books that have bundles on disk.

Problem: Many MTC books have fully-downloaded .bundle files but 0 chapter rows
in the database.  This happened because the bundle metadata (v2) was written
with empty titles/slugs/chapter_ids, and the recovery code in ingest.py
filtered them out with ``if ... and m.title``.

Strategy:
  1. Find all books where the DB has fewer chapter rows than the bundle has
     entries (for a given source, default mtc).
  2. For each such book, read the bundle index to get chapter indices.
  3. Insert placeholder chapter rows for every index missing from the DB.
     - Title:  "Chương {index}" (matches the app's fallback display)
     - Slug:   "chuong-{index}"
     - word_count / chapter_id: from bundle metadata if available, else 0.
  4. Update books.chapters_saved to reflect the bundle size.

This is a DB-only repair — it does NOT re-download anything.

Usage:
    python3 repair_missing_chapters.py                  # repair all mtc books
    python3 repair_missing_chapters.py --source ttv     # repair ttv books
    python3 repair_missing_chapters.py --dry-run        # preview without writing
    python3 repair_missing_chapters.py 151943 151934    # specific book IDs only
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

# Ensure project imports work
sys.path.insert(0, str(Path(__file__).resolve().parent))

from src.bundle import read_bundle_indices, read_bundle_meta
from src.db import open_db, slugify

# ── Paths (same as ingest.py) ────────────────────────────────────────────────

SCRIPT_DIR = Path(__file__).resolve().parent
BINSLIB_DIR = SCRIPT_DIR.parent / "binslib"
DB_PATH = BINSLIB_DIR / "data" / "binslib.db"
COMPRESSED_DIR = BINSLIB_DIR / "data" / "compressed"


def repair(
    source: str,
    book_ids: list[int] | None,
    dry_run: bool,
    batch_size: int = 500,
) -> None:
    if not DB_PATH.exists():
        print(f"ERROR: Database not found: {DB_PATH}")
        sys.exit(1)

    conn = open_db(str(DB_PATH))

    # ── 1. Find candidate books ─────────────────────────────────────────

    if book_ids:
        placeholders = ",".join("?" for _ in book_ids)
        rows = conn.execute(
            f"SELECT b.id, b.chapter_count FROM books b WHERE b.id IN ({placeholders})",
            book_ids,
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT b.id, b.chapter_count FROM books b WHERE b.source = ?",
            (source,),
        ).fetchall()

    print(f"Scanning {len(rows):,} {source} books for missing chapter rows...")

    # Build map of book_id -> set of existing DB chapter indices
    # Do this in batches to avoid a huge query
    db_indices_map: dict[int, set[int]] = {}
    all_ids = [r[0] for r in rows]
    for i in range(0, len(all_ids), 2000):
        chunk = all_ids[i : i + 2000]
        ph = ",".join("?" for _ in chunk)
        cur = conn.execute(
            f"SELECT book_id, index_num FROM chapters WHERE book_id IN ({ph})",
            chunk,
        )
        for book_id, idx in cur:
            db_indices_map.setdefault(book_id, set()).add(idx)

    # ── 2. Scan bundles and find gaps ────────────────────────────────────

    candidates: list[tuple[int, int, set[int]]] = []  # (book_id, chapter_count, missing_indices)
    total_missing = 0
    books_not_in_db_table = 0

    for book_id, db_chapter_count in rows:
        bundle_path = str(COMPRESSED_DIR / f"{book_id}.bundle")
        bundle_indices = read_bundle_indices(bundle_path)
        if not bundle_indices:
            continue  # no bundle on disk

        db_indices = db_indices_map.get(book_id, set())
        missing = bundle_indices - db_indices
        if not missing:
            continue

        candidates.append((book_id, db_chapter_count or 0, missing))
        total_missing += len(missing)

    # Also handle books that have bundles on disk but no row in books table at all
    # (the 219 books from the analysis).  We skip these here — they need metadata
    # from the plan file first via --update-meta-only, then this script.

    print(f"\nResults:")
    print(f"  Books with missing chapter rows: {len(candidates):,}")
    print(f"  Total chapter rows to insert:    {total_missing:,}")

    if not candidates:
        print("\nNothing to repair.")
        conn.close()
        return

    # Show top examples
    candidates.sort(key=lambda x: -len(x[2]))
    print(f"\n  Top books by gap size:")
    for bid, ch_count, missing in candidates[:15]:
        db_has = len(db_indices_map.get(bid, set()))
        bundle_has = db_has + len(missing)
        print(f"    {bid:>10}: bundle={bundle_has:>6}, db={db_has:>6}, gap={len(missing):>6}")
    if len(candidates) > 15:
        print(f"    ... and {len(candidates) - 15:,} more")

    if dry_run:
        print(f"\n[DRY RUN] Would insert {total_missing:,} chapter rows. Exiting.")
        conn.close()
        return

    # ── 3. Insert missing chapter rows ───────────────────────────────────

    print(f"\nInserting {total_missing:,} chapter rows...")
    start = time.time()
    inserted_total = 0
    books_repaired = 0
    errors = 0

    for i, (book_id, db_chapter_count, missing) in enumerate(candidates):
        bundle_path = str(COMPRESSED_DIR / f"{book_id}.bundle")

        # Try to get metadata from bundle (may be empty for v1 bundles)
        bundle_meta = read_bundle_meta(bundle_path)

        rows_to_insert = []
        for idx in sorted(missing):
            meta = bundle_meta.get(idx)
            if meta and meta.title:
                title = meta.title
                slug = meta.slug or slugify(meta.title)
                wc = meta.word_count
                ch_id = meta.chapter_id
            else:
                # Generate placeholder — "Chương {index}"
                title = f"Chương {idx}"
                slug = f"chuong-{idx}"
                wc = meta.word_count if meta else 0
                ch_id = meta.chapter_id if meta else 0
            rows_to_insert.append((book_id, idx, title, slug, wc, ch_id))

        try:
            conn.executemany(
                "INSERT OR IGNORE INTO chapters "
                "(book_id, index_num, title, slug, word_count, chapter_id) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                rows_to_insert,
            )

            # Update chapters_saved to reflect bundle size
            bundle_count = len(db_indices_map.get(book_id, set())) + len(missing)
            conn.execute(
                "UPDATE books SET chapters_saved = ? WHERE id = ?",
                (bundle_count, book_id),
            )

            inserted_total += len(rows_to_insert)
            books_repaired += 1
        except Exception as e:
            print(f"  ERROR book {book_id}: {e}")
            errors += 1

        # Commit in batches
        if (i + 1) % batch_size == 0:
            conn.commit()
            elapsed = time.time() - start
            rate = inserted_total / elapsed if elapsed > 0 else 0
            print(
                f"  [{i + 1:,}/{len(candidates):,}] "
                f"+{inserted_total:,} rows, {rate:.0f}/s"
            )

    conn.commit()
    conn.close()

    elapsed = time.time() - start
    print(f"\n{'=' * 60}")
    print(f"  REPAIR COMPLETE")
    print(f"{'=' * 60}")
    print(f"  Books repaired:     {books_repaired:>10,}")
    print(f"  Chapters inserted:  {inserted_total:>10,}")
    print(f"  Errors:             {errors:>10,}")
    print(f"  Duration:           {elapsed:>10.1f}s")
    if elapsed > 0:
        print(f"  Rate:               {inserted_total / elapsed:>10.0f} rows/s")
    print(f"{'=' * 60}")


def main():
    parser = argparse.ArgumentParser(
        description="Repair missing chapter rows in SQLite from bundle data"
    )
    parser.add_argument(
        "book_ids",
        nargs="*",
        type=int,
        help="Specific book IDs to repair (default: all books for source)",
    )
    parser.add_argument(
        "--source",
        default="mtc",
        help="Source to repair (default: mtc)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Preview without writing any data",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=500,
        help="Commit interval (default: 500 books)",
    )
    args = parser.parse_args()

    repair(
        source=args.source,
        book_ids=args.book_ids if args.book_ids else None,
        dry_run=args.dry_run,
        batch_size=args.batch_size,
    )


if __name__ == "__main__":
    main()
