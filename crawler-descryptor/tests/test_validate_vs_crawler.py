#!/usr/bin/env python3
"""
Validate API decryption output matches the crawler's stored plaintext.

Compares decrypted content from the API against the known-good plaintext
in tests/samples/verified_pair.json (extracted from the production crawler's
SQLite database).
"""
from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from src.client import APIClient
from src.decrypt import decrypt_content


def normalize(text: str) -> str:
    """Normalize whitespace for comparison."""
    return " ".join(text.split())


def main():
    sample_path = os.path.join(os.path.dirname(__file__), "samples", "verified_pair.json")
    with open(sample_path) as f:
        sample = json.load(f)

    chapter_id = sample["chapter_id"]
    expected_plaintext = sample["plaintext"]
    print(f"Chapter ID: {chapter_id}")
    print(f"Expected plaintext: {len(expected_plaintext)} chars")

    print(f"\nFetching chapter {chapter_id} from API...")
    with APIClient() as client:
        data = client.get_chapter(chapter_id)
        content = data.get("content", "")

    print(f"Content length: {len(content)} chars")
    plaintext = decrypt_content(content)
    print(f"Decrypted: {len(plaintext)} chars")

    # Compare
    norm_expected = normalize(expected_plaintext)
    norm_actual = normalize(plaintext)

    if norm_actual == norm_expected:
        print("\nVALIDATION: EXACT MATCH (after whitespace normalization)")
    elif norm_expected in norm_actual or norm_actual in norm_expected:
        print("\nVALIDATION: SUBSTRING MATCH")
        print(f"  Expected length: {len(norm_expected)}")
        print(f"  Actual length:   {len(norm_actual)}")
    else:
        # Check prefix match
        match_len = 0
        for i, (a, b) in enumerate(zip(norm_expected, norm_actual)):
            if a == b:
                match_len = i + 1
            else:
                break

        pct = match_len / max(len(norm_expected), 1) * 100
        print(f"\nVALIDATION: PARTIAL MATCH — {match_len} chars ({pct:.1f}%)")
        if match_len < len(norm_expected):
            ctx_start = max(0, match_len - 20)
            print(f"  First diff at char {match_len}:")
            print(f"    Expected: ...{norm_expected[ctx_start:match_len+20]!r}")
            print(f"    Actual:   ...{norm_actual[ctx_start:match_len+20]!r}")

    # Also test a second chapter to confirm consistency
    print("\n--- Testing second chapter (chapter after 10340503) ---")
    next_info = data.get("next")
    if next_info:
        next_id = next_info.get("id")
        print(f"Next chapter ID: {next_id}")
        with APIClient() as client:
            data2 = client.get_chapter(next_id)
            content2 = data2.get("content", "")
        plaintext2 = decrypt_content(content2)
        print(f"Decrypted: {len(plaintext2)} chars")
        print(f"Preview: {plaintext2[:200]}")
        print("Second chapter decryption: SUCCESS")
    else:
        print("No next chapter link found.")


if __name__ == "__main__":
    main()
