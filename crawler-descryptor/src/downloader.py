"""
Shared async download engine for crawler-descryptor.

Provides AsyncBookClient and download_book() used by both download_topN.py
and download_batch.py.  Each caller configures concurrency / delay to match
its workload (bulk plan-file downloads vs small ad-hoc batches).

Usage (from another script):

    from src.downloader import AsyncBookClient, download_book

    client = AsyncBookClient(max_concurrent=180, request_delay=0.015)
    stats  = await download_book(client, {"id": 100358}, "[1/1]")
    await client.close()
"""

from __future__ import annotations

import asyncio
import os
import sys
import time
from typing import Optional

import httpx

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from config import BASE_URL, HEADERS

from .decrypt import DecryptionError, decrypt_content
from .utils import count_existing_chapters, save_chapter, save_metadata

# ─── Async API Client ─────────────────────────────────────────────────────────


class AsyncBookClient:
    """Async API client with shared semaphore-based rate limiting.

    Parameters
    ----------
    max_concurrent : int
        Maximum number of in-flight HTTP requests (semaphore size).
    request_delay : float
        Minimum seconds to sleep before each request (within the semaphore).
    timeout : float
        Per-request timeout in seconds.
    """

    def __init__(
        self,
        max_concurrent: int = 180,
        request_delay: float = 0.015,
        timeout: float = 30,
    ):
        self._client = httpx.AsyncClient(headers=HEADERS, timeout=timeout)
        self._sem = asyncio.Semaphore(max_concurrent)
        self._delay = request_delay

    async def close(self):
        await self._client.aclose()

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        await self.close()

    async def _get(
        self, path: str, params: Optional[dict] = None, retries: int = 3
    ) -> dict:
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
        """Fetch book metadata (includes author, genres)."""
        data = await self._get(
            f"/api/books/{book_id}",
            params={"include": "author,creator,genres"},
        )
        if isinstance(data, dict) and "book" in data:
            return data["book"]
        if isinstance(data, list) and data:
            b = data[0]
            return b.get("book", b)
        return data

    async def get_chapter(self, chapter_id: int) -> dict:
        """Fetch a single chapter (content is encrypted)."""
        return await self._get(f"/api/chapters/{chapter_id}")


# ─── Per-book download logic ──────────────────────────────────────────────────


async def download_book(
    client: AsyncBookClient,
    book_entry: dict,
    label: str,
) -> dict:
    """Download all missing chapters for a single book.

    Parameters
    ----------
    client : AsyncBookClient
        The shared HTTP client.
    book_entry : dict
        Must contain ``"id"`` (int).  May also contain ``"first_chapter"``,
        ``"chapter_count"``, and ``"name"`` from a plan file.  If
        ``first_chapter`` is missing the function fetches metadata from the
        API first.
    label : str
        A prefix for log lines, e.g. ``"[3/100]"``.

    Returns
    -------
    dict
        ``{"book_id", "name", "total", "saved", "skipped", "errors"}``
        *errors == -1* signals a fatal skip (metadata failure, ID mismatch).
    """
    book_id = book_entry["id"]
    expected_ch = book_entry.get("chapter_count", 0)
    first_chapter = book_entry.get("first_chapter")
    stats: dict = {
        "book_id": book_id,
        "name": book_entry.get("name", "?"),
        "total": expected_ch,
        "saved": 0,
        "skipped": 0,
        "errors": 0,
    }

    # ── Fetch metadata if not provided in the plan entry ──────────────────
    if not first_chapter:
        try:
            book = await client.get_book(book_id)
            if book.get("id") != book_id:
                print(
                    f"{label} Book {book_id}: API mismatch "
                    f"(got {book.get('id')}) — skip"
                )
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
        # Even when the plan supplies first_chapter, try to refresh metadata
        # so the saved metadata.json stays current.
        try:
            book = await client.get_book(book_id)
            if book.get("id") == book_id:
                await asyncio.to_thread(save_metadata, book_id, book)
                expected_ch = book.get("chapter_count", expected_ch)
                stats["total"] = expected_ch
                stats["name"] = book.get("name", stats["name"])
        except Exception:
            pass  # non-fatal — we already have plan metadata

    if not first_chapter:
        print(f"{label} Book {book_id}: no first_chapter — skip")
        stats["errors"] = -1
        return stats

    # ── Check existing chapters (txt files + bundle) ──────────────────────
    existing = await asyncio.to_thread(count_existing_chapters, book_id)
    remaining = expected_ch - len(existing)
    if remaining <= 0:
        print(f"{label} {stats['name'][:40]} — already complete ({len(existing)} ch)")
        stats["skipped"] = len(existing)
        return stats

    print(
        f"{label} {stats['name'][:45]} — {expected_ch} ch, "
        f"{len(existing)} done, ~{remaining} to go"
    )

    # ── Walk the chapter linked-list ──────────────────────────────────────
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
            await asyncio.to_thread(
                save_chapter, book_id, index, slug, ch_name, plaintext
            )
            stats["saved"] += 1

            if stats["saved"] % 100 == 0 or stats["saved"] == 1:
                elapsed = time.time() - start_time
                rate = stats["saved"] / elapsed if elapsed > 0 else 0
                print(
                    f"{label} [{index}/{expected_ch}] "
                    f"saved={stats['saved']} ({rate:.1f}/s)"
                )
        except DecryptionError as e:
            print(f"{label} [{index}/{expected_ch}] DECRYPT FAIL: {e}")
            stats["errors"] += 1

    elapsed = time.time() - start_time
    rate = stats["saved"] / elapsed if elapsed > 0 else 0
    print(
        f"{label} DONE: {stats['saved']} saved, {stats['skipped']} skip, "
        f"{stats['errors']} err — {elapsed:.0f}s ({rate:.1f}/s)"
    )
    return stats
