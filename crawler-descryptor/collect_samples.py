#!/usr/bin/env python3
"""
Collect encrypted/decrypted chapter pairs for testing the decryption logic.

For a given book that was already crawled (plaintext in crawler/output/),
fetches the same chapters from the API (encrypted) and saves both versions
as test fixtures in tests/samples/.

Usage:
    python3 collect_samples.py <book_id> [--count 5]

Output per chapter:
    tests/samples/<book_id>_<index>_encrypted.json   (API response)
    tests/samples/<book_id>_<index>_decrypted.txt     (plaintext from crawler)
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time

import httpx

sys.path.insert(0, os.path.dirname(__file__))
from config import BASE_URL, HEADERS, REQUEST_DELAY

CRAWLER_OUTPUT = os.path.join(os.path.dirname(__file__), "..", "crawler", "output")
SAMPLES_DIR = os.path.join(os.path.dirname(__file__), "tests", "samples")


def find_crawled_chapters(book_id: int) -> list[dict]:
    """Read crawled chapter files and return list of {index, slug, name, content, filename}."""
    book_dir = os.path.join(CRAWLER_OUTPUT, str(book_id))
    if not os.path.isdir(book_dir):
        print(f"No crawler output for book {book_id} at {book_dir}")
        return []

    chapters = []
    for fname in sorted(os.listdir(book_dir)):
        if not fname.endswith(".txt") or not fname[0].isdigit():
            continue
        parts = fname.rsplit(".txt", 1)[0].split("_", 1)
        try:
            index = int(parts[0])
        except ValueError:
            continue
        slug = parts[1] if len(parts) > 1 else ""

        with open(os.path.join(book_dir, fname), "r", encoding="utf-8") as f:
            content = f.read()

        name = content.split("\n", 1)[0] if content else ""
        body = content.split("\n\n", 1)[1] if "\n\n" in content else content

        chapters.append(
            {
                "index": index,
                "slug": slug,
                "name": name,
                "content": body,
                "filename": fname,
            }
        )

    return chapters


def fetch_first_chapter_id(book_id: int) -> int | None:
    """Get the first chapter ID for a book via API search."""
    with httpx.Client(headers=HEADERS, timeout=30) as client:
        r = client.get(
            f"{BASE_URL}/api/books",
            params={
                "filter[id]": book_id,
                "include": "author",
            },
        )
        if r.status_code == 200:
            data = r.json()
            if data.get("data"):
                book = data["data"][0]
                if "book" in book:
                    book = book["book"]
                return book.get("first_chapter")
    return None


def fetch_chapter_encrypted(chapter_id: int) -> dict | None:
    """Fetch a chapter from the API, return the raw response data."""
    with httpx.Client(headers=HEADERS, timeout=30) as client:
        r = client.get(f"{BASE_URL}/api/chapters/{chapter_id}")
        if r.status_code == 200:
            data = r.json()
            if data.get("success"):
                return data["data"]
    return None


def main():
    parser = argparse.ArgumentParser(
        description="Collect encrypted/decrypted sample pairs"
    )
    parser.add_argument(
        "book_id", type=int, help="Book ID (must exist in crawler/output/)"
    )
    parser.add_argument(
        "--count", type=int, default=5, help="Number of samples to collect (default: 5)"
    )
    args = parser.parse_args()

    os.makedirs(SAMPLES_DIR, exist_ok=True)

    # Load crawled chapters
    crawled = find_crawled_chapters(args.book_id)
    if not crawled:
        print(f"No crawled chapters found for book {args.book_id}")
        sys.exit(1)
    print(f"Found {len(crawled)} crawled chapters for book {args.book_id}")

    # Get first chapter ID from API
    print(f"Fetching first chapter ID from API...")
    first_id = fetch_first_chapter_id(args.book_id)
    if not first_id:
        print("Could not find book in API. Try providing first_chapter_id manually.")
        sys.exit(1)
    print(f"First chapter ID: {first_id}")

    # Walk through chapters using the `next` field
    collected = 0
    chapter_id = first_id
    crawled_by_index = {c["index"]: c for c in crawled}

    while collected < args.count and chapter_id:
        print(f"\nFetching chapter {chapter_id}...")
        api_data = fetch_chapter_encrypted(chapter_id)
        if not api_data:
            print(f"  Failed to fetch chapter {chapter_id}")
            break

        index = api_data.get("index", 0)
        encrypted_content = api_data.get("content", "")
        next_info = api_data.get("next")

        # Match with crawled plaintext
        crawled_chapter = crawled_by_index.get(index)
        if not crawled_chapter:
            print(f"  Chapter index {index} not in crawled data, skipping")
            chapter_id = next_info.get("id") if next_info else None
            time.sleep(REQUEST_DELAY)
            continue

        # Save encrypted response
        enc_path = os.path.join(
            SAMPLES_DIR, f"{args.book_id}_{index:04d}_encrypted.json"
        )
        with open(enc_path, "w", encoding="utf-8") as f:
            json.dump(
                {
                    "chapter_id": api_data["id"],
                    "book_id": api_data.get("book_id", args.book_id),
                    "index": index,
                    "name": api_data.get("name", ""),
                    "slug": api_data.get("slug", ""),
                    "content_encrypted": encrypted_content,
                },
                f,
                indent=2,
                ensure_ascii=False,
            )

        # Save decrypted plaintext
        dec_path = os.path.join(
            SAMPLES_DIR, f"{args.book_id}_{index:04d}_decrypted.txt"
        )
        with open(dec_path, "w", encoding="utf-8") as f:
            f.write(crawled_chapter["content"])

        print(
            f"  Saved pair: index={index}, encrypted={len(encrypted_content)} chars, "
            f"decrypted={len(crawled_chapter['content'])} chars"
        )
        collected += 1

        chapter_id = next_info.get("id") if next_info else None
        time.sleep(REQUEST_DELAY)

    print(f"\nCollected {collected} sample pairs in {SAMPLES_DIR}/")


if __name__ == "__main__":
    main()
