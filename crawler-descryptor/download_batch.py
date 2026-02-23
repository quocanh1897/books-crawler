#!/usr/bin/env python3
"""
Parallel batch download of books via the mobile API.

Downloads multiple books concurrently using asyncio.  Each book's chapters
are fetched following the `next` chain, but multiple books download
simultaneously for N-fold throughput.

Uses the shared download engine from src/downloader.py.

Usage:
    python3 download_batch.py                        # download preset list
    python3 download_batch.py 100441 151531          # specific book IDs
    python3 download_batch.py -w 6                   # 6 parallel workers
    python3 download_batch.py --clean                # remove wrong data first
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time

from src.downloader import AsyncBookClient, download_book
from src.utils import get_output_dir

EMPTY_FOLDER_BOOKS = [
    100441,
    101481,
    101486,
    109098,
    115282,
    122376,
    151531,
]

DEFAULT_WORKERS = 5
MAX_CONCURRENT_REQUESTS = 8
REQUEST_DELAY = 0.3


def clean_wrong_downloads(book_ids: list[int]):
    """Remove chapters + metadata that were downloaded from the wrong book
    (the old sequential run used a broken filter[id] endpoint)."""
    for bid in book_ids:
        out_dir = os.path.join(
            os.path.dirname(__file__), "..", "crawler", "output", str(bid)
        )
        meta_path = os.path.join(out_dir, "metadata.json")
        if not os.path.exists(meta_path):
            continue
        try:
            with open(meta_path, encoding="utf-8") as f:
                meta = json.load(f)
            if meta.get("id") != bid:
                wrong_id = meta.get("id")
                files = [
                    f
                    for f in os.listdir(out_dir)
                    if f.endswith(".txt") and f[0].isdigit()
                ]
                print(
                    f"  {bid}: removing {len(files)} chapters from wrong book (api_id={wrong_id})"
                )
                for fname in files:
                    os.remove(os.path.join(out_dir, fname))
                os.remove(meta_path)
            else:
                print(f"  {bid}: metadata OK (id matches)")
        except Exception as e:
            print(f"  {bid}: error checking — {e}")


async def main_async(book_ids: list[int], workers: int):
    client = AsyncBookClient(
        max_concurrent=MAX_CONCURRENT_REQUESTS,
        request_delay=REQUEST_DELAY,
    )

    n = len(book_ids)
    print(f"Downloading {n} books with up to {workers} parallel workers")
    print(
        f"Rate limit: {MAX_CONCURRENT_REQUESTS} concurrent requests, "
        f"{REQUEST_DELAY}s delay per request\n"
    )
    start = time.time()

    book_sem = asyncio.Semaphore(workers)

    async def bounded(bid: int, idx: int) -> dict:
        async with book_sem:
            # Build a minimal book_entry — download_book() will fetch
            # metadata from the API since first_chapter is not provided.
            return await download_book(client, {"id": bid}, f"[{idx}/{n}]")

    tasks = [bounded(bid, i) for i, bid in enumerate(book_ids, 1)]
    results = await asyncio.gather(*tasks, return_exceptions=True)

    await client.close()

    elapsed = time.time() - start
    print(f"\n{'=' * 64}")
    print(f"SUMMARY  ({elapsed:.0f}s, {workers} workers)")
    print(f"{'=' * 64}")
    total_saved = 0
    total_errors = 0
    for r in results:
        if isinstance(r, Exception):
            print(f"  {'?':>6} | ERROR: {r}")
            total_errors += 1
            continue
        tag = (
            "OK" if r["saved"] > 0 else ("SKIP" if r.get("errors", 0) == 0 else "FAIL")
        )
        print(
            f"  {r['book_id']:>6} | {r['saved']:>5}/{r['total']:<5} saved | "
            f"{r.get('errors', 0):>3} err | {tag} | {r['name']}"
        )
        total_saved += r["saved"]
        total_errors += max(0, r.get("errors", 0))

    print(f"\nTotal: {total_saved} chapters saved, {total_errors} errors")


def main():
    parser = argparse.ArgumentParser(description="Parallel batch book downloader")
    parser.add_argument(
        "book_ids",
        nargs="*",
        type=int,
        help="Book IDs (default: preset EMPTY_FOLDER list)",
    )
    parser.add_argument(
        "-w",
        "--workers",
        type=int,
        default=DEFAULT_WORKERS,
        help=f"Parallel book downloads (default: {DEFAULT_WORKERS})",
    )
    parser.add_argument(
        "--clean",
        action="store_true",
        help="Remove wrongly-downloaded chapters before starting",
    )
    args = parser.parse_args()

    book_ids = args.book_ids or EMPTY_FOLDER_BOOKS

    if args.clean:
        print("Cleaning wrongly-downloaded data...")
        clean_wrong_downloads(book_ids)
        print()

    asyncio.run(main_async(book_ids, args.workers))


if __name__ == "__main__":
    main()
