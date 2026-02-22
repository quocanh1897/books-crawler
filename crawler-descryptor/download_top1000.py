#!/usr/bin/env python3
"""
Download books from top1000_download_plan.json.

Reads the plan file and downloads all books in need_download + partial lists,
skipping any book IDs passed via --exclude (to avoid overlap with other
running processes).

Usage:
    python3 download_top1000.py
    python3 download_top1000.py -w 5 --exclude 100441 101481
"""
from __future__ import annotations

import asyncio
import argparse
import io
import json
import os
import sys
import time

import httpx

# Fix Windows console encoding for Vietnamese characters
if sys.platform == "win32":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "crawler"))
from config import BASE_URL, HEADERS

from src.decrypt import DecryptionError, decrypt_content
from src.utils import count_existing_chapters, save_chapter, save_metadata

DEFAULT_WORKERS = 150
MAX_CONCURRENT_REQUESTS = 180
REQUEST_DELAY = 0.015
PLAN_FILE = os.path.join(os.path.dirname(__file__), "ranking_books.json")


class AsyncBookClient:
    def __init__(self, max_concurrent: int = MAX_CONCURRENT_REQUESTS):
        self._client = httpx.AsyncClient(headers=HEADERS, timeout=30)
        self._sem = asyncio.Semaphore(max_concurrent)
        self._delay = REQUEST_DELAY

    async def close(self):
        await self._client.aclose()

    async def _get(self, path: str, params: dict | None = None, retries: int = 3) -> dict:
        for attempt in range(retries):
            async with self._sem:
                await asyncio.sleep(self._delay)
                try:
                    r = await self._client.get(f"{BASE_URL}{path}", params=params)
                except httpx.TransportError as e:
                    if attempt < retries - 1:
                        await asyncio.sleep(2 ** (attempt + 1))
                        continue
                    raise RuntimeError(f"Transport error: {e}")

            if r.status_code == 429:
                wait = int(r.headers.get("Retry-After", 2 ** (attempt + 2)))
                if attempt < retries - 1:
                    await asyncio.sleep(wait)
                    continue
                raise RuntimeError(f"Rate limited after {retries} attempts")

            if r.status_code == 404:
                raise FileNotFoundError(f"Not found: {path}")

            if r.status_code != 200:
                if attempt < retries - 1:
                    await asyncio.sleep(2 ** (attempt + 1))
                    continue
                raise RuntimeError(f"HTTP {r.status_code}: {path}")

            data = r.json()
            if not data.get("success"):
                raise RuntimeError(f"API error: {data}")
            return data["data"]

        raise RuntimeError(f"Failed after {retries} retries: {path}")

    async def get_book(self, book_id: int) -> dict:
        data = await self._get(f"/api/books/{book_id}", params={
            "include": "author,creator,genres",
        })
        if isinstance(data, dict) and "book" in data:
            return data["book"]
        if isinstance(data, list) and data:
            b = data[0]
            return b.get("book", b)
        return data

    async def get_chapter(self, chapter_id: int) -> dict:
        return await self._get(f"/api/chapters/{chapter_id}")


async def download_book(client: AsyncBookClient, book_entry: dict, label: str) -> dict:
    book_id = book_entry["id"]
    expected_ch = book_entry.get("chapter_count", 0)
    first_chapter = book_entry.get("first_chapter")
    stats = {"book_id": book_id, "saved": 0, "skipped": 0, "errors": 0,
             "name": book_entry.get("name", "?"), "total": expected_ch}

    if not first_chapter:
        try:
            book = await client.get_book(book_id)
            if book.get("id") != book_id:
                print(f"{label} Book {book_id}: API mismatch (got {book.get('id')}) — skip")
                stats["errors"] = -1
                return stats
            first_chapter = book.get("first_chapter")
            expected_ch = book.get("chapter_count", expected_ch)
            stats["total"] = expected_ch
            stats["name"] = book.get("name", stats["name"])
            await asyncio.to_thread(save_metadata, book_id, book)
        except Exception as e:
            print(f"{label} Book {book_id}: metadata error — {e}")
            stats["errors"] = -1
            return stats
    else:
        try:
            book = await client.get_book(book_id)
            if book.get("id") == book_id:
                await asyncio.to_thread(save_metadata, book_id, book)
                expected_ch = book.get("chapter_count", expected_ch)
                stats["total"] = expected_ch
        except Exception:
            pass

    existing = await asyncio.to_thread(count_existing_chapters, book_id)
    remaining = expected_ch - len(existing)
    if remaining <= 0:
        print(f"{label} {stats['name'][:40]} — already complete ({len(existing)} ch)")
        stats["skipped"] = len(existing)
        return stats

    print(f"{label} {stats['name'][:45]} — {expected_ch} ch, {len(existing)} on disk, ~{remaining} to go")

    start_time = time.time()
    chapter_id = first_chapter

    while chapter_id:
        try:
            chapter = await client.get_chapter(chapter_id)
        except FileNotFoundError:
            break
        except Exception as e:
            print(f"{label} Fetch error ch={chapter_id}: {e}")
            stats["errors"] += 1
            break

        index = chapter.get("index", 0)
        slug = chapter.get("slug", f"chapter-{index}")
        ch_name = chapter.get("name", f"Chapter {index}")
        encrypted = chapter.get("content", "")

        next_info = chapter.get("next")
        chapter_id = next_info.get("id") if next_info else None

        if index in existing:
            stats["skipped"] += 1
            continue

        if not encrypted:
            stats["errors"] += 1
            continue

        try:
            plaintext = decrypt_content(encrypted)
            await asyncio.to_thread(save_chapter, book_id, index, slug, ch_name, plaintext)
            stats["saved"] += 1

            if stats["saved"] % 100 == 0 or stats["saved"] == 1:
                elapsed = time.time() - start_time
                rate = stats["saved"] / elapsed if elapsed > 0 else 0
                print(f"{label} [{index}/{expected_ch}] saved={stats['saved']} ({rate:.1f}/s)")
        except DecryptionError as e:
            print(f"{label} [{index}/{expected_ch}] DECRYPT FAIL: {e}")
            stats["errors"] += 1

    elapsed = time.time() - start_time
    rate = stats["saved"] / elapsed if elapsed > 0 else 0
    print(f"{label} DONE: {stats['saved']} saved, {stats['skipped']} skip, "
          f"{stats['errors']} err — {elapsed:.0f}s ({rate:.1f}/s)")
    return stats


async def main_async(books: list[dict], workers: int):
    client = AsyncBookClient(max_concurrent=MAX_CONCURRENT_REQUESTS)
    n = len(books)
    total_ch = sum(b.get("chapter_count", 0) for b in books)

    print(f"Downloading {n} books ({total_ch:,} chapters) with {workers} workers")
    print(f"Rate limit: {MAX_CONCURRENT_REQUESTS} concurrent reqs, {REQUEST_DELAY}s delay\n")
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
                print(f"  --- Progress: {completed['count']}/{n} books done ({elapsed/60:.0f}m) ---")

    worker_tasks = [asyncio.create_task(worker_loop()) for _ in range(workers)]
    await asyncio.gather(*worker_tasks)

    await client.close()

    elapsed = time.time() - start
    print(f"\n{'=' * 70}")
    print(f"SUMMARY  ({elapsed/60:.1f} min, {workers} workers)")
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
    print(f"\nTotal time: {elapsed/3600:.1f} hours")


def main():
    parser = argparse.ArgumentParser(description="Download top-1000 ranked books")
    parser.add_argument("-w", "--workers", type=int, default=DEFAULT_WORKERS)
    parser.add_argument("--exclude", nargs="*", type=int, default=[],
                        help="Book IDs to skip (e.g. already being downloaded elsewhere)")
    parser.add_argument("--plan", default=PLAN_FILE, help="Path to download plan JSON")
    parser.add_argument("--offset", type=int, default=0,
                        help="Skip first N books in the plan (for multi-machine split)")
    parser.add_argument("--limit", type=int, default=0,
                        help="Only download N books from the plan after offset (0=all)")
    args = parser.parse_args()

    with open(args.plan, encoding="utf-8") as f:
        plan = json.load(f)

    if isinstance(plan, list):
        books = [b for b in plan if b.get("first_chapter") and b.get("chapter_count", 0) > 0]
    else:
        books = plan.get("need_download", []) + plan.get("partial", [])

    exclude = set(args.exclude)
    if exclude:
        before = len(books)
        books = [b for b in books if b["id"] not in exclude]
        print(f"Excluded {before - len(books)} books (IDs: {sorted(exclude)})\n")

    if args.offset:
        print(f"Skipping first {args.offset} books (offset)\n")
        books = books[args.offset:]

    if args.limit:
        books = books[:args.limit]

    if not books:
        print("Nothing to download.")
        return

    asyncio.run(main_async(books, args.workers))


if __name__ == "__main__":
    main()
