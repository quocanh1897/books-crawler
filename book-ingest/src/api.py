"""Async API client for metruyencv mobile API.

Adapted from crawler-descryptor/src/downloader.py with the same
semaphore-based rate limiting and retry logic.
"""
from __future__ import annotations

import asyncio
from typing import Optional

import httpx

from .decrypt import DecryptionError, decrypt_content

# API configuration (same as crawler-descryptor/config.py)
import os

BASE_URL = "https://android.lonoapp.net"
BEARER_TOKEN = os.environ.get(
    "MTC_BEARER_TOKEN",
    "7045826|W0GmBOqfeWO0wWZUD7QpikPjvMsP1tq7Ayjq48pX",
)
HEADERS = {
    "authorization": f"Bearer {BEARER_TOKEN}",
    "x-app": "app.android",
    "user-agent": "Dart/3.5 (dart:io)",
    "content-type": "application/json",
}


class APIError(Exception):
    pass


class AsyncBookClient:
    """Async API client with semaphore-based rate limiting.

    Parameters
    ----------
    max_concurrent : int
        Maximum in-flight HTTP requests.
    request_delay : float
        Minimum seconds between requests (within semaphore).
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

    @property
    def client(self) -> httpx.AsyncClient:
        """Expose the underlying httpx client for cover downloads."""
        return self._client

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
                    raise APIError(f"Transport error: {e}")

            if r.status_code == 429:
                wait = int(r.headers.get("Retry-After", 2 ** (attempt + 2)))
                if attempt < retries - 1:
                    await asyncio.sleep(wait)
                    continue
                raise APIError(f"Rate limited after {retries} attempts")

            if r.status_code == 404:
                raise FileNotFoundError(f"Not found: {path}")

            if r.status_code != 200:
                if attempt < retries - 1:
                    await asyncio.sleep(2 ** (attempt + 1))
                    continue
                raise APIError(f"HTTP {r.status_code}: {path}")

            data = r.json()
            if not data.get("success"):
                raise APIError(f"API error: {data}")
            return data["data"]

        raise APIError(f"Failed after {retries} retries: {path}")

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


def decrypt_chapter(chapter: dict) -> tuple[str, str, str, int]:
    """Decrypt a chapter and extract title, slug, body, and word count.

    Returns (title, slug, body, word_count).
    """
    encrypted = chapter.get("content", "")
    if not encrypted:
        raise DecryptionError("Empty content")

    plaintext = decrypt_content(encrypted)

    index = chapter.get("index", 0)
    slug = chapter.get("slug", f"chapter-{index}")
    ch_name = chapter.get("name", f"Chương {index}")

    # Parse: first line is title, rest is body
    lines = plaintext.split("\n")
    title = lines[0].strip() if lines else ch_name

    # Skip empty lines and duplicate title line after the first line
    body_start = 1
    while body_start < len(lines) and lines[body_start].strip() == "":
        body_start += 1
    if body_start < len(lines) and lines[body_start].strip() == title:
        body_start += 1

    body = "\n".join(lines[body_start:]).strip()
    word_count = len(body.split())

    return title, slug, body, word_count
