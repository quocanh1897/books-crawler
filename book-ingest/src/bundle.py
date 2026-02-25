"""BLIB bundle reader/writer — Python port of binslib/src/lib/chapter-storage.ts.

Bundle format (little-endian):
  [4 bytes] magic: "BLIB"
  [4 bytes] uint32: version (1)
  [4 bytes] uint32: entry count (N)
  [N x 16 bytes] index entries sorted by chapter index:
    [4 bytes] uint32: chapter index number
    [4 bytes] uint32: data offset from file start
    [4 bytes] uint32: compressed data length
    [4 bytes] uint32: uncompressed data length
  [variable] concatenated zstd-compressed chapter data
"""
from __future__ import annotations

import os
import struct
import tempfile

BUNDLE_MAGIC = b"BLIB"
BUNDLE_VERSION = 1
HEADER_SIZE = 12   # magic(4) + version(4) + count(4)
ENTRY_SIZE = 16    # indexNum(4) + offset(4) + compLen(4) + rawLen(4)


def read_bundle_indices(bundle_path: str) -> set[int]:
    """Read only the index section — returns set of chapter index numbers.

    Returns empty set if the bundle doesn't exist or is invalid.
    """
    try:
        fd = os.open(bundle_path, os.O_RDONLY | getattr(os, "O_BINARY", 0))
    except OSError:
        return set()

    try:
        hdr = os.read(fd, HEADER_SIZE)
        if len(hdr) < HEADER_SIZE:
            return set()
        if hdr[:4] != BUNDLE_MAGIC:
            return set()
        version = struct.unpack_from("<I", hdr, 4)[0]
        if version != BUNDLE_VERSION:
            return set()
        count = struct.unpack_from("<I", hdr, 8)[0]
        if count == 0:
            return set()

        idx_buf = os.read(fd, count * ENTRY_SIZE)
        if len(idx_buf) < count * ENTRY_SIZE:
            return set()

        indices: set[int] = set()
        for i in range(count):
            index_num = struct.unpack_from("<I", idx_buf, i * ENTRY_SIZE)[0]
            indices.add(index_num)
        return indices
    except OSError:
        return set()
    finally:
        os.close(fd)


def read_bundle_raw(bundle_path: str) -> dict[int, tuple[bytes, int]]:
    """Read all compressed chapter data from a bundle.

    Returns dict mapping index_num -> (compressed_bytes, uncompressed_length).
    Returns empty dict if the bundle doesn't exist or is invalid.
    """
    try:
        with open(bundle_path, "rb") as f:
            hdr = f.read(HEADER_SIZE)
            if len(hdr) < HEADER_SIZE:
                return {}
            if hdr[:4] != BUNDLE_MAGIC:
                return {}
            version = struct.unpack_from("<I", hdr, 4)[0]
            if version != BUNDLE_VERSION:
                return {}
            count = struct.unpack_from("<I", hdr, 8)[0]
            if count == 0:
                return {}

            idx_buf = f.read(count * ENTRY_SIZE)
            if len(idx_buf) < count * ENTRY_SIZE:
                return {}

            # Parse index entries
            entries: list[tuple[int, int, int, int]] = []
            for i in range(count):
                base = i * ENTRY_SIZE
                index_num, offset, comp_len, raw_len = struct.unpack_from(
                    "<IIII", idx_buf, base
                )
                entries.append((index_num, offset, comp_len, raw_len))

            # Read data for each entry
            result: dict[int, tuple[bytes, int]] = {}
            for index_num, offset, comp_len, raw_len in entries:
                f.seek(offset)
                data = f.read(comp_len)
                if len(data) == comp_len:
                    result[index_num] = (data, raw_len)

            return result
    except OSError:
        return {}


def write_bundle(bundle_path: str, chapters: dict[int, tuple[bytes, int]]) -> None:
    """Write a complete BLIB bundle file atomically (tmp + rename).

    Args:
        bundle_path: Destination path for the .bundle file.
        chapters: dict mapping index_num -> (compressed_bytes, uncompressed_length).
    """
    if not chapters:
        return

    sorted_indices = sorted(chapters.keys())
    count = len(sorted_indices)

    # Calculate data section start
    data_start = HEADER_SIZE + count * ENTRY_SIZE

    # Build index and data buffers
    index_buf = bytearray(count * ENTRY_SIZE)
    data_parts: list[bytes] = []
    current_offset = data_start

    for i, index_num in enumerate(sorted_indices):
        compressed, raw_len = chapters[index_num]
        comp_len = len(compressed)
        struct.pack_into(
            "<IIII", index_buf, i * ENTRY_SIZE,
            index_num, current_offset, comp_len, raw_len,
        )
        data_parts.append(compressed)
        current_offset += comp_len

    # Header
    header = struct.pack("<4sII", BUNDLE_MAGIC, BUNDLE_VERSION, count)

    # Atomic write: write to temp file in same directory, then rename
    bundle_dir = os.path.dirname(bundle_path) or "."
    os.makedirs(bundle_dir, exist_ok=True)

    fd, tmp_path = tempfile.mkstemp(dir=bundle_dir, suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(header)
            f.write(index_buf)
            for part in data_parts:
                f.write(part)
        os.replace(tmp_path, bundle_path)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise
