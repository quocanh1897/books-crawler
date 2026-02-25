"""BLIB bundle reader/writer — supports v1 (data-only) and v2 (inline metadata).

v1 format (little-endian):
  [4 bytes]  magic: "BLIB"
  [4 bytes]  uint32: version (1)
  [4 bytes]  uint32: entry count (N)
  [N x 16 bytes] index entries sorted by chapter index:
    [4 bytes] uint32: chapter index number
    [4 bytes] uint32: data offset from file start
    [4 bytes] uint32: compressed data length
    [4 bytes] uint32: uncompressed data length
  [variable] concatenated zstd-compressed chapter data

v2 format (little-endian):
  [4 bytes]  magic: "BLIB"
  [4 bytes]  uint32: version (2)
  [4 bytes]  uint32: entry count (N)
  [2 bytes]  uint16: meta entry size (M, currently 256)
  [2 bytes]  uint16: reserved (0)
  [N x 16 bytes] index entries sorted by chapter index:
    [4 bytes] uint32: chapter index number
    [4 bytes] uint32: block offset from file start (points to meta+data)
    [4 bytes] uint32: compressed data length (excludes metadata prefix)
    [4 bytes] uint32: uncompressed data length
  Per chapter block (at block offset):
    [M bytes] fixed-size metadata:
      [4 bytes]   uint32: word_count
      [1 byte]    uint8:  title_len (max 200)
      [200 bytes] title UTF-8 (zero-padded)
      [1 byte]    uint8:  slug_len (max 48)
      [48 bytes]  slug UTF-8 (zero-padded)
      [2 bytes]   reserved (zero)
    [variable] zstd-compressed chapter data
"""

from __future__ import annotations

import os
import struct
import tempfile
from dataclasses import dataclass

# ─── Constants ────────────────────────────────────────────────────────────────

BUNDLE_MAGIC = b"BLIB"
BUNDLE_VERSION_1 = 1
BUNDLE_VERSION_2 = 2
_SUPPORTED_VERSIONS = (BUNDLE_VERSION_1, BUNDLE_VERSION_2)

HEADER_SIZE_V1 = 12  # magic(4) + version(4) + count(4)
HEADER_SIZE_V2 = 16  # magic(4) + version(4) + count(4) + meta_size(2) + reserved(2)
ENTRY_SIZE = 16  # indexNum(4) + offset(4) + compLen(4) + rawLen(4)

META_ENTRY_SIZE = 256  # fixed metadata block per chapter
_META_TITLE_MAX = 200
_META_SLUG_MAX = 48


# ─── Data types ───────────────────────────────────────────────────────────────


@dataclass
class ChapterMeta:
    """Per-chapter metadata stored inline in v2 bundles."""

    word_count: int = 0
    title: str = ""
    slug: str = ""


# ─── Internal helpers ─────────────────────────────────────────────────────────


def _parse_header(buf: bytes) -> tuple[int, int, int, int] | None:
    """Parse a bundle header buffer (must be at least HEADER_SIZE_V1 bytes).

    Returns (version, count, header_size, meta_entry_size) or None if invalid.
    """
    if len(buf) < HEADER_SIZE_V1:
        return None
    if buf[:4] != BUNDLE_MAGIC:
        return None

    version = struct.unpack_from("<I", buf, 4)[0]
    if version not in _SUPPORTED_VERSIONS:
        return None

    count = struct.unpack_from("<I", buf, 8)[0]

    if version == BUNDLE_VERSION_1:
        return (version, count, HEADER_SIZE_V1, 0)

    # v2: need at least 16 bytes
    if len(buf) < HEADER_SIZE_V2:
        return None
    meta_entry_size = struct.unpack_from("<H", buf, 12)[0]
    return (version, count, HEADER_SIZE_V2, meta_entry_size)


def _encode_meta(meta: ChapterMeta) -> bytes:
    """Encode a ChapterMeta into a fixed-size META_ENTRY_SIZE byte block."""
    buf = bytearray(META_ENTRY_SIZE)

    # word_count at offset 0
    struct.pack_into("<I", buf, 0, meta.word_count)

    # title at offset 4: 1-byte length + 200-byte padded content
    title_bytes = meta.title.encode("utf-8")[:_META_TITLE_MAX]
    buf[4] = len(title_bytes)
    buf[5 : 5 + len(title_bytes)] = title_bytes

    # slug at offset 205: 1-byte length + 48-byte padded content
    slug_bytes = meta.slug.encode("utf-8")[:_META_SLUG_MAX]
    buf[205] = len(slug_bytes)
    buf[206 : 206 + len(slug_bytes)] = slug_bytes

    # bytes 254-255 remain zero (reserved)
    return bytes(buf)


def _decode_meta(buf: bytes | bytearray) -> ChapterMeta:
    """Decode a META_ENTRY_SIZE byte block into a ChapterMeta."""
    if len(buf) < META_ENTRY_SIZE:
        return ChapterMeta()

    word_count = struct.unpack_from("<I", buf, 0)[0]

    title_len = buf[4]
    if title_len > _META_TITLE_MAX:
        title_len = _META_TITLE_MAX
    title = buf[5 : 5 + title_len].decode("utf-8", errors="replace")

    slug_len = buf[205]
    if slug_len > _META_SLUG_MAX:
        slug_len = _META_SLUG_MAX
    slug = buf[206 : 206 + slug_len].decode("utf-8", errors="replace")

    return ChapterMeta(word_count=word_count, title=title, slug=slug)


_EMPTY_META_BLOCK = _encode_meta(ChapterMeta())


# ─── Readers ──────────────────────────────────────────────────────────────────


def read_bundle_indices(bundle_path: str) -> set[int]:
    """Read only the index section — returns set of chapter index numbers.

    Accepts both v1 and v2 bundles.
    Returns empty set if the bundle doesn't exist or is invalid.
    """
    try:
        fd = os.open(bundle_path, os.O_RDONLY | getattr(os, "O_BINARY", 0))
    except OSError:
        return set()

    try:
        hdr = os.read(fd, HEADER_SIZE_V2)
        parsed = _parse_header(hdr)
        if parsed is None:
            return set()

        version, count, header_size, meta_entry_size = parsed
        if count == 0:
            return set()

        os.lseek(fd, header_size, os.SEEK_SET)
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

    Accepts both v1 and v2 bundles.  For v2, skips the metadata prefix —
    returns only the compressed data.

    Returns dict mapping index_num -> (compressed_bytes, uncompressed_length).
    Returns empty dict if the bundle doesn't exist or is invalid.
    """
    try:
        with open(bundle_path, "rb") as f:
            hdr = f.read(HEADER_SIZE_V2)
            parsed = _parse_header(hdr)
            if parsed is None:
                return {}

            version, count, header_size, meta_entry_size = parsed
            if count == 0:
                return {}

            f.seek(header_size)
            idx_buf = f.read(count * ENTRY_SIZE)
            if len(idx_buf) < count * ENTRY_SIZE:
                return {}

            entries: list[tuple[int, int, int, int]] = []
            for i in range(count):
                base = i * ENTRY_SIZE
                index_num, offset, comp_len, raw_len = struct.unpack_from(
                    "<IIII", idx_buf, base
                )
                entries.append((index_num, offset, comp_len, raw_len))

            result: dict[int, tuple[bytes, int]] = {}
            for index_num, offset, comp_len, raw_len in entries:
                # v2: offset points to meta+data block; skip the metadata prefix
                data_offset = offset + meta_entry_size
                f.seek(data_offset)
                data = f.read(comp_len)
                if len(data) == comp_len:
                    result[index_num] = (data, raw_len)

            return result
    except OSError:
        return {}


def read_bundle_meta(bundle_path: str) -> dict[int, ChapterMeta]:
    """Read per-chapter metadata from a v2 bundle.

    Returns dict mapping index_num -> ChapterMeta.
    Returns empty dict for v1 bundles or if the file doesn't exist.
    """
    try:
        with open(bundle_path, "rb") as f:
            hdr = f.read(HEADER_SIZE_V2)
            parsed = _parse_header(hdr)
            if parsed is None:
                return {}

            version, count, header_size, meta_entry_size = parsed
            if version == BUNDLE_VERSION_1 or meta_entry_size == 0:
                return {}
            if count == 0:
                return {}

            f.seek(header_size)
            idx_buf = f.read(count * ENTRY_SIZE)
            if len(idx_buf) < count * ENTRY_SIZE:
                return {}

            entries: list[tuple[int, int]] = []
            for i in range(count):
                base = i * ENTRY_SIZE
                index_num = struct.unpack_from("<I", idx_buf, base)[0]
                offset = struct.unpack_from("<I", idx_buf, base + 4)[0]
                entries.append((index_num, offset))

            result: dict[int, ChapterMeta] = {}
            for index_num, offset in entries:
                f.seek(offset)
                meta_buf = f.read(meta_entry_size)
                if len(meta_buf) == meta_entry_size:
                    result[index_num] = _decode_meta(meta_buf)

            return result
    except OSError:
        return {}


# ─── Writer ───────────────────────────────────────────────────────────────────


def write_bundle(
    bundle_path: str,
    chapters: dict[int, tuple[bytes, int]],
    meta: dict[int, ChapterMeta] | None = None,
) -> None:
    """Write a complete BLIB v2 bundle file atomically (tmp + rename).

    Always writes v2 format.  Chapters without a corresponding entry in
    ``meta`` get a zero-filled metadata block (safe — means "unknown").

    Args:
        bundle_path: Destination path for the .bundle file.
        chapters: dict mapping index_num -> (compressed_bytes, uncompressed_length).
        meta: optional dict mapping index_num -> ChapterMeta.
    """
    if not chapters:
        return

    sorted_indices = sorted(chapters.keys())
    count = len(sorted_indices)

    # Data section starts after header + index
    data_start = HEADER_SIZE_V2 + count * ENTRY_SIZE

    # Build index buffer and collect data parts
    index_buf = bytearray(count * ENTRY_SIZE)
    data_parts: list[bytes] = []
    current_offset = data_start

    for i, index_num in enumerate(sorted_indices):
        compressed, raw_len = chapters[index_num]
        comp_len = len(compressed)

        # Encode metadata block (default to empty if not provided)
        if meta and index_num in meta:
            meta_block = _encode_meta(meta[index_num])
        else:
            meta_block = _EMPTY_META_BLOCK

        struct.pack_into(
            "<IIII",
            index_buf,
            i * ENTRY_SIZE,
            index_num,
            current_offset,
            comp_len,
            raw_len,
        )
        data_parts.append(meta_block)
        data_parts.append(compressed)
        current_offset += META_ENTRY_SIZE + comp_len

    # v2 header: magic + version + count + meta_entry_size + reserved
    header = struct.pack(
        "<4sIIHH", BUNDLE_MAGIC, BUNDLE_VERSION_2, count, META_ENTRY_SIZE, 0
    )

    # Atomic write: temp file in same directory, then rename
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
