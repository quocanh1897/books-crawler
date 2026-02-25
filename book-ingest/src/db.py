"""SQLite operations matching the binslib schema (drizzle-generated).

Opens with journal_mode=WAL and foreign_keys=ON to match binslib/src/db/index.ts.
All mutations use explicit transactions for atomicity.
"""
from __future__ import annotations

import hashlib
import json
import sqlite3
from typing import Any


def open_db(db_path: str) -> sqlite3.Connection:
    """Open the binslib SQLite database with WAL mode and foreign keys."""
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def compute_meta_hash(meta: dict) -> str:
    """Compute MD5 hash of serialized metadata JSON (matching import.ts)."""
    raw = json.dumps(meta, ensure_ascii=False, sort_keys=True)
    return hashlib.md5(raw.encode("utf-8")).hexdigest()


def slugify(text: str) -> str:
    """Vietnamese-aware slugification (matching import.ts slugify)."""
    fr = "àáảãạăắằẳẵặâấầẩẫậèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵđ"
    to = "aaaaaaaaaaaaaaaaaeeeeeeeeeeeiiiiiooooooooooooooooouuuuuuuuuuuyyyyyd"
    slug = text.lower().strip()
    for i, c in enumerate(fr):
        slug = slug.replace(c, to[i])
    import re
    slug = re.sub(r"[^a-z0-9\s-]", "", slug)
    slug = re.sub(r"[\s-]+", "-", slug)
    slug = slug.strip("-")
    return slug


def parse_author_id(raw: Any) -> int | None:
    """Parse author ID that may be int or string like 'c1000024'."""
    if raw is None:
        return None
    if isinstance(raw, int):
        return raw
    s = str(raw).lstrip("cC")
    try:
        return int(s)
    except ValueError:
        return None


def get_chapter_indices(conn: sqlite3.Connection, book_id: int) -> set[int]:
    """Get set of chapter index_num values for a book from the DB."""
    cur = conn.execute(
        "SELECT index_num FROM chapters WHERE book_id = ?", (book_id,)
    )
    return {row[0] for row in cur}


def get_book_meta_hash(conn: sqlite3.Connection, book_id: int) -> str | None:
    """Get the stored meta_hash for a book, or None if not in DB."""
    cur = conn.execute(
        "SELECT meta_hash FROM books WHERE id = ?", (book_id,)
    )
    row = cur.fetchone()
    return row[0] if row else None


def upsert_book_metadata(
    conn: sqlite3.Connection,
    meta: dict,
    cover_url: str | None,
    chapters_saved: int,
    meta_hash: str,
    source: str = "mtc",
) -> None:
    """Insert or replace book + author + genres + tags + junctions."""
    # Author
    author = meta.get("author")
    author_id = parse_author_id(author.get("id") if author else None)
    if author and author_id is not None:
        conn.execute(
            "INSERT OR REPLACE INTO authors (id, name, local_name, avatar) VALUES (?, ?, ?, ?)",
            (author_id, author["name"], author.get("local_name"), author.get("avatar")),
        )

    # Genres
    genres = meta.get("genres") or []
    for g in genres:
        genre_id = g.get("id")
        if genre_id is None:
            # Try to find by slug, or auto-assign
            slug = g.get("slug") or slugify(g["name"])
            cur = conn.execute("SELECT id FROM genres WHERE slug = ? LIMIT 1", (slug,))
            row = cur.fetchone()
            if row:
                genre_id = row[0]
            else:
                cur2 = conn.execute("SELECT COALESCE(MAX(id), 100) + 1 FROM genres")
                genre_id = cur2.fetchone()[0]
        conn.execute(
            "INSERT OR IGNORE INTO genres (id, name, slug) VALUES (?, ?, ?)",
            (genre_id, g["name"], g.get("slug") or slugify(g["name"])),
        )
        g["_resolved_id"] = genre_id

    # Tags
    tags = meta.get("tags") or []
    for t in tags:
        type_id = t.get("type_id")
        if isinstance(type_id, str):
            try:
                type_id = int(type_id)
            except ValueError:
                type_id = None
        conn.execute(
            "INSERT OR REPLACE INTO tags (id, name, type_id) VALUES (?, ?, ?)",
            (t["id"], t["name"], type_id),
        )

    # Handle slug conflict (same as import.ts)
    cur = conn.execute(
        "SELECT id FROM books WHERE slug = ? AND id != ?",
        (meta["slug"], meta["id"]),
    )
    conflict = cur.fetchone()
    if conflict:
        cid = conflict[0]
        conn.execute("DELETE FROM chapters WHERE book_id = ?", (cid,))
        conn.execute("DELETE FROM book_genres WHERE book_id = ?", (cid,))
        conn.execute("DELETE FROM book_tags WHERE book_id = ?", (cid,))
        conn.execute("DELETE FROM books WHERE id = ?", (cid,))

    # Book
    review_score = meta.get("review_score")
    if isinstance(review_score, str):
        try:
            review_score = float(review_score)
        except ValueError:
            review_score = 0
    review_score = review_score or 0

    # Use ON CONFLICT DO UPDATE instead of INSERT OR REPLACE to avoid
    # cascade-deleting chapters (ON DELETE CASCADE on chapters.book_id).
    conn.execute(
        """INSERT INTO books (
            id, name, slug, synopsis, status, status_name,
            view_count, comment_count, bookmark_count, vote_count,
            review_score, review_count, chapter_count, word_count,
            cover_url, author_id, created_at, updated_at,
            published_at, new_chap_at, chapters_saved, meta_hash, source
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            name=excluded.name, slug=excluded.slug, synopsis=excluded.synopsis,
            status=excluded.status, status_name=excluded.status_name,
            view_count=excluded.view_count, comment_count=excluded.comment_count,
            bookmark_count=excluded.bookmark_count, vote_count=excluded.vote_count,
            review_score=excluded.review_score, review_count=excluded.review_count,
            chapter_count=excluded.chapter_count, word_count=excluded.word_count,
            cover_url=excluded.cover_url, author_id=excluded.author_id,
            created_at=excluded.created_at, updated_at=excluded.updated_at,
            published_at=excluded.published_at, new_chap_at=excluded.new_chap_at,
            chapters_saved=excluded.chapters_saved, meta_hash=excluded.meta_hash,
            source=excluded.source""",
        (
            meta["id"],
            meta["name"],
            meta["slug"],
            meta.get("synopsis"),
            meta.get("status", 1),
            meta.get("status_name"),
            meta.get("view_count", 0),
            meta.get("comment_count", 0),
            meta.get("bookmark_count", 0),
            meta.get("vote_count", 0),
            review_score,
            meta.get("review_count", 0),
            meta.get("chapter_count", 0),
            meta.get("word_count", 0),
            cover_url,
            author_id,
            meta.get("created_at"),
            meta.get("updated_at"),
            meta.get("published_at"),
            meta.get("new_chap_at"),
            chapters_saved,
            meta_hash,
            source,
        ),
    )

    # Junctions: book_genres
    for g in genres:
        gid = g.get("_resolved_id") or g.get("id")
        if gid is not None:
            conn.execute(
                "INSERT OR IGNORE INTO book_genres (book_id, genre_id) VALUES (?, ?)",
                (meta["id"], gid),
            )

    # Junctions: book_tags
    for t in tags:
        conn.execute(
            "INSERT OR IGNORE INTO book_tags (book_id, tag_id) VALUES (?, ?)",
            (meta["id"], t["id"]),
        )


def insert_chapters(
    conn: sqlite3.Connection,
    book_id: int,
    chapters: dict[int, tuple[str, str, int]],
) -> None:
    """Insert chapter metadata rows.

    Args:
        chapters: dict mapping index_num -> (title, slug, word_count).
    """
    for index_num, (title, slug, word_count) in chapters.items():
        conn.execute(
            "INSERT OR REPLACE INTO chapters (book_id, index_num, title, slug, word_count) VALUES (?, ?, ?, ?, ?)",
            (book_id, index_num, title, slug, word_count),
        )


def update_cover_url(conn: sqlite3.Connection, book_id: int, cover_url: str) -> None:
    """Update the cover_url for a book."""
    conn.execute(
        "UPDATE books SET cover_url = ? WHERE id = ?",
        (cover_url, book_id),
    )


def update_chapters_saved(conn: sqlite3.Connection, book_id: int, count: int) -> None:
    """Update the chapters_saved count for a book."""
    conn.execute(
        "UPDATE books SET chapters_saved = ? WHERE id = ?",
        (count, book_id),
    )
