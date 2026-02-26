"""Abstract base class for book data sources.

Each source (MTC, TTV, …) implements this interface to provide:
- Book metadata fetching
- Chapter content iteration (source handles its own walk strategy)
- Cover image downloading

The source abstraction lets ``ingest.py`` and ``generate_plan.py`` work
with any source through a uniform API, while each source encapsulates
its own transport (encrypted API, HTML scraping, etc.).
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import AsyncIterator
from typing import NamedTuple


class ChapterData(NamedTuple):
    """A single chapter's content, ready for compression."""

    index: int
    title: str
    slug: str
    body: str
    word_count: int
    chapter_id: int = 0


class BookSource(ABC):
    """Abstract base for book data sources.

    Subclasses must implement the four abstract methods and expose
    ``name``.  Sources are used as async context managers — the
    ``__aenter__`` / ``__aexit__`` pair handles HTTP client lifecycle.

    Example::

        source = MTCSource(max_concurrent=60)
        async with source:
            meta = await source.fetch_book_metadata(entry)
            async for ch in source.fetch_chapters(meta, existing, bundle_path):
                ...
    """

    # ── Identity ────────────────────────────────────────────────────────

    @property
    @abstractmethod
    def name(self) -> str:
        """Short identifier for this source (e.g. ``"mtc"``, ``"ttv"``)."""

    # ── Book metadata ───────────────────────────────────────────────────

    @abstractmethod
    async def fetch_book_metadata(self, entry: dict) -> dict | None:
        """Fetch full metadata for a book from the upstream source.

        *entry* comes from the plan file (has at least ``id``; may also
        have ``slug``, ``name``, ``chapter_count``, etc.).

        Returns a metadata dict compatible with
        :func:`src.db.upsert_book_metadata`, or ``None`` if the book
        was not found (404 / removed).

        Required keys in the returned dict::

            id, name, slug, chapter_count, status, status_name,
            author, genres, tags, synopsis,
            view_count, bookmark_count, vote_count, comment_count,
            review_score, review_count, word_count,
            created_at, updated_at, published_at, new_chap_at

        MTC-specific extras (used by the walk strategy)::

            first_chapter, latest_chapter, poster
        """

    # ── Chapter iteration ───────────────────────────────────────────────

    @abstractmethod
    def fetch_chapters(
        self,
        meta: dict,
        existing_indices: set[int],
        bundle_path: str,
    ) -> AsyncIterator[ChapterData]:
        """Async generator that yields chapters not yet on disk.

        Each source implements its own walk strategy:

        * **MTC** — linked-list traversal via ``chapter_id`` with
          forward / reverse / resume modes.  Reads bundle metadata to
          determine where to resume.
        * **TTV** — sequential URL iteration (``chuong-1`` …
          ``chuong-N``), skipping indices in *existing_indices*.

        Parameters
        ----------
        meta:
            The full metadata dict returned by :meth:`fetch_book_metadata`.
        existing_indices:
            Set of chapter index numbers already stored in the bundle
            and/or DB.  The generator **must not** yield these indices.
        bundle_path:
            Path to the ``.bundle`` file (may not exist yet).  MTC uses
            this to read inline metadata for resume; TTV ignores it.

        Yields
        ------
        ChapterData
            ``(index, title, slug, body, word_count)`` for each
            successfully fetched chapter.  Failed chapters are logged
            internally and skipped.
        """

    # ── Cover downloading ───────────────────────────────────────────────

    @abstractmethod
    async def download_cover(
        self,
        book_id: int,
        meta: dict,
        covers_dir: str,
    ) -> str | None:
        """Download the cover image for a book.

        Parameters
        ----------
        book_id:
            Numeric book ID (used for the filename).
        meta:
            Full metadata dict (source reads ``poster`` or ``cover_url``
            from it).
        covers_dir:
            Directory to save the image in (e.g. ``binslib/public/covers``).

        Returns
        -------
        str | None
            ``"/covers/{book_id}.jpg"`` on success, ``None`` on failure
            or if no cover is available.  Skips download if the file
            already exists on disk.
        """

    # ── Lifecycle ───────────────────────────────────────────────────────

    async def close(self) -> None:
        """Release underlying HTTP clients / resources.

        Override in subclasses that hold async resources.
        """

    async def __aenter__(self) -> BookSource:
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.close()
