#!/usr/bin/env python3
"""
Fetch the complete book catalog from the mobile API.

Paginates through /api/books to collect all books on the platform,
then cross-references with what's already downloaded (including
compressed bundles in binslib/data/compressed/) to identify gaps.

Usage:
    python3 fetch_catalog.py              # fetch full catalog
    python3 fetch_catalog.py --verify 926 # verify author id 926 has 7 books
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time

import httpx

sys.path.insert(0, os.path.dirname(__file__))
from config import BASE_URL, HEADERS
from src.utils import count_existing_chapters

CATALOG_FILE = os.path.join(os.path.dirname(__file__), "full_catalog.json")
OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "..", "crawler", "output")


def fetch_all_books(client: httpx.Client, limit: int = 50) -> list[dict]:
    """Paginate through /api/books to get every book on the platform."""
    all_books = []
    page = 1
    total = None

    while True:
        r = client.get(f"{BASE_URL}/api/books", params={"limit": limit, "page": page})
        data = r.json()
        if not data.get("success"):
            print(f"  Page {page}: API error — {data.get('message', '?')}")
            break

        items = data.get("data", [])
        if not items:
            break

        pag = data.get("pagination", {})
        if total is None:
            total = pag.get("total", "?")
            last_page = pag.get("last", "?")
            print(f"  Total books: {total}, pages: {last_page}")

        for item in items:
            all_books.append(
                {
                    "id": item["id"],
                    "name": item.get("name", "?"),
                    "slug": item.get("slug", ""),
                    "chapter_count": item.get("latest_index", 0),
                    "first_chapter": item.get("first_chapter"),
                    "status": item.get("status_name", "?"),
                    "kind": item.get("kind"),
                    "sex": item.get("sex"),
                    "word_count": item.get("word_count", 0),
                }
            )

        if page % 50 == 0 or page == 1:
            print(f"  Page {page}/{last_page}: {len(all_books)} books collected")

        if not pag.get("next"):
            break
        page += 1
        time.sleep(0.08)

    print(f"  Done: {len(all_books)} books fetched")
    return all_books


def verify_author(client: httpx.Client, author_id: int):
    """Verify a specific author's books are all present."""
    r = client.get(
        f"{BASE_URL}/api/books",
        params={"filter[author]": author_id, "limit": 50, "page": 1},
    )
    data = r.json()
    items = data.get("data", [])
    print(f"\nAuthor {author_id}: {len(items)} books")
    for it in items:
        print(
            f"  {it.get('id'):>7} ch={it.get('latest_index', 0):>5} {it.get('name', '?')[:50]}"
        )
    return items


def audit(catalog: list[dict]):
    """Cross-reference catalog with local downloads and compressed bundles."""
    # Build a set of all book IDs that have any local presence
    # (either .txt files in crawler/output or chapters in a .bundle)
    known_bids: set[int] = set()
    for d in os.listdir(OUTPUT_DIR):
        try:
            known_bids.add(int(d))
        except ValueError:
            pass

    # Also detect books that only have a bundle (no crawler output dir)
    from src.utils import BINSLIB_COMPRESSED_DIR

    if os.path.isdir(BINSLIB_COMPRESSED_DIR):
        for f in os.listdir(BINSLIB_COMPRESSED_DIR):
            m = f.removesuffix(".bundle")
            if m != f:
                try:
                    known_bids.add(int(m))
                except ValueError:
                    pass

    # count_existing_chapters() returns the union of .txt indices and
    # bundle indices, so a chapter in either source counts as "done".
    existing: dict[int, int] = {}
    for bid in known_bids:
        ch = count_existing_chapters(bid)
        if ch:
            existing[bid] = len(ch)

    downloadable = [
        b for b in catalog if b.get("first_chapter") and b.get("chapter_count", 0) > 0
    ]
    not_downloadable = [
        b
        for b in catalog
        if not b.get("first_chapter") or b.get("chapter_count", 0) == 0
    ]

    have_complete = []
    have_partial = []
    need_download = []

    for b in downloadable:
        bid = b["id"]
        api_ch = b["chapter_count"]
        local_ch = existing.get(bid, 0)

        if local_ch > 0:
            if local_ch >= api_ch:
                have_complete.append({**b, "local": local_ch})
            else:
                have_partial.append({**b, "local": local_ch, "gap": api_ch - local_ch})
        else:
            need_download.append(b)

    total_gap = sum(b["gap"] for b in have_partial) + sum(
        b["chapter_count"] for b in need_download
    )

    print(f"\n{'=' * 65}")
    print(f"CATALOG AUDIT")
    print(f"{'=' * 65}")
    print(f"Total in catalog:     {len(catalog):>7}")
    print(f"  Downloadable:       {len(downloadable):>7}")
    print(f"  No chapters/API:    {len(not_downloadable):>7}")
    print(f"On disk (complete):   {len(have_complete):>7}")
    print(f"On disk (partial):    {len(have_partial):>7}")
    print(f"Not downloaded:       {len(need_download):>7}")
    print(f"{'─' * 65}")
    print(f"Chapters to fetch:    {total_gap:>10,}")
    print(f"Already on disk:      {len(existing):>7} book folders")

    result = {
        "summary": {
            "total_catalog": len(catalog),
            "downloadable": len(downloadable),
            "no_api_chapters": len(not_downloadable),
            "already_complete": len(have_complete),
            "partial": len(have_partial),
            "need_download": len(need_download),
            "chapters_to_fetch": total_gap,
        },
        "need_download": need_download,
        "partial": [
            {
                "id": b["id"],
                "name": b["name"],
                "chapter_count": b["chapter_count"],
                "first_chapter": b["first_chapter"],
                "local": b["local"],
                "gap": b["gap"],
            }
            for b in sorted(have_partial, key=lambda x: -x["gap"])
        ],
    }
    return result


def main():
    parser = argparse.ArgumentParser(description="Fetch complete book catalog")
    parser.add_argument(
        "--verify", type=int, help="Verify author ID has expected books"
    )
    parser.add_argument(
        "--skip-fetch", action="store_true", help="Use existing catalog file"
    )
    args = parser.parse_args()

    client = httpx.Client(headers=HEADERS, timeout=30)

    if args.verify:
        verify_author(client, args.verify)
        return

    if args.skip_fetch and os.path.exists(CATALOG_FILE):
        print(f"Loading existing catalog from {CATALOG_FILE}")
        with open(CATALOG_FILE) as f:
            catalog = json.load(f)
    else:
        print("Fetching complete book catalog...")
        catalog = fetch_all_books(client)
        with open(CATALOG_FILE, "w") as f:
            json.dump(catalog, f, indent=2, ensure_ascii=False)
        print(f"Saved {len(catalog)} books to {CATALOG_FILE}")

    result = audit(catalog)

    # Save download plan
    plan_file = os.path.join(os.path.dirname(__file__), "full_download_plan.json")
    with open(plan_file, "w") as f:
        json.dump(result, f, indent=2, ensure_ascii=False)
    print(f"Saved download plan to {plan_file}")

    # Show top needs
    if result["need_download"]:
        nd = result["need_download"]
        nd.sort(key=lambda x: -x.get("chapter_count", 0))
        print(f"\nTop 20 books to download (by chapter count):")
        for b in nd[:20]:
            print(f"  {b['id']:>7} ch={b['chapter_count']:>5} {b['name'][:50]}")

    if result["partial"]:
        print(f"\nPartial downloads:")
        for b in result["partial"][:20]:
            print(
                f"  {b['id']:>7} {b['local']:>5}/{b['chapter_count']:<5} gap={b['gap']:>5} {b['name'][:42]}"
            )

    client.close()


if __name__ == "__main__":
    main()
