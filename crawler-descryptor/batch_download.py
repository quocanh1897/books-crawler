#!/usr/bin/env python3
"""
Parallel batch download of books via the mobile API.

Downloads multiple books concurrently using asyncio + httpx.AsyncClient.
Each book's chapters are fetched following the `next` chain, but multiple
books download simultaneously for N-fold throughput.

Usage:
    python3 batch_download.py                        # download preset list
    python3 batch_download.py 100441 151531          # specific book IDs
    python3 batch_download.py -w 6                   # 6 parallel workers
    python3 batch_download.py --clean                # remove wrong data first
"""
from __future__ import annotations

import asyncio
import argparse
import os
import sys
import time
import traceback

import httpx

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "crawler"))
from config import BASE_URL, HEADERS

from src.decrypt import DecryptionError, decrypt_content
from src.utils import count_existing_chapters, save_chapter, save_metadata, get_output_dir

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


class AsyncBookClient:
    """Async API client with shared rate-limiting semaphore."""

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


async def download_book(client: AsyncBookClient, book_id: int, label: str) -> dict:
    """Download all chapters for a book, following the next-chapter chain."""
    stats = {"book_id": book_id, "saved": 0, "skipped": 0, "errors": 0,
             "name": "?", "total": 0}

    try:
        book = await client.get_book(book_id)
    except Exception as e:
        print(f"{label} Book {book_id}: metadata error — {e}")
        stats["errors"] = -1
        return stats

    if book.get("id") != book_id:
        print(f"{label} Book {book_id}: API returned wrong id={book.get('id')} — skipping")
        stats["errors"] = -1
        return stats

    name = book.get("name", f"Book {book_id}")
    total = book.get("chapter_count", 0)
    first_id = book.get("first_chapter")
    stats["name"] = name
    stats["total"] = total

    print(f"{label} {name} — {total} chapters")

    if not first_id:
        print(f"{label} No first_chapter — skipping")
        return stats

    save_metadata(book_id, book)

    existing = count_existing_chapters(book_id)
    remaining = total - len(existing) if existing else total
    if existing:
        print(f"{label} {len(existing)} already on disk, ~{remaining} remaining")

    start_time = time.time()
    chapter_id = first_id

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
            save_chapter(book_id, index, slug, ch_name, plaintext)
            stats["saved"] += 1

            if stats["saved"] % 50 == 0 or stats["saved"] == 1:
                elapsed = time.time() - start_time
                rate = stats["saved"] / elapsed if elapsed > 0 else 0
                print(f"{label} [{index}/{total}] saved={stats['saved']} ({rate:.1f}/s)")
        except DecryptionError as e:
            print(f"{label} [{index}/{total}] DECRYPT FAIL: {e}")
            stats["errors"] += 1

    elapsed = time.time() - start_time
    rate = stats["saved"] / elapsed if elapsed > 0 else 0
    print(f"{label} DONE: {stats['saved']} saved, {stats['skipped']} skipped, "
          f"{stats['errors']} errors — {elapsed:.0f}s ({rate:.1f}/s)")
    return stats


def clean_wrong_downloads(book_ids: list[int]):
    """Remove chapters + metadata that were downloaded from the wrong book
    (the old sequential run used a broken filter[id] endpoint)."""
    import json
    for bid in book_ids:
        out_dir = os.path.join(os.path.dirname(__file__), "..", "crawler", "output", str(bid))
        meta_path = os.path.join(out_dir, "metadata.json")
        if not os.path.exists(meta_path):
            continue
        try:
            with open(meta_path) as f:
                meta = json.load(f)
            if meta.get("id") != bid:
                wrong_id = meta.get("id")
                files = [f for f in os.listdir(out_dir) if f.endswith(".txt") and f[0].isdigit()]
                print(f"  {bid}: removing {len(files)} chapters from wrong book (api_id={wrong_id})")
                for fname in files:
                    os.remove(os.path.join(out_dir, fname))
                os.remove(meta_path)
            else:
                print(f"  {bid}: metadata OK (id matches)")
        except Exception as e:
            print(f"  {bid}: error checking — {e}")


async def main_async(book_ids: list[int], workers: int):
    client = AsyncBookClient(max_concurrent=MAX_CONCURRENT_REQUESTS)

    n = len(book_ids)
    print(f"Downloading {n} books with up to {workers} parallel workers")
    print(f"Rate limit: {MAX_CONCURRENT_REQUESTS} concurrent requests, "
          f"{REQUEST_DELAY}s delay per request\n")
    start = time.time()

    book_sem = asyncio.Semaphore(workers)

    async def bounded(bid: int, idx: int) -> dict:
        async with book_sem:
            return await download_book(client, bid, f"[{idx}/{n}]")

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
        tag = "OK" if r["saved"] > 0 else ("SKIP" if r.get("errors", 0) == 0 else "FAIL")
        print(f"  {r['book_id']:>6} | {r['saved']:>5}/{r['total']:<5} saved | "
              f"{r.get('errors', 0):>3} err | {tag} | {r['name']}")
        total_saved += r["saved"]
        total_errors += max(0, r.get("errors", 0))

    print(f"\nTotal: {total_saved} chapters saved, {total_errors} errors")


def main():
    parser = argparse.ArgumentParser(description="Parallel batch book downloader")
    parser.add_argument("book_ids", nargs="*", type=int,
                        help="Book IDs (default: preset EMPTY_FOLDER list)")
    parser.add_argument("-w", "--workers", type=int, default=DEFAULT_WORKERS,
                        help=f"Parallel book downloads (default: {DEFAULT_WORKERS})")
    parser.add_argument("--clean", action="store_true",
                        help="Remove wrongly-downloaded chapters before starting")
    args = parser.parse_args()

    book_ids = args.book_ids or EMPTY_FOLDER_BOOKS

    if args.clean:
        print("Cleaning wrongly-downloaded data...")
        clean_wrong_downloads(book_ids)
        print()

    asyncio.run(main_async(book_ids, args.workers))


if __name__ == "__main__":
    main()
