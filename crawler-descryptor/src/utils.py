"""Shared utilities for crawler-descryptor."""
from __future__ import annotations

import json
import os


CRAWLER_OUTPUT = os.path.join(os.path.dirname(__file__), "..", "..", "crawler", "output")


def get_output_dir(book_id: int) -> str:
    """Return the crawler output directory for a book, creating it if needed."""
    path = os.path.join(CRAWLER_OUTPUT, str(book_id))
    os.makedirs(path, exist_ok=True)
    return path


def save_chapter(book_id: int, index: int, slug: str, name: str, content: str) -> str:
    """Save a decrypted chapter in the standard crawler output format.

    Format: {index:04d}_{slug}.txt with content "{name}\n\n{body}"
    Returns the saved file path.
    """
    out_dir = get_output_dir(book_id)
    filename = f"{index:04d}_{slug}.txt"
    filepath = os.path.join(out_dir, filename)
    with open(filepath, "w", encoding="utf-8") as f:
        f.write(f"{name}\n\n{content}")
    return filepath


def save_metadata(book_id: int, metadata: dict) -> str:
    """Save book metadata JSON (matching the format from the API)."""
    out_dir = get_output_dir(book_id)
    filepath = os.path.join(out_dir, "metadata.json")
    with open(filepath, "w", encoding="utf-8") as f:
        json.dump(metadata, f, indent=2, ensure_ascii=False)
    return filepath


def count_existing_chapters(book_id: int) -> set[int]:
    """Return set of chapter indices already saved on disk."""
    out_dir = os.path.join(CRAWLER_OUTPUT, str(book_id))
    if not os.path.isdir(out_dir):
        return set()
    indices = set()
    for fname in os.listdir(out_dir):
        if fname.endswith(".txt") and fname[0].isdigit():
            try:
                indices.add(int(fname.split("_", 1)[0]))
            except ValueError:
                pass
    return indices
