"""Zstd compression with global dictionary for chapter bodies."""
from __future__ import annotations

import pyzstd


class ChapterCompressor:
    """Compress chapter bodies using zstd with a trained dictionary.

    The dictionary must match the one used by binslib (global.dict).
    """

    def __init__(self, dict_path: str, level: int = 3):
        with open(dict_path, "rb") as f:
            dict_data = f.read()
        self._dict = pyzstd.ZstdDict(dict_data)
        self._level = level

    def compress(self, body: str) -> tuple[bytes, int]:
        """Compress a chapter body string.

        Returns (compressed_bytes, uncompressed_length).
        """
        raw = body.encode("utf-8")
        compressed = pyzstd.compress(raw, level_or_option=self._level, zstd_dict=self._dict)
        return compressed, len(raw)
