"""
API client for fetching chapters and book metadata from the mobile API.

Uses the same authentication as the crawler (Bearer token from config.py).
"""

from __future__ import annotations

import os
import sys
import time

import httpx

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from config import BASE_URL, HEADERS, MAX_RETRIES, REQUEST_DELAY


class APIError(Exception):
    pass


class ChapterNotFound(APIError):
    pass


class RateLimited(APIError):
    pass


class APIClient:
    def __init__(self, delay: float = REQUEST_DELAY, max_retries: int = MAX_RETRIES):
        self.delay = delay
        self.max_retries = max_retries
        self._client = httpx.Client(headers=HEADERS, timeout=30)
        self._last_request = 0.0

    def close(self):
        self._client.close()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()

    def _throttle(self):
        elapsed = time.time() - self._last_request
        if elapsed < self.delay:
            time.sleep(self.delay - elapsed)
        self._last_request = time.time()

    def _get(self, path: str, params: dict | None = None) -> dict:
        for attempt in range(self.max_retries):
            self._throttle()
            try:
                r = self._client.get(f"{BASE_URL}{path}", params=params)
            except httpx.TransportError as e:
                if attempt < self.max_retries - 1:
                    wait = 2 ** (attempt + 1)
                    time.sleep(wait)
                    continue
                raise APIError(f"Transport error after {self.max_retries} retries: {e}")

            if r.status_code == 429:
                wait = int(r.headers.get("Retry-After", 2 ** (attempt + 2)))
                if attempt < self.max_retries - 1:
                    time.sleep(wait)
                    continue
                raise RateLimited(f"Rate limited, retry after {wait}s")

            if r.status_code == 404:
                raise ChapterNotFound(f"Not found: {path}")

            if r.status_code != 200:
                raise APIError(f"HTTP {r.status_code}: {path}")

            data = r.json()
            if not data.get("success"):
                raise APIError(f"API error: {data}")
            return data["data"]

        raise APIError(f"Failed after {self.max_retries} retries")

    def get_chapter(self, chapter_id: int) -> dict:
        """Fetch a single chapter. Returns the chapter data dict.

        The `content` field is encrypted. Use decrypt.decrypt_content() on it.
        The `next` field (if present) contains {id, name, index} of the next chapter.
        """
        return self._get(f"/api/chapters/{chapter_id}")

    def get_book(self, book_id: int) -> dict:
        """Fetch book metadata via direct ID lookup."""
        data = self._get(
            f"/api/books/{book_id}",
            params={
                "include": "author,creator,genres",
            },
        )
        if isinstance(data, dict) and "book" in data:
            return data["book"]
        if isinstance(data, list) and data:
            book = data[0]
            return book.get("book", book)
        return data

    def search_book(self, name: str) -> dict | None:
        """Search for a book by name. Returns first match or None."""
        try:
            data = self._get(
                "/api/books",
                params={
                    "filter[keyword]": name,
                    "limit": 5,
                },
            )
        except APIError:
            data = None

        if isinstance(data, list) and data:
            book = data[0]
            return book.get("book", book)

        # Fallback to fuzzy search
        try:
            data = self._get(
                "/api/books/search",
                params={
                    "keyword": name,
                    "limit": 5,
                },
            )
        except APIError:
            return None

        if isinstance(data, list) and data:
            book = data[0]
            return book.get("book", book)
        return None

    def iter_chapters(self, first_chapter_id: int, max_chapters: int = 0):
        """Yield chapter dicts starting from first_chapter_id, following `next` links.

        Args:
            first_chapter_id: The chapter ID to start from.
            max_chapters: Stop after this many (0 = no limit).

        Yields:
            Chapter data dicts (with encrypted `content`).
        """
        chapter_id = first_chapter_id
        count = 0

        while chapter_id:
            try:
                chapter = self.get_chapter(chapter_id)
            except ChapterNotFound:
                break
            except APIError as e:
                print(f"  Error fetching chapter {chapter_id}: {e}")
                break

            yield chapter
            count += 1
            if max_chapters and count >= max_chapters:
                break

            next_info = chapter.get("next")
            chapter_id = next_info.get("id") if next_info else None
