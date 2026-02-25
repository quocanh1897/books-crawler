"""
Core EPUB building logic.

Reads chapter bodies from BLIB bundle files (zstd-compressed), metadata from
SQLite, and cover images from binslib/public/covers/.  No dependency on
crawler/output/ — everything comes from the binslib data layer.
"""

from __future__ import annotations

import re
import sqlite3
import struct
from pathlib import Path

import pyzstd
from ebooklib import epub
from PIL import Image

# ── Constants ────────────────────────────────────────────────────────────────

BOOK_CSS = """\
@charset "UTF-8";
body {
    font-family: "Noto Serif", "Times New Roman", serif;
    line-height: 1.8;
    margin: 1em;
    padding: 0;
    color: #1a1a1a;
}
h1 {
    font-size: 1.6em;
    text-align: center;
    margin: 1.5em 0 1em;
    color: #2c3e50;
}
h2 {
    font-size: 1.3em;
    text-align: center;
    margin: 1.2em 0 0.8em;
    color: #34495e;
}
p {
    text-indent: 1.5em;
    margin: 0.4em 0;
    text-align: justify;
}
.cover-page {
    text-align: center;
    padding: 0;
    margin: 0;
}
.cover-page img {
    max-width: 100%;
    max-height: 100%;
}
"""

# ── BLIB bundle constants ────────────────────────────────────────────────────

BUNDLE_MAGIC = b"BLIB"
_HEADER_MIN = 12  # magic(4) + version(4) + count(4)
_HEADER_V2 = 16  # + meta_entry_size(2) + reserved(2)
_ENTRY_SIZE = 16  # indexNum(4) + offset(4) + compLen(4) + rawLen(4)
_META_TITLE_MAX = 196
_META_SLUG_MAX = 48


# ── Bundle reader ────────────────────────────────────────────────────────────


class BundleReader:
    """Read-only interface to a BLIB v1/v2 bundle file.

    Lazily parses the header and index on first access.  Chapter bodies are
    decompressed on demand using the supplied zstd dictionary.
    """

    def __init__(self, bundle_path: Path, dict_path: Path | None = None):
        self.path = bundle_path
        self._dict: pyzstd.ZstdDict | None = None
        if dict_path and dict_path.exists():
            with open(dict_path, "rb") as f:
                self._dict = pyzstd.ZstdDict(f.read())

        self._version: int = 0
        self._count: int = 0
        self._header_size: int = 0
        self._meta_entry_size: int = 0
        # index_num → (offset, comp_len, raw_len)
        self._entries: dict[int, tuple[int, int, int]] = {}
        self._parsed = False

    def _ensure_parsed(self) -> None:
        if self._parsed:
            return
        self._parsed = True

        try:
            with open(self.path, "rb") as f:
                hdr = f.read(_HEADER_V2)
                if len(hdr) < _HEADER_MIN or hdr[:4] != BUNDLE_MAGIC:
                    return

                self._version = struct.unpack_from("<I", hdr, 4)[0]
                self._count = struct.unpack_from("<I", hdr, 8)[0]

                if self._version >= 2 and len(hdr) >= _HEADER_V2:
                    self._meta_entry_size = struct.unpack_from("<H", hdr, 12)[0]
                    self._header_size = _HEADER_V2
                else:
                    self._meta_entry_size = 0
                    self._header_size = _HEADER_MIN

                if self._count == 0:
                    return

                f.seek(self._header_size)
                idx_buf = f.read(self._count * _ENTRY_SIZE)
                if len(idx_buf) < self._count * _ENTRY_SIZE:
                    return

                for i in range(self._count):
                    base = i * _ENTRY_SIZE
                    index_num, offset, comp_len, raw_len = struct.unpack_from(
                        "<IIII", idx_buf, base
                    )
                    self._entries[index_num] = (offset, comp_len, raw_len)
        except OSError:
            pass

    @property
    def chapter_count(self) -> int:
        self._ensure_parsed()
        return self._count

    @property
    def indices(self) -> list[int]:
        """Return sorted chapter index numbers."""
        self._ensure_parsed()
        return sorted(self._entries.keys())

    def read_chapter_body(self, index_num: int) -> str | None:
        """Read and decompress a single chapter body. Returns None if missing."""
        self._ensure_parsed()
        entry = self._entries.get(index_num)
        if entry is None:
            return None

        offset, comp_len, raw_len = entry
        try:
            with open(self.path, "rb") as f:
                # v2: skip metadata prefix before compressed data
                data_offset = offset + self._meta_entry_size
                f.seek(data_offset)
                compressed = f.read(comp_len)
                if len(compressed) != comp_len:
                    return None

                if self._dict:
                    raw = pyzstd.decompress(compressed, zstd_dict=self._dict)
                else:
                    raw = pyzstd.decompress(compressed)

                return raw.decode("utf-8", errors="replace")
        except (OSError, pyzstd.ZstdError):
            return None

    def read_chapter_meta(self, index_num: int) -> dict | None:
        """Read inline v2 metadata for a chapter (title, slug, word_count).

        Returns None for v1 bundles or if the chapter is not found.
        """
        self._ensure_parsed()
        if self._meta_entry_size == 0:
            return None

        entry = self._entries.get(index_num)
        if entry is None:
            return None

        offset, _comp_len, _raw_len = entry
        try:
            with open(self.path, "rb") as f:
                f.seek(offset)
                meta_buf = f.read(self._meta_entry_size)
                if len(meta_buf) < self._meta_entry_size:
                    return None

                chapter_id = struct.unpack_from("<I", meta_buf, 0)[0]
                word_count = struct.unpack_from("<I", meta_buf, 4)[0]

                title_len = min(meta_buf[8], _META_TITLE_MAX)
                title = meta_buf[9 : 9 + title_len].decode("utf-8", errors="replace")

                slug_len = min(meta_buf[205], _META_SLUG_MAX)
                slug = meta_buf[206 : 206 + slug_len].decode("utf-8", errors="replace")

                return {
                    "chapter_id": chapter_id,
                    "word_count": word_count,
                    "title": title,
                    "slug": slug,
                }
        except OSError:
            return None

    def read_all_bodies(self, progress_callback=None) -> list[tuple[int, str, str]]:
        """Read all chapters in order.

        Returns list of (index_num, title, body_text).
        Title comes from v2 inline metadata or is extracted from body.
        """
        self._ensure_parsed()
        sorted_indices = self.indices
        total = len(sorted_indices)
        result: list[tuple[int, str, str]] = []

        for i, idx in enumerate(sorted_indices):
            body = self.read_chapter_body(idx)
            if body is None:
                continue

            # Try to get title from v2 metadata first
            title = ""
            meta = self.read_chapter_meta(idx)
            if meta and meta.get("title"):
                title = meta["title"]

            # Fall back to extracting title from body text
            if not title:
                title, body = _extract_title_and_body(body)

            result.append((idx, title, body))

            if progress_callback:
                progress_callback(i + 1, total)

        return result


# ── Text helpers ─────────────────────────────────────────────────────────────


def _extract_title_and_body(text: str) -> tuple[str, str]:
    """Extract title from first line of chapter text, return (title, body)."""
    lines = text.split("\n")
    title = lines[0].strip() if lines else "Untitled"

    # Skip duplicate title line and leading blanks
    body_start = 1
    while body_start < len(lines) and (
        lines[body_start].strip() == "" or lines[body_start].strip() == title
    ):
        body_start += 1

    body = "\n".join(lines[body_start:]).strip()
    return title, body


def _body_to_html(body_text: str) -> str:
    """Convert plain-text body to HTML paragraphs."""
    paragraphs = re.split(r"\n\s*\n", body_text)
    html_parts: list[str] = []
    for para in paragraphs:
        para = para.strip()
        if para:
            para = para.replace("&", "&amp;")
            para = para.replace("<", "&lt;")
            para = para.replace(">", "&gt;")
            para = para.replace("\n", "<br/>")
            html_parts.append(f"<p>{para}</p>")
    return "\n".join(html_parts)


# ── SQLite metadata reader ───────────────────────────────────────────────────


def load_metadata_from_db(db_path: Path, book_id: int) -> dict | None:
    """Read book metadata from binslib SQLite database.

    Returns a dict with keys: id, name, status, synopsis, cover_url,
    author_name, genres (list[str]).
    Returns None if the book is not found.
    """
    if not db_path.exists():
        return None

    try:
        conn = sqlite3.connect(str(db_path), timeout=5)
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            """
            SELECT b.id, b.name, b.status, b.synopsis, b.cover_url,
                   a.name AS author_name
            FROM books b
            LEFT JOIN authors a ON a.id = b.author_id
            WHERE b.id = ?
            """,
            (book_id,),
        ).fetchone()

        if not row:
            conn.close()
            return None

        meta = dict(row)

        # Fetch genres
        genres = conn.execute(
            """
            SELECT g.name FROM genres g
            INNER JOIN book_genres bg ON bg.genre_id = g.id
            WHERE bg.book_id = ?
            ORDER BY g.name
            """,
            (book_id,),
        ).fetchall()
        meta["genres"] = [g["name"] for g in genres]

        conn.close()
        return meta
    except sqlite3.Error:
        return None


def get_chapter_count_from_db(db_path: Path, book_id: int) -> int:
    """Get chapter count for a book from the database."""
    if not db_path.exists():
        return 0
    try:
        conn = sqlite3.connect(str(db_path), timeout=5)
        row = conn.execute(
            "SELECT COUNT(*) FROM chapters WHERE book_id = ?", (book_id,)
        ).fetchone()
        conn.close()
        return row[0] if row else 0
    except sqlite3.Error:
        return 0


# ── Cover helpers ────────────────────────────────────────────────────────────


def validate_cover(cover_path: Path) -> bool:
    """Check the cover image is valid and readable."""
    if not cover_path.exists():
        return False
    try:
        with Image.open(cover_path) as img:
            img.verify()
        return True
    except Exception:
        return False


# ── EPUB builder ─────────────────────────────────────────────────────────────


def build_epub(
    book_id: int,
    bundle_path: Path,
    db_path: Path,
    covers_dir: Path,
    dict_path: Path | None = None,
    output_path: Path | None = None,
    progress_callback=None,
) -> Path:
    """Build an EPUB file from a BLIB bundle + SQLite metadata.

    Args:
        book_id: Numeric book ID.
        bundle_path: Path to the .bundle file.
        db_path: Path to the binslib SQLite database.
        covers_dir: Directory containing {book_id}.jpg cover images.
        dict_path: Optional path to zstd global dictionary.
        output_path: Where to save the .epub file.
        progress_callback: Optional callable(current, total).

    Returns:
        Path to the created EPUB file.

    Raises:
        FileNotFoundError: If the bundle file does not exist.
        ValueError: If no chapters can be read from the bundle.
    """
    if not bundle_path.exists():
        raise FileNotFoundError(f"Bundle not found: {bundle_path}")

    # Load metadata from DB (fall back to minimal defaults)
    meta = load_metadata_from_db(db_path, book_id) or {}
    book_name = meta.get("name") or f"Book {book_id}"
    author_name = meta.get("author_name") or ""
    genres: list[str] = meta.get("genres", [])

    # Read chapters from bundle
    reader = BundleReader(bundle_path, dict_path=dict_path)

    if reader.chapter_count == 0:
        raise ValueError(f"Bundle has 0 chapters: {bundle_path}")

    chapters = reader.read_all_bodies(progress_callback=progress_callback)
    if not chapters:
        raise ValueError(f"Could not read any chapters from {bundle_path}")

    # Create EPUB book
    book = epub.EpubBook()
    book.set_identifier(f"mtc-{book_id}")
    book.set_title(book_name)
    book.set_language("vi")

    if author_name:
        book.add_author(author_name)

    for genre in genres:
        book.add_metadata("DC", "subject", genre)

    # Add CSS
    style = epub.EpubItem(
        uid="book_style",
        file_name="style/book.css",
        media_type="text/css",
        content=BOOK_CSS.encode("utf-8"),
    )
    book.add_item(style)

    # Add cover image
    cover_path = covers_dir / f"{book_id}.jpg"
    has_cover = validate_cover(cover_path)
    if has_cover:
        with open(cover_path, "rb") as f:
            cover_data = f.read()
        book.set_cover("images/cover.jpg", cover_data, create_page=True)

    spine_items: list = ["nav"]
    epub_chapters: list[epub.EpubHtml] = []

    # Add chapters
    for idx, title, body_text in chapters:
        if not title:
            title = f"Chương {idx}"

        body_html = _body_to_html(body_text)
        chapter_file = f"chapter_{idx:05d}.xhtml"
        epub_ch = epub.EpubHtml(
            title=title,
            file_name=chapter_file,
            lang="vi",
        )
        epub_ch.content = f"<h2>{title}</h2>\n{body_html}".encode("utf-8")
        epub_ch.add_item(style)

        book.add_item(epub_ch)
        epub_chapters.append(epub_ch)
        spine_items.append(epub_ch)

    # Table of contents
    book.toc = epub_chapters

    # Navigation
    book.add_item(epub.EpubNcx())
    book.add_item(epub.EpubNav())

    # Spine (reading order)
    if has_cover:
        spine_items.insert(0, "cover")
    book.spine = spine_items

    # Determine output path
    if output_path is None:
        safe_name = re.sub(r'[<>:"/\\|?*]', "", book_name).strip() or f"book_{book_id}"
        output_path = Path(f"{safe_name}.epub")

    output_path.parent.mkdir(parents=True, exist_ok=True)

    # Write EPUB
    epub.write_epub(str(output_path), book, {})

    return output_path
