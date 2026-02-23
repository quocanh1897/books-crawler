"""Shared utilities for crawler-descryptor."""

from __future__ import annotations

import json
import os
import struct

CRAWLER_OUTPUT = os.path.join(
    os.path.dirname(__file__), "..", "..", "crawler", "output"
)

BINSLIB_COMPRESSED_DIR = os.path.join(
    os.path.dirname(__file__), "..", "..", "binslib", "data", "compressed"
)

# ─── BLIB bundle format constants (must match chapter-storage.ts) ─────────────

_BUNDLE_MAGIC = b"BLIB"
_BUNDLE_HEADER_SIZE = 12  # magic(4) + version(4) + count(4)
_BUNDLE_ENTRY_SIZE = 16  # indexNum(4) + offset(4) + compLen(4) + rawLen(4)
_BUNDLE_SUPPORTED_VERSION = 1


def get_output_dir(book_id: int) -> str:
    """Return the crawler output directory for a book, creating it if needed."""
    path = os.path.join(CRAWLER_OUTPUT, str(book_id))
    os.makedirs(path, exist_ok=True)
    return path


def save_chapter(book_id: int, index: int, slug: str, name: str, content: str) -> str:
    """Save a decrypted chapter in the standard crawler output format.

    Format: {index:04d}_{slug}.txt with content "{name}\\n\\n{body}"
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


def read_bundle_indices(book_id: int) -> set[int]:
    """Read chapter indices from a BLIB bundle file.

    Parses the binary header and index section of
    ``binslib/data/compressed/{book_id}.bundle`` and returns the set of
    chapter index numbers stored in the bundle.

    Returns an empty set if the bundle does not exist, is too small, has
    an invalid magic/version, or cannot be read for any reason.
    """
    bundle_path = os.path.join(BINSLIB_COMPRESSED_DIR, f"{book_id}.bundle")
    try:
        fd = os.open(bundle_path, os.O_RDONLY | getattr(os, "O_BINARY", 0))
    except OSError:
        return set()

    try:
        hdr = os.read(fd, _BUNDLE_HEADER_SIZE)
        if len(hdr) < _BUNDLE_HEADER_SIZE:
            return set()

        magic = hdr[:4]
        if magic != _BUNDLE_MAGIC:
            return set()

        version = struct.unpack_from("<I", hdr, 4)[0]
        if version != _BUNDLE_SUPPORTED_VERSION:
            return set()

        count = struct.unpack_from("<I", hdr, 8)[0]
        if count == 0:
            return set()

        idx_buf = os.read(fd, count * _BUNDLE_ENTRY_SIZE)
        if len(idx_buf) < count * _BUNDLE_ENTRY_SIZE:
            return set()

        indices: set[int] = set()
        for i in range(count):
            base = i * _BUNDLE_ENTRY_SIZE
            index_num = struct.unpack_from("<I", idx_buf, base)[0]
            indices.add(index_num)
        return indices
    except OSError:
        return set()
    finally:
        os.close(fd)


def count_existing_chapters(book_id: int) -> set[int]:
    """Return set of chapter indices that are already available.

    Merges two sources:
      1. ``.txt`` files on disk in ``crawler/output/{book_id}/``
      2. Chapters stored in the BLIB bundle at
         ``binslib/data/compressed/{book_id}.bundle``

    A chapter that exists in *either* source is considered done and will
    be skipped during download.
    """
    # Source 1: .txt chapter files in crawler output
    indices: set[int] = set()
    out_dir = os.path.join(CRAWLER_OUTPUT, str(book_id))
    if os.path.isdir(out_dir):
        for fname in os.listdir(out_dir):
            if fname.endswith(".txt") and fname[0].isdigit():
                try:
                    indices.add(int(fname.split("_", 1)[0]))
                except ValueError:
                    pass

    # Source 2: BLIB bundle
    indices |= read_bundle_indices(book_id)

    return indices
