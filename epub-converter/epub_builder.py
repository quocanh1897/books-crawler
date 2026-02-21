"""
Core EPUB building logic.

Reads chapter .txt files, metadata.json, and cover.jpg from a book directory
and produces a valid EPUB 3.0 file.  The caller controls the output path;
non-txt files are copied separately by convert.py.
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path

from ebooklib import epub
from PIL import Image

# ── Constants ────────────────────────────────────────────────────────────────

CHAPTER_PATTERN = re.compile(r"^(\d+)_.+\.txt$")

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


# ── Helpers ──────────────────────────────────────────────────────────────────

def discover_chapters(book_dir: Path) -> list[tuple[int, Path]]:
    """Find and sort chapter .txt files by their numeric index prefix."""
    chapters = []
    for f in book_dir.iterdir():
        if not f.is_file():
            continue
        m = CHAPTER_PATTERN.match(f.name)
        if m:
            idx = int(m.group(1))
            chapters.append((idx, f))
    chapters.sort(key=lambda x: x[0])
    return chapters


def parse_chapter_text(filepath: Path) -> tuple[str, str]:
    """Parse a chapter .txt file into (title, body_html).

    Chapter files start with the title line, then the same title repeated,
    then a blank line, then body text. Paragraphs are separated by blank lines.
    """
    text = filepath.read_text(encoding="utf-8", errors="replace")
    lines = text.split("\n")

    # Extract title from first line
    title = lines[0].strip() if lines else filepath.stem

    # Skip the duplicate title and leading blank lines
    body_start = 1
    while body_start < len(lines) and (
        lines[body_start].strip() == "" or lines[body_start].strip() == title
    ):
        body_start += 1

    body_lines = lines[body_start:]
    body_text = "\n".join(body_lines).strip()

    # Convert paragraphs to HTML
    paragraphs = re.split(r"\n\s*\n", body_text)
    html_parts = []
    for para in paragraphs:
        para = para.strip()
        if para:
            # Escape basic HTML entities
            para = para.replace("&", "&amp;")
            para = para.replace("<", "&lt;")
            para = para.replace(">", "&gt;")
            # Preserve single newlines as line breaks within a paragraph
            para = para.replace("\n", "<br/>")
            html_parts.append(f"<p>{para}</p>")

    body_html = "\n".join(html_parts)
    return title, body_html


def load_metadata(book_dir: Path) -> dict:
    """Load metadata.json, falling back to book.json."""
    meta_path = book_dir / "metadata.json"
    if meta_path.exists():
        with open(meta_path, encoding="utf-8") as f:
            return json.load(f)

    book_json = book_dir / "book.json"
    if book_json.exists():
        with open(book_json, encoding="utf-8") as f:
            data = json.load(f)
            return {
                "id": data.get("book_id"),
                "name": data.get("book_name", f"Book {book_dir.name}"),
            }

    return {"id": int(book_dir.name), "name": f"Book {book_dir.name}"}


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


# ── Builder ──────────────────────────────────────────────────────────────────

def build_epub(
    book_dir: Path,
    output_path: Path | None = None,
    progress_callback=None,
) -> Path:
    """Build an EPUB file from a book directory.

    Args:
        book_dir: Path to the book directory (e.g. crawler/output/100358/)
        output_path: Where to save the .epub file. If None, saves to
                     book_dir/{name}.epub as a fallback.
        progress_callback: Optional callable(current, total) for progress updates

    Returns:
        Path to the created EPUB file.

    Raises:
        ValueError: If no chapters are found.
    """
    meta = load_metadata(book_dir)
    book_id = meta.get("id", book_dir.name)
    book_name = meta.get("name", f"Book {book_id}")
    author_name = ""
    genres = []

    # Extract author
    author = meta.get("author")
    if isinstance(author, dict):
        author_name = author.get("name", "")
    elif isinstance(author, str):
        author_name = author

    # Extract genres
    genre_list = meta.get("genres", [])
    if isinstance(genre_list, list):
        for g in genre_list:
            if isinstance(g, dict):
                genres.append(g.get("name", ""))
            elif isinstance(g, str):
                genres.append(g)

    # Discover chapters
    chapters = discover_chapters(book_dir)
    if not chapters:
        raise ValueError(f"No chapter .txt files found in {book_dir}")

    total_chapters = len(chapters)

    # Create EPUB book
    book = epub.EpubBook()
    book.set_identifier(f"mtc-{book_id}")
    book.set_title(book_name)
    book.set_language("vi")

    if author_name:
        book.add_author(author_name)
    else:
        creator = meta.get("creator")
        if isinstance(creator, dict):
            book.add_author(creator.get("name", "Unknown"))

    # Add CSS
    style = epub.EpubItem(
        uid="book_style",
        file_name="style/book.css",
        media_type="text/css",
        content=BOOK_CSS.encode("utf-8"),
    )
    book.add_item(style)

    # Add cover image
    cover_path = book_dir / "cover.jpg"
    has_cover = validate_cover(cover_path)
    if has_cover:
        with open(cover_path, "rb") as f:
            cover_data = f.read()
        book.set_cover("images/cover.jpg", cover_data, create_page=True)

    spine_items = ["nav"]
    epub_chapters = []

    # Add chapters
    for i, (idx, chapter_path) in enumerate(chapters):
        title, body_html = parse_chapter_text(chapter_path)

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

        if progress_callback:
            progress_callback(i + 1, total_chapters)

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
        safe_name = re.sub(r'[<>:"/\\|?*]', "", book_name).strip()
        if not safe_name:
            safe_name = f"book_{book_id}"
        output_path = book_dir / f"{safe_name}.epub"

    # Write EPUB
    epub.write_epub(str(output_path), book, {})

    return output_path
