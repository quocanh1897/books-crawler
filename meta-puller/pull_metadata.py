#!/usr/bin/env python3
"""
Pull rich metadata + cover images for all books in crawler/output/.

Scans each book directory, hits the API for full details, and saves:
  - metadata.json   (all available properties)
  - cover.jpg       (poster image, largest available size)

Usage:
    python3 pull_metadata.py                   # all books missing metadata
    python3 pull_metadata.py --list            # list books missing metadata
    python3 pull_metadata.py --force            # re-pull everything
    python3 pull_metadata.py --ids 147360 116007  # specific books only
    python3 pull_metadata.py --dry-run          # show what would be fetched
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time

import httpx
from rich.progress import Progress, BarColumn, TextColumn, TimeElapsedColumn, TimeRemainingColumn, MofNCompleteColumn

# ── Config (shared with crawler) ────────────────────────────────────────────

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "crawler"))
from config import BASE_URL, HEADERS, REQUEST_DELAY

OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "..", "crawler", "output")


# ── API helpers ─────────────────────────────────────────────────────────────

def fetch_book_metadata(client: httpx.Client, book_id: int) -> dict | None:
    """Fetch full book metadata from API by ID.

    Tries GET /api/books/{id} first (direct lookup),
    falls back to filter[id] search if that fails.
    """
    includes = "author,creator,genres"

    # Direct lookup by ID
    try:
        r = client.get(f"{BASE_URL}/api/books/{book_id}",
                       params={"include": includes})
        if r.status_code == 200:
            data = r.json()
            if data.get("success") and data.get("data"):
                book = data["data"]
                if "book" in book and isinstance(book["book"], dict):
                    book = book["book"]
                return book
    except Exception as e:
        print(f"    /api/books/{book_id}: {e}")

    # Fallback: search by name from existing book.json
    book_json = os.path.join(OUTPUT_DIR, str(book_id), "book.json")
    if os.path.exists(book_json):
        with open(book_json) as f:
            local = json.load(f)
        name = local.get("book_name", "")
        if name:
            try:
                r = client.get(f"{BASE_URL}/api/books",
                               params={"filter[keyword]": name,
                                       "include": includes, "limit": 5})
                if r.status_code == 200:
                    data = r.json()
                    if data.get("success") and data.get("data"):
                        for item in data["data"]:
                            book = item.get("book", item)
                            if book.get("id") == book_id:
                                return book
                        # If exact ID not found, return first result if ID matches
                        first = data["data"][0]
                        book = first.get("book", first)
                        if book.get("id") == book_id:
                            return book
            except Exception as e:
                print(f"    filter[keyword] fallback: {e}")

            # Fuzzy search fallback
            try:
                r = client.get(f"{BASE_URL}/api/books/search",
                               params={"keyword": name, "limit": 10})
                if r.status_code == 200:
                    data = r.json()
                    if data.get("success") and data.get("data"):
                        for item in data["data"]:
                            book = item.get("book", item)
                            if book.get("id") == book_id:
                                return book
            except Exception as e:
                print(f"    /search fallback: {e}")

    return None


def download_cover(client: httpx.Client, poster: dict, dest_path: str) -> bool:
    """Download the best available cover image.

    poster dict has keys like 'default', '600', '300', '150' with URLs.
    We pick the largest available.
    """
    # Prefer largest size first
    for key in ["default", "600", "300", "150"]:
        url = poster.get(key)
        if not url:
            continue
        try:
            r = client.get(url, follow_redirects=True, timeout=30)
            if r.status_code == 200 and len(r.content) > 100:
                with open(dest_path, "wb") as f:
                    f.write(r.content)
                return True
        except Exception as e:
            print(f"    Cover download ({key}): {e}")
    return False


# ── Core logic ──────────────────────────────────────────────────────────────

def get_book_ids() -> list[int]:
    """Scan crawler/output/ for book ID directories."""
    ids = []
    for name in os.listdir(OUTPUT_DIR):
        path = os.path.join(OUTPUT_DIR, name)
        if os.path.isdir(path) and name.isdigit():
            ids.append(int(name))
    return sorted(ids)


def needs_pull(book_id: int, force: bool) -> bool:
    """Check if a book directory is missing metadata."""
    if force:
        return True
    meta_path = os.path.join(OUTPUT_DIR, str(book_id), "metadata.json")
    return not os.path.exists(meta_path)


def pull_one(client: httpx.Client, book_id: int, log=print) -> bool:
    """Pull metadata + cover for a single book. Returns True on success."""
    book_dir = os.path.join(OUTPUT_DIR, str(book_id))
    meta_path = os.path.join(book_dir, "metadata.json")
    cover_path = os.path.join(book_dir, "cover.jpg")

    book = fetch_book_metadata(client, book_id)
    if not book:
        log(f"  [red]FAILED[/red] {book_id}: no API data")
        return False

    # Save full metadata
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(book, f, indent=2, ensure_ascii=False)

    # Download cover image
    poster = book.get("poster")
    if poster and isinstance(poster, dict):
        if not download_cover(client, poster, cover_path):
            log(f"  [yellow]WARNING[/yellow] {book_id}: cover download failed")
    elif poster and isinstance(poster, str):
        try:
            r = client.get(poster, follow_redirects=True, timeout=30)
            if r.status_code == 200 and len(r.content) > 100:
                with open(cover_path, "wb") as f:
                    f.write(r.content)
        except Exception as e:
            log(f"  [yellow]WARNING[/yellow] {book_id}: cover failed: {e}")

    return True


# ── Main ────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Pull metadata + cover images for crawled books")
    parser.add_argument("--ids", type=int, nargs="+",
                        help="Specific book IDs to pull (default: all)")
    parser.add_argument("--list", action="store_true",
                        help="List books missing metadata.json and exit")
    parser.add_argument("--force", action="store_true",
                        help="Re-pull even if metadata.json exists")
    parser.add_argument("--dry-run", action="store_true",
                        help="Show what would be fetched without doing it")
    parser.add_argument("--delay", type=float, default=REQUEST_DELAY,
                        help=f"Seconds between API requests (default: {REQUEST_DELAY})")
    args = parser.parse_args()

    all_ids = get_book_ids()
    if args.ids:
        target_ids = [bid for bid in args.ids if bid in all_ids]
        missing = [bid for bid in args.ids if bid not in all_ids]
        if missing:
            print(f"WARNING: book IDs not in output/: {missing}")
    else:
        target_ids = all_ids

    pending = [bid for bid in target_ids if needs_pull(bid, args.force)]

    print(f"Books in output/:    {len(all_ids)}")
    print(f"Targeted:            {len(target_ids)}")
    print(f"Need metadata pull:  {len(pending)}")
    print()

    if args.list:
        if not pending:
            print("All books have metadata.json.")
        else:
            print("Books missing metadata.json:")
            for bid in pending:
                book_json = os.path.join(OUTPUT_DIR, str(bid), "book.json")
                name = "?"
                if os.path.exists(book_json):
                    with open(book_json) as f:
                        name = json.load(f).get("book_name", "?")
                print(f"  {bid}: {name}")
        return

    if not pending:
        print("Nothing to do.")
        return

    if args.dry_run:
        print("Would pull metadata for:")
        for bid in pending:
            book_json = os.path.join(OUTPUT_DIR, str(bid), "book.json")
            name = "?"
            if os.path.exists(book_json):
                with open(book_json) as f:
                    name = json.load(f).get("book_name", "?")
            print(f"  {bid}: {name}")
        return

    succeeded = 0
    failed = 0

    progress = Progress(
        TextColumn("[bold blue]{task.description}"),
        BarColumn(bar_width=30),
        MofNCompleteColumn(),
        TextColumn("•"),
        TimeElapsedColumn(),
        TextColumn("•"),
        TimeRemainingColumn(),
    )

    with progress, httpx.Client(headers=HEADERS, timeout=30) as client:
        task = progress.add_task("Pulling metadata", total=len(pending))

        for i, bid in enumerate(pending, 1):
            book_json = os.path.join(OUTPUT_DIR, str(bid), "book.json")
            name = "?"
            if os.path.exists(book_json):
                with open(book_json) as f:
                    name = json.load(f).get("book_name", "?")

            progress.update(task, description=f"{bid}: {name}")

            if pull_one(client, bid, log=progress.console.print):
                succeeded += 1
            else:
                failed += 1

            progress.advance(task)

            if i < len(pending):
                time.sleep(args.delay)

    print(f"\nDone: {succeeded} succeeded, {failed} failed out of {len(pending)}")


if __name__ == "__main__":
    main()
