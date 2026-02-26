#!/usr/bin/env python3
"""Refresh fresh_books_download.json with latest metadata from the API.

Reads the existing plan file, fetches current metadata for every book ID
via GET /api/books/{id}, and writes an updated plan with the latest
chapter counts, statuses, word counts, author, creator, genres, etc.

Books that return 404 (removed from the platform) are dropped.
The output is sorted by chapter_count descending (same as the original).

With --scan, also probes every ID in the range 100003–{max_id} to
discover books missing from the plan (the /api/books listing and search
endpoints are severely limited — many valid books are invisible to them
but accessible by direct ID).

With --fix-author, books that have no author but have a creator will get
a synthetic author generated as {id: 999{creator_id}, name: creator_name}.

Usage:
    cd book-ingest
    python3 refresh_catalog.py                          # update existing entries
    python3 refresh_catalog.py --scan                   # + discover missing books
    python3 refresh_catalog.py --fix-author             # generate missing authors
    python3 refresh_catalog.py --scan --fix-author      # both
    python3 refresh_catalog.py --scan --workers 200     # faster scanning
    python3 refresh_catalog.py --dry-run                # preview, don't write
    python3 refresh_catalog.py --input path/to/plan.json --output updated.json
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
from dataclasses import dataclass, field

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

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_INPUT = os.path.join(SCRIPT_DIR, "data", "fresh_books_download.json")
DEFAULT_OUTPUT = DEFAULT_INPUT  # overwrite in place

# Books with fewer chapters than this are excluded from the output.
# Keeps the plan focused on substantial books worth downloading.
MIN_CHAPTER_COUNT = 100

# ID range for the MTC platform.  All valid book IDs fall within this range.
# IDs below 100003 and above ~153200 return 404.
ID_RANGE_START = 100003
ID_RANGE_END = 153500  # generous upper bound; the scanner auto-detects the real max


# ── Stats tracker ─────────────────────────────────────────────────────────────


@dataclass
class Stats:
    total: int = 0
    updated: int = 0
    unchanged: int = 0
    removed: int = 0
    errors: int = 0
    new_chapters: int = 0
    discovered: int = 0


# ── API fetching ──────────────────────────────────────────────────────────────


def _unwrap_book(data: dict) -> dict | None:
    """Unwrap the varying API response shapes into a flat book dict."""
    if isinstance(data, list):
        if not data:
            return None
        item = data[0]
        return item.get("book", item)
    if isinstance(data, dict) and "book" in data:
        return data["book"]
    return data


def _parse_author(raw: dict | None) -> dict | None:
    """Normalise an author object from the API."""
    if not raw or not isinstance(raw, dict):
        return None
    aid = raw.get("id")
    if aid is None:
        return None
    return {
        "id": aid,
        "name": raw.get("name", ""),
        "local_name": raw.get("local_name"),
        "avatar": raw.get("avatar"),
    }


def _parse_creator(raw: dict | None) -> dict | None:
    """Normalise a creator (uploader) object from the API."""
    if not raw or not isinstance(raw, dict):
        return None
    cid = raw.get("id")
    if cid is None:
        return None
    return {
        "id": cid,
        "name": raw.get("name", ""),
    }


def _parse_genres(raw: list | None) -> list[dict]:
    if not raw or not isinstance(raw, list):
        return []
    return [
        {"id": g["id"], "name": g.get("name", ""), "slug": g.get("slug", "")}
        for g in raw
        if isinstance(g, dict) and "id" in g
    ]


def _parse_tags(raw: list | None) -> list[dict]:
    if not raw or not isinstance(raw, list):
        return []
    return [
        {"id": t["id"], "name": t.get("name", ""), "type_id": t.get("type_id")}
        for t in raw
        if isinstance(t, dict) and "id" in t
    ]


def _parse_poster(raw: dict | None) -> dict | None:
    if not raw or not isinstance(raw, dict):
        return None
    return {
        "default": raw.get("default"),
        "600": raw.get("600"),
        "300": raw.get("300"),
        "150": raw.get("150"),
    }


# Author names that are placeholders, not real names.
_PLACEHOLDER_AUTHOR_NAMES = {"đang cập nhật"}


def _author_needs_fix(author: dict | None) -> bool:
    """Return True if the author is missing, has an empty name, or a placeholder name."""
    if not author:
        return True
    name = author.get("name")
    if not name or not str(name).strip():
        return True
    if str(name).strip().lower() in _PLACEHOLDER_AUTHOR_NAMES:
        return True
    return False


def generate_author_from_creator(creator: dict | None) -> dict | None:
    """Create a synthetic author entry from a creator (uploader).

    ID is prefixed with 999 to avoid collisions with real author IDs.
    E.g. creator id=1000043 → author id=9991000043.

    Used when the book has no author or the author name is empty.
    """
    if not creator or not creator.get("id"):
        return None
    return {
        "id": int(f"999{creator['id']}"),
        "name": creator["name"],
        "local_name": None,
        "avatar": None,
    }


def parse_book(data: dict, fix_author: bool = False) -> dict | None:
    """Extract a full book entry from the API response.

    Includes author, creator, genres, tags, synopsis, poster, and all
    stats fields.  When *fix_author* is True and the book has no author
    (or the author name is empty/whitespace) but has a creator, a
    synthetic author is generated from the creator.
    """
    book = _unwrap_book(data)
    if not isinstance(book, dict) or "id" not in book:
        return None

    chapter_count = book.get("chapter_count") or book.get("latest_index") or 0
    first_chapter = book.get("first_chapter")
    status_name = book.get("status_name") or book.get("state") or "?"

    author = _parse_author(book.get("author"))
    creator = _parse_creator(book.get("creator"))

    # Generate a synthetic author from the creator if requested
    author_generated = False
    if fix_author and _author_needs_fix(author) and creator:
        author = generate_author_from_creator(creator)
        author_generated = True

    review_score = book.get("review_score")
    if isinstance(review_score, str):
        try:
            review_score = float(review_score)
        except ValueError:
            review_score = 0
    review_score = review_score or 0

    entry: dict = {
        "id": book["id"],
        "name": book.get("name", "?"),
        "slug": book.get("slug", ""),
        "synopsis": book.get("synopsis"),
        "chapter_count": chapter_count,
        "first_chapter": first_chapter,
        "latest_chapter": book.get("latest_chapter"),
        "status": status_name,
        "kind": book.get("kind"),
        "sex": book.get("sex"),
        "word_count": book.get("word_count", 0),
        "view_count": book.get("view_count", 0),
        "vote_count": book.get("vote_count", 0),
        "bookmark_count": book.get("bookmark_count", 0),
        "comment_count": book.get("comment_count", 0),
        "review_score": review_score,
        "review_count": book.get("review_count", 0),
        "poster": _parse_poster(book.get("poster")),
        "author": author,
        "author_generated": author_generated,
        "creator": creator,
        "genres": _parse_genres(book.get("genres")),
        "tags": _parse_tags(book.get("tags")),
        "created_at": book.get("created_at"),
        "updated_at": book.get("updated_at"),
        "published_at": book.get("published_at"),
        "new_chap_at": book.get("new_chap_at"),
    }

    return entry


async def fetch_book(
    client: httpx.AsyncClient,
    sem: asyncio.Semaphore,
    book_id: int,
    delay: float,
    fix_author: bool = False,
    retries: int = 3,
) -> dict | None:
    """Fetch metadata for a single book.  Returns parsed entry or None."""
    for attempt in range(retries):
        async with sem:
            await asyncio.sleep(delay)
            try:
                r = await client.get(
                    f"{BASE_URL}/api/books/{book_id}",
                    params={"include": "author,creator,genres"},
                )
            except httpx.TransportError:
                if attempt < retries - 1:
                    await asyncio.sleep(2 ** (attempt + 1))
                    continue
                return None

        if r.status_code == 404:
            return None

        if r.status_code == 429:
            wait = int(r.headers.get("Retry-After", 2 ** (attempt + 2)))
            if attempt < retries - 1:
                await asyncio.sleep(wait)
                continue
            return None

        if r.status_code != 200:
            if attempt < retries - 1:
                await asyncio.sleep(2 ** (attempt + 1))
                continue
            return None

        data = r.json()
        if not data.get("success"):
            return None

        return parse_book(data.get("data", {}), fix_author=fix_author)

    return None


# ── Main logic ────────────────────────────────────────────────────────────────


async def _fetch_batch(
    book_ids: list[int],
    workers: int,
    delay: float,
    label: str,
    fix_author: bool = False,
) -> dict[int, dict | None]:
    """Fetch metadata for a batch of book IDs.  Returns {id: entry_or_None}."""
    results: dict[int, dict | None] = {}
    results_lock = asyncio.Lock()
    sem = asyncio.Semaphore(workers)
    total = len(book_ids)
    progress = {"done": 0}
    start = time.time()

    async with httpx.AsyncClient(headers=HEADERS, timeout=30) as client:

        async def _do(bid: int) -> None:
            entry = await fetch_book(client, sem, bid, delay, fix_author=fix_author)
            async with results_lock:
                results[bid] = entry
                progress["done"] += 1

            done = progress["done"]
            if done % 500 == 0 or done == total:
                elapsed = time.time() - start
                rate = done / elapsed if elapsed > 0 else 0
                eta = (total - done) / rate if rate > 0 else 0
                print(f"  {label} [{done:,}/{total:,}] {rate:.0f}/s, ETA {eta:.0f}s")

        tasks = [_do(bid) for bid in book_ids]
        await asyncio.gather(*tasks)

    return results


async def find_upper_bound(workers: int, delay: float) -> int:
    """Probe above ID_RANGE_END to find the true upper boundary."""
    # Quick sweep in steps of 50 to find where 404s become solid
    probe_ids = list(range(ID_RANGE_END - 500, ID_RANGE_END + 1000, 50))
    results = await _fetch_batch(probe_ids, workers, delay, "probe")
    last_valid = ID_RANGE_END
    for bid in sorted(results):
        if results[bid] is not None:
            last_valid = max(last_valid, bid)
    # Add a small buffer above the last valid ID
    return last_valid + 100


async def scan_missing(
    known_ids: set[int],
    workers: int,
    delay: float,
    upper_bound: int,
    fix_author: bool = False,
) -> list[dict]:
    """Scan the full ID range and return entries for books not in known_ids."""
    to_probe = [
        bid for bid in range(ID_RANGE_START, upper_bound + 1) if bid not in known_ids
    ]
    if not to_probe:
        print("  No IDs to scan — plan already covers the full range.")
        return []

    print(
        f"  Scanning {len(to_probe):,} unknown IDs ({ID_RANGE_START}–{upper_bound})..."
    )
    results = await _fetch_batch(
        to_probe, workers, delay, "scan", fix_author=fix_author
    )

    discovered: list[dict] = []
    for bid, entry in results.items():
        if (
            entry is not None
            and entry.get("first_chapter")
            and entry.get("chapter_count", 0) > 0
        ):
            discovered.append(entry)

    return discovered


async def refresh(
    entries: list[dict],
    workers: int,
    delay: float,
    scan: bool,
    min_chapters: int = MIN_CHAPTER_COUNT,
    fix_author: bool = False,
) -> tuple[list[dict], Stats]:
    """Fetch fresh metadata for all entries.  Returns (updated_list, stats)."""
    stats = Stats(total=len(entries))
    old_by_id = {e["id"]: e for e in entries}

    # Phase 1: refresh existing entries
    print("Phase 1: refreshing existing entries...")
    results = await _fetch_batch(
        list(old_by_id.keys()), workers, delay, "refresh", fix_author=fix_author
    )

    # Reconcile results
    updated_list: list[dict] = []
    for book_id, old_entry in old_by_id.items():
        new = results.get(book_id)
        if new is None:
            stats.removed += 1
            continue

        # Detect changes
        old_ch = old_entry.get("chapter_count", 0)
        new_ch = new.get("chapter_count", 0)
        delta = max(0, new_ch - old_ch)

        if delta > 0 or new.get("name") != old_entry.get("name"):
            stats.updated += 1
            stats.new_chapters += delta
        else:
            stats.unchanged += 1

        if new["first_chapter"] and new["chapter_count"] >= min_chapters:
            updated_list.append(new)

    # Phase 2 (optional): scan for missing books
    stats.discovered = 0
    if scan:
        print()
        print("Phase 2: scanning for missing books...")
        upper = await find_upper_bound(workers, delay)
        print(f"  Detected upper bound: {upper}")
        known = set(old_by_id.keys())
        discovered = await scan_missing(
            known, workers, delay, upper, fix_author=fix_author
        )
        # Apply the same chapter filter to discovered books
        discovered = [
            b for b in discovered if b.get("chapter_count", 0) >= min_chapters
        ]
        stats.discovered = len(discovered)
        updated_list.extend(discovered)
        print(
            f"  Discovered {len(discovered):,} new books (>= {min_chapters} chapters)"
        )

    # Sort by chapter_count descending (same as original)
    updated_list.sort(key=lambda b: -b.get("chapter_count", 0))

    return updated_list, stats


def print_report(stats: Stats, old_count: int, new_count: int, elapsed: float) -> None:
    print()
    print("=" * 60)
    print("  REFRESH REPORT")
    print("=" * 60)
    print(f"  Input books     : {old_count:>10,}")
    print(f"  Output books    : {new_count:>10,}")
    print(f"  ─────────────────────────────────")
    print(f"  Updated         : {stats.updated:>10,}")
    print(f"  Unchanged       : {stats.unchanged:>10,}")
    print(f"  Removed (404)   : {stats.removed:>10,}")
    print(f"  Errors          : {stats.errors:>10,}")
    if stats.discovered:
        print(f"  Discovered (new): {stats.discovered:>10,}")
    print(f"  ─────────────────────────────────")
    print(f"  New chapters    : {stats.new_chapters:>10,}")
    print(f"  Duration        : {elapsed:>10.1f}s")
    if elapsed > 0:
        print(f"  Rate            : {old_count / elapsed:>10.0f} books/s")
    print("=" * 60)


# ── CLI ───────────────────────────────────────────────────────────────────────


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Refresh fresh_books_download.json with latest API metadata",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "--input",
        default=DEFAULT_INPUT,
        help=f"Input plan file (default: {os.path.relpath(DEFAULT_INPUT, SCRIPT_DIR)})",
    )
    parser.add_argument(
        "--output",
        default=None,
        help="Output file (default: overwrite input)",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=150,
        help="Max concurrent API requests (default: 150)",
    )
    parser.add_argument(
        "--delay",
        type=float,
        default=0.015,
        help="Delay between requests in seconds (default: 0.015)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Fetch and report but don't write the output file",
    )
    parser.add_argument(
        "--min-chapters",
        type=int,
        default=MIN_CHAPTER_COUNT,
        help=f"Exclude books with fewer than N chapters (default: {MIN_CHAPTER_COUNT})",
    )
    parser.add_argument(
        "--scan",
        action="store_true",
        help="Also scan the full ID range (100003–153500+) to discover "
        "books missing from the plan.  Many valid books are invisible to "
        "the search/listing API but accessible by direct ID.",
    )
    parser.add_argument(
        "--fix-author",
        nargs="?",
        const=True,
        default=True,
        type=lambda v: v.lower() not in ("0", "false", "no", "off"),
        help="Generate synthetic authors from creators for books without an "
        "author (default: on). Use --fix-author 0 or --no-fix-author to disable.",
    )
    parser.add_argument(
        "--no-fix-author",
        dest="fix_author",
        action="store_false",
        help="Disable synthetic author generation.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    input_path = os.path.abspath(args.input)
    output_path = os.path.abspath(args.output) if args.output else input_path

    if not os.path.isfile(input_path):
        print(f"Error: input file not found: {input_path}", file=sys.stderr)
        sys.exit(1)

    # Load existing plan
    with open(input_path, encoding="utf-8") as f:
        entries = json.load(f)

    if not isinstance(entries, list):
        print("Error: expected a JSON array in the input file", file=sys.stderr)
        sys.exit(1)

    print(f"Input : {input_path}")
    print(f"Output: {output_path}")
    print(f"Books : {len(entries):,}")
    print(f"Workers: {args.workers}, delay: {args.delay}s")
    print(f"Min ch: {args.min_chapters}")
    print(
        f"Scan  : {'YES — full ID range' if args.scan else 'no (use --scan to discover missing books)'}"
    )
    print(
        f"Fix author: {'YES' if args.fix_author else 'no (disabled via --no-fix-author / --fix-author 0)'}"
    )
    if args.dry_run:
        print("DRY RUN — will not write output")
    print()

    start = time.time()
    updated, stats = asyncio.run(
        refresh(
            entries,
            args.workers,
            args.delay,
            scan=args.scan,
            min_chapters=args.min_chapters,
            fix_author=args.fix_author,
        )
    )
    elapsed = time.time() - start

    # Count author stats
    authors_generated = sum(1 for b in updated if b.get("author_generated"))
    no_author = sum(1 for b in updated if not b.get("author"))

    print_report(stats, len(entries), len(updated), elapsed)

    if authors_generated or no_author:
        print(f"\n  Authors generated from creator: {authors_generated:,}")
        print(f"  Books still without author: {no_author:,}")

    if args.dry_run:
        print("\nDry run complete — no file written.")
        return

    # Write output
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(updated, f, indent=2, ensure_ascii=False)
    print(f"\nWrote {len(updated):,} books to {output_path}")

    # Show top books with most new chapters
    old_by_id = {e["id"]: e for e in entries}
    if stats.new_chapters > 0:
        gains = []
        for b in updated:
            old = old_by_id.get(b["id"])
            if old:
                delta = b["chapter_count"] - old.get("chapter_count", 0)
                if delta > 0:
                    gains.append((delta, b))
        gains.sort(key=lambda x: -x[0])
        if gains:
            print(f"\nTop books with new chapters:")
            for delta, b in gains[:15]:
                print(f"  +{delta:>5} ch  {b['id']:>7}  {b['name'][:50]}")

    # Show discovered books (from --scan)
    if hasattr(stats, "discovered") and stats.discovered > 0:
        new_books = [b for b in updated if b["id"] not in old_by_id]
        new_books.sort(key=lambda b: -b.get("chapter_count", 0))
        print(f"\nTop discovered books (not in previous plan):")
        for b in new_books[:20]:
            print(f"  {b['id']:>7}  ch={b['chapter_count']:>5}  {b['name'][:50]}")
        if len(new_books) > 20:
            print(f"  ... and {len(new_books) - 20:,} more")


if __name__ == "__main__":
    main()
