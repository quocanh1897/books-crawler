"""Shared utilities for crawler-tangthuvien."""
from __future__ import annotations

import json
import os
import re
import sqlite3

from config import BINSLIB_DB_PATH, ID_OFFSET, OUTPUT_DIR, REGISTRY_PATH


def get_output_dir(book_id: int) -> str:
    """Return the output directory for a book, creating it if needed."""
    path = os.path.join(OUTPUT_DIR, str(book_id))
    os.makedirs(path, exist_ok=True)
    return path


def save_chapter(book_id: int, index: int, slug: str, title: str, body: str) -> str:
    """Save a chapter in the standard crawler output format.

    Format: {index:04d}_{slug}.txt with content "{title}\\n\\n{body}"
    """
    out_dir = get_output_dir(book_id)
    safe_slug = re.sub(r'[^\w\-]', '', slug) or f"chapter-{index}"
    filename = f"{index:04d}_{safe_slug}.txt"
    filepath = os.path.join(out_dir, filename)
    with open(filepath, "w", encoding="utf-8") as f:
        f.write(f"{title}\n\n{body}")
    return filepath


def save_metadata(book_id: int, metadata: dict) -> str:
    """Save book metadata JSON."""
    out_dir = get_output_dir(book_id)
    filepath = os.path.join(out_dir, "metadata.json")
    with open(filepath, "w", encoding="utf-8") as f:
        json.dump(metadata, f, indent=2, ensure_ascii=False)
    return filepath


def save_cover(book_id: int, image_bytes: bytes) -> str:
    """Save a cover image."""
    out_dir = get_output_dir(book_id)
    filepath = os.path.join(out_dir, "cover.jpg")
    with open(filepath, "wb") as f:
        f.write(image_bytes)
    return filepath


def count_existing_chapters(book_id: int) -> set[int]:
    """Return set of chapter indices already saved on disk (skips empty files)."""
    out_dir = os.path.join(OUTPUT_DIR, str(book_id))
    if not os.path.isdir(out_dir):
        return set()
    indices = set()
    for fname in os.listdir(out_dir):
        if fname.endswith(".txt") and fname[0].isdigit():
            fpath = os.path.join(out_dir, fname)
            if os.path.getsize(fpath) == 0:
                os.remove(fpath)
                continue
            try:
                indices.add(int(fname.split("_", 1)[0]))
            except ValueError:
                pass
    return indices


# --- Book registry (slug -> numeric ID mapping) ---

def load_registry() -> dict[str, int]:
    """Load the slug -> numeric ID mapping from disk."""
    if os.path.exists(REGISTRY_PATH):
        with open(REGISTRY_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}


def save_registry(registry: dict[str, int]) -> None:
    """Persist the slug -> numeric ID mapping."""
    with open(REGISTRY_PATH, "w", encoding="utf-8") as f:
        json.dump(registry, f, indent=2, ensure_ascii=False)


def get_or_create_book_id(slug: str) -> int:
    """Get existing numeric ID for a slug, or assign the next available one."""
    registry = load_registry()
    if slug in registry:
        return registry[slug]
    next_id = ID_OFFSET + len(registry) + 1
    registry[slug] = next_id
    save_registry(registry)
    return next_id


# --- MTC deduplication (reads from binslib SQLite DB) ---

def build_mtc_index() -> dict[str, dict]:
    """Build an index of existing books by slug from the binslib SQLite database.

    The DB is the source of truth -- it survives even if crawler output
    directories are pruned.

    Returns: {slug: {"id": int, "name": str, "status": int}}
    """
    if not os.path.exists(BINSLIB_DB_PATH):
        return {}
    conn = sqlite3.connect(BINSLIB_DB_PATH)
    try:
        rows = conn.execute(
            "SELECT id, name, slug, status FROM books WHERE slug IS NOT NULL"
        ).fetchall()
    finally:
        conn.close()
    return {
        slug: {"id": book_id, "name": name, "status": status}
        for book_id, name, slug, status in rows
        if slug
    }


def is_mtc_duplicate(slug: str, mtc_index: dict[str, dict]) -> bool:
    """Check if a slug matches an existing book that is already completed (status=2)."""
    entry = mtc_index.get(slug)
    return entry is not None and entry.get("status") == 2
