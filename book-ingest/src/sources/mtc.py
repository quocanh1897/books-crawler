"""MTC source — metruyencv.com mobile API.

Wraps the existing :mod:`src.api` client, AES decryption, and the
linked-list chapter walk strategy (forward / reverse / resume).
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator

from ..api import APIError, AsyncBookClient, decrypt_chapter
from ..bundle import read_bundle_meta
from ..cover import download_cover as _download_cover
from ..decrypt import DecryptionError
from .base import BookSource, ChapterData

log = logging.getLogger("book-ingest.mtc")


class MTCSource(BookSource):
    """Book source backed by the metruyencv mobile API.

    Parameters
    ----------
    max_concurrent:
        Maximum in-flight HTTP requests (shared semaphore).
    request_delay:
        Minimum seconds between requests inside the semaphore.
    timeout:
        Per-request timeout in seconds.
    """

    def __init__(
        self,
        max_concurrent: int = 180,
        request_delay: float = 0.015,
        timeout: float = 30,
    ):
        self._client = AsyncBookClient(
            max_concurrent=max_concurrent,
            request_delay=request_delay,
            timeout=timeout,
        )

    # ── Identity ────────────────────────────────────────────────────────

    @property
    def name(self) -> str:
        return "mtc"

    # ── Book metadata ───────────────────────────────────────────────────

    async def fetch_book_metadata(self, entry: dict) -> dict | None:
        """Fetch metadata from the MTC mobile API.

        Returns the raw API book dict (id, name, slug, chapter_count,
        first_chapter, latest_chapter, poster, author, genres, …) or
        ``None`` when the book cannot be found or the response is invalid.
        """
        book_id = entry["id"]
        try:
            meta = await self._client.get_book(book_id)
        except FileNotFoundError:
            log.info("SKIP %d: not found on API", book_id)
            return None
        except (APIError, Exception) as exc:
            log.warning("SKIP %d: metadata error — %s", book_id, exc)
            return None

        if meta.get("id") != book_id:
            log.warning("SKIP %d: API ID mismatch (got %s)", book_id, meta.get("id"))
            return None

        return meta

    # ── Chapter iteration ───────────────────────────────────────────────

    async def fetch_chapters(
        self,
        meta: dict,
        existing_indices: set[int],
        bundle_path: str,
    ) -> AsyncIterator[ChapterData]:
        """Walk chapters via the MTC linked-list API.

        Determines the best walk strategy (resume / reverse / forward)
        based on what is already stored in the bundle, then yields
        chapters that are **not** in *existing_indices*.

        Walk strategies
        ~~~~~~~~~~~~~~~
        * **Resume** — the bundle stores the ``chapter_id`` of the last
          chapter.  Fetch it to obtain ``next.id`` and continue forward.
        * **Reverse** — walk backwards from ``latest_chapter`` via
          ``previous.id``, stopping at the first existing index.
        * **Forward** — walk from ``first_chapter`` via ``next.id``.
        """
        book_id = meta["id"]
        book_name = meta.get("name", "?")
        first_chapter = meta.get("first_chapter")
        latest_chapter = meta.get("latest_chapter")

        # ── determine walk strategy ─────────────────────────────────────

        walk_chapter_id, walk_reverse = await self._plan_walk(
            book_id,
            book_name,
            first_chapter,
            latest_chapter,
            existing_indices,
            bundle_path,
        )

        if walk_chapter_id is None:
            return  # nothing to do (already at last chapter or no start)

        # ── execute walk ────────────────────────────────────────────────

        if walk_reverse:
            async for ch in self._walk_reverse(
                book_id, book_name, walk_chapter_id, existing_indices
            ):
                yield ch
        else:
            async for ch in self._walk_forward(
                book_id, book_name, walk_chapter_id, existing_indices
            ):
                yield ch

    # ── Cover ───────────────────────────────────────────────────────────

    async def download_cover(
        self,
        book_id: int,
        meta: dict,
        covers_dir: str,
    ) -> str | None:
        """Download cover via the poster URLs in the MTC metadata."""
        return await _download_cover(
            self._client.client,
            book_id,
            meta.get("poster"),
            covers_dir,
        )

    # ── Lifecycle ───────────────────────────────────────────────────────

    async def close(self) -> None:
        await self._client.close()

    # ── Internal: walk planning ─────────────────────────────────────────

    async def _plan_walk(
        self,
        book_id: int,
        book_name: str,
        first_chapter: int | None,
        latest_chapter: int | None,
        existing_indices: set[int],
        bundle_path: str,
    ) -> tuple[int | None, bool]:
        """Decide where to start walking and in which direction.

        Returns ``(start_chapter_id, is_reverse)``.  ``start_chapter_id``
        is ``None`` when there is nothing to fetch.
        """
        if not existing_indices:
            # No bundle at all — full forward walk
            return first_chapter, False

        max_bundle_idx = max(existing_indices)
        bundle_meta_map = await asyncio.to_thread(read_bundle_meta, bundle_path)
        last_meta = bundle_meta_map.get(max_bundle_idx)

        if last_meta and last_meta.chapter_id:
            return await self._plan_resume(
                book_id,
                book_name,
                last_meta.chapter_id,
                max_bundle_idx,
                first_chapter,
                latest_chapter,
            )

        # No stored chapter_id (v1 bundle or empty meta) — reverse walk
        if latest_chapter:
            log.info(
                "  REVERSE %d: no stored ch_id, walking back from latest=%d",
                book_id,
                latest_chapter,
            )
            return latest_chapter, True

        return first_chapter, False

    async def _plan_resume(
        self,
        book_id: int,
        book_name: str,
        stored_chapter_id: int,
        max_bundle_idx: int,
        first_chapter: int | None,
        latest_chapter: int | None,
    ) -> tuple[int | None, bool]:
        """Attempt O(missing) resume from the last stored chapter_id."""
        try:
            last_ch = await self._client.get_chapter(stored_chapter_id)
            returned_idx = last_ch.get("index", -1)

            if returned_idx != max_bundle_idx:
                log.error(
                    "  FATAL %d: resume ch_id=%d returned index=%d, expected %d",
                    book_id,
                    stored_chapter_id,
                    returned_idx,
                    max_bundle_idx,
                )
                return None, False

            next_info = last_ch.get("next")
            walk_id = next_info.get("id") if next_info else None

            if walk_id:
                log.info(
                    "  RESUME %d: last_index=%d -> forward from ch_id=%d",
                    book_id,
                    max_bundle_idx,
                    walk_id,
                )
            else:
                log.info("  RESUME %d: already at last chapter", book_id)

            return walk_id, False

        except FileNotFoundError:
            # Stored chapter_id is stale — try reverse walk from latest
            if latest_chapter:
                log.info(
                    "  REVERSE %d: stored ch_id 404, walking back from latest=%d",
                    book_id,
                    latest_chapter,
                )
                return latest_chapter, True

            log.info(
                "  FALLBACK %d: stored ch_id 404, no latest_chapter, full forward walk",
                book_id,
            )
            return first_chapter, False

        except Exception as exc:
            log.warning(
                "  RESUME ERROR %d: %s, falling back to forward walk",
                book_id,
                exc,
            )
            return first_chapter, False

    # ── Internal: walk execution ────────────────────────────────────────

    async def _walk_forward(
        self,
        book_id: int,
        book_name: str,
        start_chapter_id: int,
        existing_indices: set[int],
    ) -> AsyncIterator[ChapterData]:
        """Walk forward via ``next.id``, yielding new chapters."""
        ch_id: int | None = start_chapter_id

        while ch_id:
            try:
                chapter = await self._client.get_chapter(ch_id)
            except FileNotFoundError:
                break
            except Exception as exc:
                log.warning("  ch fetch error %d ch_id=%d: %s", book_id, ch_id, exc)
                break

            index = chapter.get("index", 0)
            next_info = chapter.get("next")
            ch_id = next_info.get("id") if next_info else None

            if index in existing_indices:
                continue

            ch_data = self._decrypt(book_id, chapter)
            if ch_data is not None:
                yield ch_data

    async def _walk_reverse(
        self,
        book_id: int,
        book_name: str,
        start_chapter_id: int,
        existing_indices: set[int],
    ) -> AsyncIterator[ChapterData]:
        """Walk backwards via ``previous.id``, stopping at first existing."""
        ch_id: int | None = start_chapter_id

        while ch_id:
            try:
                chapter = await self._client.get_chapter(ch_id)
            except FileNotFoundError:
                break
            except Exception as exc:
                log.warning("  ch fetch error %d ch_id=%d: %s", book_id, ch_id, exc)
                break

            if chapter.get("index", 0) in existing_indices:
                break  # reached existing data; all prior chapters should exist

            ch_data = self._decrypt(book_id, chapter)
            if ch_data is not None:
                yield ch_data

            prev_info = chapter.get("previous")
            ch_id = prev_info.get("id") if prev_info else None

    # ── Internal: decrypt helper ────────────────────────────────────────

    @staticmethod
    def _decrypt(book_id: int, chapter: dict) -> ChapterData | None:
        """Decrypt a single chapter and return :class:`ChapterData`.

        Returns ``None`` (and logs) on empty content or decryption failure.
        """
        index = chapter.get("index", 0)
        ch_id = chapter.get("id", 0)
        encrypted = chapter.get("content", "")

        if not encrypted:
            log.warning("  EMPTY %d[%d]: no content", book_id, index)
            return None

        try:
            title, slug, body, word_count = decrypt_chapter(chapter)
        except DecryptionError as exc:
            log.warning("  DECRYPT FAIL %d[%d]: %s", book_id, index, exc)
            return None

        return ChapterData(
            index=index,
            title=title,
            slug=slug,
            body=body,
            word_count=word_count,
            chapter_id=ch_id,
        )
