#!/usr/bin/env python3
"""Batch download books from books_to_crawl.json.

Usage:
    python batch_download.py                       # download all discovered books
    python batch_download.py -w 5                  # 5 concurrent workers
    python batch_download.py --limit 100           # only first 100 books
    python batch_download.py --skip-existing        # skip books with any chapters on disk
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time

from config import BASE_URL, OUTPUT_DIR, REQUEST_DELAY
from src.client import AsyncTangThuVienClient, FetchError, NotFound
from src.parser import parse_book_detail, parse_chapter
from src.utils import (
    count_existing_chapters,
    get_or_create_book_id,
    get_output_dir,
    save_chapter,
    save_cover,
    save_metadata,
)

BOOKS_FILE = os.path.join(os.path.dirname(__file__), "books_to_crawl.json")
STATUS_FILE = os.path.join(os.path.dirname(__file__), "download_status.json")


def load_status() -> dict:
    if os.path.exists(STATUS_FILE):
        with open(STATUS_FILE, "r") as f:
            return json.load(f)
    return {}


def save_status(status: dict):
    with open(STATUS_FILE, "w") as f:
        json.dump(status, f, indent=2, ensure_ascii=False)


def _append_error_log(book_id: int, ch_idx: int, error_type: str, detail: str):
    """Append a line to the book's errors.log file."""
    out_dir = get_output_dir(book_id)
    log_path = os.path.join(out_dir, "errors.log")
    ts = time.strftime("%Y-%m-%d %H:%M:%S")
    with open(log_path, "a", encoding="utf-8") as f:
        f.write(f"{ts}\tchuong-{ch_idx}\t{error_type}\t{detail}\n")


async def download_book(client: AsyncTangThuVienClient, slug: str, delay: float) -> dict:
    """Download a single book: metadata, cover, and all chapters. Returns a result dict."""
    result = {"slug": slug, "status": "ok", "chapters_saved": 0, "errors": 0, "error_chapters": []}

    try:
        html = await client.get_html(f"{BASE_URL}/doc-truyen/{slug}")
        meta = parse_book_detail(html, slug)
    except Exception as e:
        result["status"] = f"meta_failed: {e}"
        return result

    book_id = get_or_create_book_id(slug)
    meta["id"] = book_id
    chapter_links = meta.pop("_chapter_links", [])
    save_metadata(book_id, meta)

    # Download cover
    cover_url = meta.get("cover_url", "")
    if cover_url and "default-book" not in cover_url:
        try:
            img_bytes = await client.get_bytes(cover_url)
            save_cover(book_id, img_bytes)
        except Exception:
            pass

    total = meta["chapter_count"]
    if total == 0:
        result["status"] = "no_chapters"
        return result

    existing = count_existing_chapters(book_id)

    for ch_idx in range(1, total + 1):
        if ch_idx in existing:
            continue

        ch_url = f"{BASE_URL}/doc-truyen/{slug}/chuong-{ch_idx}"
        try:
            ch_html = await client.get_html(ch_url)
            parsed = parse_chapter(ch_html)
            if not parsed:
                result["errors"] += 1
                result["error_chapters"].append(ch_idx)
                _append_error_log(book_id, ch_idx, "ParseFailed", "parser returned None")
                continue

            ch_slug = f"chuong-{ch_idx}"
            save_chapter(book_id, ch_idx, ch_slug, parsed["title"], parsed["body"])
            result["chapters_saved"] += 1
        except NotFound:
            result["errors"] += 1
            result["error_chapters"].append(ch_idx)
            _append_error_log(book_id, ch_idx, "NotFound", "404")
            continue
        except FetchError as e:
            result["errors"] += 1
            result["error_chapters"].append(ch_idx)
            _append_error_log(book_id, ch_idx, "FetchError", str(e))
            continue

    return result


async def worker(
    name: str,
    queue: asyncio.Queue,
    client: AsyncTangThuVienClient,
    delay: float,
    results: list[dict],
    total: int,
):
    """Worker coroutine that pulls slugs from the queue and downloads them."""
    while True:
        idx, slug = await queue.get()
        start = time.time()
        print(f"  [{idx}/{total}] {name}: {slug}...")

        result = await download_book(client, slug, delay)
        elapsed = time.time() - start

        results.append(result)
        status_str = result["status"]
        ch_saved = result["chapters_saved"]
        errs = result["errors"]
        print(f"  [{idx}/{total}] {name}: {slug} -> {status_str}, {ch_saved} chapters, {errs} errors ({elapsed:.0f}s)")

        queue.task_done()


async def run_batch(
    books: list[dict],
    workers: int = 3,
    delay: float = REQUEST_DELAY,
    max_concurrent: int = 20,
):
    """Run batch download with the given number of workers."""
    status = load_status()
    queue: asyncio.Queue = asyncio.Queue()
    results: list[dict] = []
    total = len(books)

    for i, book in enumerate(books, 1):
        slug = book["slug"]
        if slug in status and status[slug].get("status") == "ok":
            continue
        queue.put_nowait((i, slug))

    pending = queue.qsize()
    print(f"Batch download: {pending} books to process ({total - pending} already done)")
    print(f"  Workers: {min(workers, pending)}, delay: {delay}s, max concurrent requests: {max_concurrent}")

    if pending == 0:
        print("Nothing to do!")
        return

    async with AsyncTangThuVienClient(delay=delay, max_concurrent=max_concurrent) as client:
        tasks = []
        for i in range(min(workers, pending)):
            task = asyncio.create_task(
                worker(f"W{i+1}", queue, client, delay, results, total)
            )
            tasks.append(task)

        await queue.join()

        for task in tasks:
            task.cancel()

    # Update status file
    for r in results:
        status[r["slug"]] = r
    save_status(status)

    # Summary
    ok = sum(1 for r in results if r["status"] == "ok")
    failed = sum(1 for r in results if r["status"] != "ok")
    total_chapters = sum(r["chapters_saved"] for r in results)
    print(f"\nBatch complete: {ok} succeeded, {failed} failed, {total_chapters} chapters saved")


def main():
    parser = argparse.ArgumentParser(description="Batch download books from tangthuvien")
    parser.add_argument("-w", "--workers", type=int, default=3, help="Number of concurrent workers (default: 3)")
    parser.add_argument("--delay", type=float, default=0.05, help="Per-request delay in seconds (default: 0.05)")
    parser.add_argument("--max-concurrent", type=int, default=20, help="Max concurrent HTTP requests (default: 20)")
    parser.add_argument("--limit", type=int, default=0, help="Only process first N books")
    parser.add_argument("--input", default=BOOKS_FILE, help="Input JSON file")
    parser.add_argument("--reset", action="store_true", help="Reset download status and re-download all")
    args = parser.parse_args()

    if not os.path.exists(args.input):
        print(f"Error: {args.input} not found. Run discover.py first.")
        sys.exit(1)

    with open(args.input, "r") as f:
        books = json.load(f)

    if args.limit > 0:
        books = books[:args.limit]

    if args.reset and os.path.exists(STATUS_FILE):
        os.remove(STATUS_FILE)

    print(f"Loaded {len(books)} books from {args.input}")
    asyncio.run(run_batch(
        books,
        workers=args.workers,
        delay=args.delay,
        max_concurrent=args.max_concurrent,
    ))


if __name__ == "__main__":
    main()
