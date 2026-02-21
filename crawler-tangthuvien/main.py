#!/usr/bin/env python3
"""
crawler-tangthuvien: Crawl books from truyen.tangthuvien.vn.

Commands:
    discover                    Discover top books, output books_to_crawl.json
    fetch-book <slug>           Fetch a single book (metadata + chapters + cover)
"""
from __future__ import annotations

import argparse
import sys
import time

from config import BASE_URL
from src.client import FetchError, NotFound, TangThuVienClient
from src.parser import parse_book_detail, parse_chapter
from src.utils import (
    count_existing_chapters,
    get_or_create_book_id,
    save_chapter,
    save_cover,
    save_metadata,
)


def cmd_discover(args):
    """Run book discovery (delegates to discover.py)."""
    from discover import main as discover_main
    sys.argv = ["discover.py", "--pages", str(args.pages)]
    if args.no_dedup:
        sys.argv.append("--no-dedup")
    discover_main()


def cmd_fetch_book(args):
    """Fetch a single book: metadata, cover, and all chapters."""
    slug = args.slug
    print(f"Fetching book: {slug}")

    with TangThuVienClient(delay=args.delay) as client:
        # Fetch book detail page
        print("  Fetching book detail page...")
        html = client.get_html(f"{BASE_URL}/doc-truyen/{slug}")
        meta = parse_book_detail(html, slug)

        book_id = get_or_create_book_id(slug)
        meta["id"] = book_id
        chapter_links = meta.pop("_chapter_links", [])

        print(f"  Name: {meta['name']}")
        print(f"  Author: {meta['author']['name']}")
        print(f"  Status: {meta['status_name']}")
        print(f"  Chapters: {meta['chapter_count']}")
        print(f"  Book ID (local): {book_id}")

        # Save metadata
        save_metadata(book_id, meta)

        # Download cover
        cover_url = meta.get("cover_url", "")
        if cover_url and "default-book" not in cover_url:
            try:
                print("  Downloading cover...")
                img_bytes = client.get_bytes(cover_url)
                save_cover(book_id, img_bytes)
            except Exception as e:
                print(f"  Cover download failed: {e}")

        # Fetch chapters
        total = meta["chapter_count"]
        if total == 0:
            print("  No chapters to fetch")
            return

        existing = count_existing_chapters(book_id)
        if existing:
            print(f"  Already on disk: {len(existing)} chapters (will skip)")

        saved = 0
        errors = 0
        start_time = time.time()

        # Iterate through chapters sequentially
        for ch_idx in range(1, total + 1):
            if ch_idx in existing:
                continue

            ch_url = f"{BASE_URL}/doc-truyen/{slug}/chuong-{ch_idx}"

            try:
                ch_html = client.get_html(ch_url)
                parsed = parse_chapter(ch_html)
                if not parsed:
                    print(f"  [{ch_idx}/{total}] No content, skipping")
                    errors += 1
                    continue

                ch_slug = f"chuong-{ch_idx}"
                save_chapter(book_id, ch_idx, ch_slug, parsed["title"], parsed["body"])
                saved += 1

                elapsed = time.time() - start_time
                rate = saved / elapsed if elapsed > 0 else 0
                if saved % 10 == 0 or saved == 1:
                    print(f"  [{ch_idx}/{total}] {parsed['title'][:50]} ({rate:.1f} ch/s)")

            except NotFound:
                # Chapter might not exist at this index, try next
                errors += 1
                continue
            except FetchError as e:
                print(f"  [{ch_idx}/{total}] FAILED: {e}")
                errors += 1
                continue

        elapsed = time.time() - start_time
        print(f"\nDone in {elapsed:.0f}s: {saved} saved, {len(existing)} skipped, {errors} errors")


def main():
    parser = argparse.ArgumentParser(
        description="Crawl books from truyen.tangthuvien.vn",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )

    sub = parser.add_subparsers(dest="command")

    p_discover = sub.add_parser("discover", help="Discover top books")
    p_discover.add_argument("--pages", type=int, default=50, help="Pages to scrape")
    p_discover.add_argument("--no-dedup", action="store_true")

    p_book = sub.add_parser("fetch-book", help="Fetch a single book")
    p_book.add_argument("slug", help="Book slug (e.g. muc-than-ky)")
    p_book.add_argument("--delay", type=float, default=1.5, help="Delay between requests (seconds)")

    args = parser.parse_args()
    if not args.command:
        parser.print_help()
        return

    if args.command == "discover":
        cmd_discover(args)
    elif args.command == "fetch-book":
        cmd_fetch_book(args)


if __name__ == "__main__":
    main()
