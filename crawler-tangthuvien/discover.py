#!/usr/bin/env python3
"""Discover top books from tangthuvien and produce books_to_crawl.json.

Usage:
    python discover.py                         # top 1000 by views (50 pages)
    python discover.py --pages 10              # top ~200 books
    python discover.py --pages 50 --no-dedup   # skip MTC dedup
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time

from config import BASE_URL
from src.client import TangThuVienClient
from src.parser import parse_listing_page, parse_listing_total_pages
from src.utils import build_mtc_index, is_mtc_duplicate

OUTPUT_FILE = os.path.join(os.path.dirname(__file__), "books_to_crawl.json")


def discover_top_by_views(
    client: TangThuVienClient,
    max_pages: int = 50,
    dedup_mtc: bool = True,
) -> list[dict]:
    """Scrape /tong-hop pages sorted by most recently updated to get top books."""
    mtc_index = build_mtc_index() if dedup_mtc else {}
    if dedup_mtc:
        print(f"  MTC index: {len(mtc_index)} books loaded for dedup")

    all_books: list[dict] = []
    seen_slugs: set[str] = set()
    skipped_mtc = 0

    for page in range(1, max_pages + 1):
        url = f"{BASE_URL}/tong-hop"
        params = {"tp": "cv", "ctg": "0", "page": str(page)}

        try:
            html = client.get_html(url, params=params)
        except Exception as e:
            print(f"  Page {page}: FAILED ({e})")
            break

        books = parse_listing_page(html)
        if not books:
            print(f"  Page {page}: no books found, stopping")
            break

        if page == 1:
            total_pages = parse_listing_total_pages(html)
            effective_max = min(max_pages, total_pages)
            print(f"  Total pages available: {total_pages}, will scrape: {effective_max}")

        new_on_page = 0
        for book in books:
            slug = book["slug"]
            if not slug or slug in seen_slugs:
                continue
            seen_slugs.add(slug)

            if dedup_mtc and is_mtc_duplicate(slug, mtc_index):
                skipped_mtc += 1
                continue

            all_books.append(book)
            new_on_page += 1

        print(f"  Page {page}/{max_pages}: {len(books)} found, {new_on_page} new, total: {len(all_books)}")

    print(f"\nDiscovery complete:")
    print(f"  Total unique books: {len(all_books)}")
    print(f"  Skipped (MTC duplicate, completed): {skipped_mtc}")
    print(f"  Pages scraped: {min(page, max_pages)}")

    return all_books


def main():
    parser = argparse.ArgumentParser(description="Discover top books from tangthuvien")
    parser.add_argument("--pages", type=int, default=50, help="Number of listing pages to scrape (default: 50, ~20 books/page)")
    parser.add_argument("--no-dedup", action="store_true", help="Skip MTC deduplication")
    parser.add_argument("-o", "--output", default=OUTPUT_FILE, help="Output JSON file path")
    args = parser.parse_args()

    print(f"Discovering top books from tangthuvien ({args.pages} pages)...")

    with TangThuVienClient() as client:
        books = discover_top_by_views(
            client,
            max_pages=args.pages,
            dedup_mtc=not args.no_dedup,
        )

    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(books, f, indent=2, ensure_ascii=False)

    print(f"\nSaved {len(books)} books to {args.output}")


if __name__ == "__main__":
    main()
