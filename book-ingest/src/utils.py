"""Shared utilities for book-ingest (bundle and chapter helpers)."""

from __future__ import annotations

import os
import struct

BINSLIB_COMPRESSED_DIR = os.path.join(
    os.path.dirname(__file__), "..", "..", "binslib", "data", "compressed"
)

# ─── BLIB bundle format constants (must match chapter-storage.ts) ─────────────

_BUNDLE_MAGIC = b"BLIB"
_BUNDLE_HEADER_SIZE_V1 = 12  # magic(4) + version(4) + count(4)
_BUNDLE_HEADER_SIZE_V2 = (
    16  # magic(4) + version(4) + count(4) + metaSize(2) + reserved(2)
)
_BUNDLE_ENTRY_SIZE = 16  # indexNum(4) + offset(4) + compLen(4) + rawLen(4)
_BUNDLE_SUPPORTED_VERSIONS = (1, 2)


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
        hdr = os.read(fd, _BUNDLE_HEADER_SIZE_V2)
        if len(hdr) < _BUNDLE_HEADER_SIZE_V1:
            return set()

        magic = hdr[:4]
        if magic != _BUNDLE_MAGIC:
            return set()

        version = struct.unpack_from("<I", hdr, 4)[0]
        if version not in _BUNDLE_SUPPORTED_VERSIONS:
            return set()

        count = struct.unpack_from("<I", hdr, 8)[0]
        if count == 0:
            return set()

        # v1: index starts at byte 12; v2: at byte 16
        header_size = _BUNDLE_HEADER_SIZE_V2 if version == 2 else _BUNDLE_HEADER_SIZE_V1
        os.lseek(fd, header_size, os.SEEK_SET)

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
    """Return set of chapter indices stored in the BLIB bundle.

    Reads from ``binslib/data/compressed/{book_id}.bundle``.
    """
    return read_bundle_indices(book_id)
