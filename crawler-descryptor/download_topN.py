#!/usr/bin/env python3
"""
Download the top N books from a plan file.

Reads a JSON plan file (flat array of book entries sorted by ranking /
chapter count) and downloads the first N books, skipping any that are
already complete on disk or in compressed bundles.

Usage:
    python3 download_topN.py 1000                       # top 1000 from default plan
    python3 download_topN.py 500 -w 200                 # top 500, 200 workers
    python3 download_topN.py 2000 --plan custom.json    # top 2000 from custom plan
    python3 download_topN.py 1000 --offset 500          # skip first 500, then take 1000
    python3 download_topN.py 1000 --exclude 100441      # skip specific IDs
"""

from __future__ import annotations

import argparse
import asyncio
import io
import json
import os
import sys
import time

# Fix Windows console encoding for Vietnamese characters
# line_buffering=True ensures print() output appears immediately
if sys.platform == "win32":
    sys.stdout = io.TextIOWrapper(
        sys.stdout.buffer, encoding="utf-8", errors="replace", line_buffering=True
    )
    sys.stderr = io.TextIOWrapper(
        sys.stderr.buffer, encoding="utf-8", errors="replace", line_buffering=True
    )

from src.downloader import AsyncBookClient, download_book

DEFAULT_WORKERS = 150
MAX_CONCURRENT_REQUESTS = 180
REQUEST_DELAY = 0.015
PLAN_FILE = os.path.join(os.path.dirname(__file__), "fresh_books_download.json")


async def main_async(books: list[dict], workers: int):
    client = AsyncBookClient(
        max_concurrent=MAX_CONCURRENT_REQUESTS,
        request_delay=REQUEST_DELAY,
    )
    n = len(books)
    total_ch = sum(b.get("chapter_count", 0) for b in books)

    print(f"Downloading {n} books ({total_ch:,} chapters) with {workers} workers")
    print(
        f"Rate limit: {MAX_CONCURRENT_REQUESTS} concurrent reqs, {REQUEST_DELAY}s delay\n"
    )
    start = time.time()

    queue: asyncio.Queue = asyncio.Queue()
    for i, b in enumerate(books, 1):
        await queue.put((i, b))

    results = []
    results_lock = asyncio.Lock()
    completed = {"count": 0}

    async def worker_loop():
        while True:
            try:
                idx, entry = queue.get_nowait()
            except asyncio.QueueEmpty:
                return
            try:
                result = await download_book(client, entry, f"[{idx}/{n}]")
                async with results_lock:
                    results.append(result)
            except Exception as e:
                async with results_lock:
                    results.append(e)
            completed["count"] += 1
            if completed["count"] % 10 == 0:
                elapsed = time.time() - start
                print(
                    f"  --- Progress: {completed['count']}/{n} books done ({elapsed / 60:.0f}m) ---"
                )

    worker_tasks = [asyncio.create_task(worker_loop()) for _ in range(workers)]
    await asyncio.gather(*worker_tasks)

    await client.close()

    elapsed = time.time() - start
    print(f"\n{'=' * 70}")
    print(f"SUMMARY  ({elapsed / 60:.1f} min, {workers} workers)")
    print(f"{'=' * 70}")
    total_saved = 0
    total_errors = 0
    failures = []
    for r in results:
        if isinstance(r, Exception):
            total_errors += 1
            failures.append(str(r))
            continue
        total_saved += r["saved"]
        total_errors += max(0, r.get("errors", 0))
        if r.get("errors", 0) < 0:
            failures.append(f"{r['book_id']}: {r['name']}")

    print(f"Books processed: {len(results)}")
    print(f"Chapters saved:  {total_saved:,}")
    print(f"Errors:          {total_errors}")
    if failures:
        print(f"Failed books:    {len(failures)}")
        for f in failures[:10]:
            print(f"  - {f}")
    print(f"\nTotal time: {elapsed / 3600:.1f} hours")


def main():
    parser = argparse.ArgumentParser(
        description="Download the top N books from a plan file",
    )
    parser.add_argument(
        "N",
        nargs="?",
        type=int,
        default=0,
        help="Number of top books to download (default: all books in the plan)",
    )
    parser.add_argument(
        "-w",
        "--workers",
        type=int,
        default=DEFAULT_WORKERS,
        help=f"Parallel workers (default: {DEFAULT_WORKERS})",
    )
    parser.add_argument(
        "--exclude", nargs="*", type=int, default=[], help="Book IDs to skip"
    )
    parser.add_argument("--plan", default=PLAN_FILE, help="Path to download plan JSON")
    parser.add_argument(
        "--offset",
        type=int,
        default=0,
        help="Skip first M books in the plan before taking N",
    )
    args = parser.parse_args()

    with open(args.plan, encoding="utf-8") as f:
        plan = json.load(f)

    # Accept both flat arrays and structured plans ({need_download, partial})
    if isinstance(plan, list):
        books = [
            b for b in plan if b.get("first_chapter") and b.get("chapter_count", 0) > 0
        ]
    else:
        books = plan.get("need_download", []) + plan.get("partial", [])

    exclude = set(args.exclude)
    if exclude:
        before = len(books)
        books = [b for b in books if b["id"] not in exclude]
        print(f"Excluded {before - len(books)} books (IDs: {sorted(exclude)})\n")

    if args.offset:
        print(f"Skipping first {args.offset} books (offset)\n")
        books = books[args.offset :]

    if args.N:
        books = books[: args.N]

    if not books:
        print("Nothing to download.")
        return

    asyncio.run(main_async(books, args.workers))


if __name__ == "__main__":
    main()
