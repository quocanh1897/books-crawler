#!/usr/bin/env python3
"""
crawler-descryptor: Fetch and decrypt chapters directly from the mobile API.

Commands:
    fetch-chapter <chapter_id>   Fetch + decrypt a single chapter
    fetch-book <book_id>         Fetch all chapters of a book
    analyze <chapter_id>         Show encryption details for a chapter

The AES-128 key is automatically extracted from each API response —
no external key or Frida hooks required.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time

from src.client import APIClient, ChapterNotFound
from src.decrypt import DecryptionError, decrypt_content, extract_key_and_envelope
from src.utils import count_existing_chapters, save_chapter, save_metadata


def cmd_fetch_chapter(args):
    """Fetch and decrypt a single chapter."""
    with APIClient() as client:
        print(f"Fetching chapter {args.chapter_id}...")
        data = client.get_chapter(args.chapter_id)
        print(f"  Book: {data.get('book', {}).get('name', '?')}")
        print(f"  Chapter: {data.get('name', '?')} (index {data.get('index', '?')})")

        encrypted = data.get("content", "")
        if not encrypted:
            print("  No content field!")
            return

        try:
            plaintext = decrypt_content(encrypted)
            print(f"  Decrypted: {len(plaintext)} chars")
            print(f"\n--- First 500 chars ---\n{plaintext[:500]}")

            if args.output:
                with open(args.output, "w", encoding="utf-8") as f:
                    f.write(plaintext)
                print(f"\nSaved to {args.output}")
        except DecryptionError as e:
            print(f"\n  Decryption failed: {e}")


def cmd_fetch_book(args):
    """Fetch and decrypt all chapters of a book."""
    with APIClient() as client:
        print(f"Fetching book {args.book_id} metadata...")
        book = client.get_book(args.book_id)
        name = book.get("name", f"Book {args.book_id}")
        total = book.get("chapter_count", 0)
        first_id = book.get("first_chapter")

        print(f"  Name: {name}")
        print(f"  Chapters: {total}")
        print(f"  First chapter ID: {first_id}")

        if not first_id:
            print("  No first_chapter in metadata!")
            return

        existing = count_existing_chapters(args.book_id)
        if existing:
            print(f"  Already on disk: {len(existing)} chapters (will skip)")

        save_metadata(args.book_id, book)

        saved = 0
        skipped = 0
        errors = 0
        start_time = time.time()

        for chapter in client.iter_chapters(first_id, max_chapters=total):
            index = chapter.get("index", 0)
            slug = chapter.get("slug", f"chapter-{index}")
            ch_name = chapter.get("name", f"Chapter {index}")
            encrypted = chapter.get("content", "")

            if index in existing:
                skipped += 1
                continue

            if not encrypted:
                print(f"  [{index}/{total}] No content, skipping")
                errors += 1
                continue

            try:
                plaintext = decrypt_content(encrypted)
                save_chapter(args.book_id, index, slug, ch_name, plaintext)
                saved += 1
                elapsed = time.time() - start_time
                rate = saved / elapsed if elapsed > 0 else 0
                print(f"  [{index}/{total}] {ch_name} — {len(plaintext)} chars "
                      f"({rate:.1f} ch/s)")
            except DecryptionError as e:
                print(f"  [{index}/{total}] FAILED: {e}")
                errors += 1

        elapsed = time.time() - start_time
        print(f"\nDone in {elapsed:.0f}s: {saved} saved, {skipped} skipped, {errors} errors")


def cmd_analyze(args):
    """Fetch a chapter and dump its encryption envelope for analysis."""
    with APIClient() as client:
        print(f"Fetching chapter {args.chapter_id}...")
        data = client.get_chapter(args.chapter_id)
        encrypted = data.get("content", "")
        if not encrypted:
            print("No content!")
            return

        print(f"Raw content length: {len(encrypted)} chars")
        print(f"Injected key chars [17:33]: {encrypted[17:33]!r}")

        key, envelope = extract_key_and_envelope(encrypted)
        print(f"\nExtracted key (hex): {key.hex()}")
        print(f"IV (base64): {envelope['iv']}")
        print(f"Value length: {len(envelope['value'])} chars")
        print(f"MAC: {envelope['mac']}")

        try:
            plaintext = decrypt_content(encrypted)
            print(f"\nDecryption: SUCCESS ({len(plaintext)} chars)")
            print(f"Preview: {plaintext[:200]}...")
        except DecryptionError as e:
            print(f"\nDecryption: FAILED — {e}")

        if args.output:
            with open(args.output, "w", encoding="utf-8") as f:
                json.dump({
                    "chapter_id": data["id"],
                    "key_hex": key.hex(),
                    "iv_b64": envelope["iv"],
                    "value_len": len(envelope["value"]),
                    "mac": envelope["mac"],
                }, f, indent=2)
            print(f"\nSaved analysis to {args.output}")


def main():
    parser = argparse.ArgumentParser(
        description="Fetch and decrypt chapters from the mobile API",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )

    sub = parser.add_subparsers(dest="command")

    p_ch = sub.add_parser("fetch-chapter", help="Fetch + decrypt a single chapter")
    p_ch.add_argument("chapter_id", type=int)
    p_ch.add_argument("-o", "--output", help="Save plaintext to file")

    p_book = sub.add_parser("fetch-book", help="Fetch all chapters of a book")
    p_book.add_argument("book_id", type=int)

    p_analyze = sub.add_parser("analyze", help="Analyze encryption envelope")
    p_analyze.add_argument("chapter_id", type=int)
    p_analyze.add_argument("-o", "--output", help="Save analysis to JSON file")

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        return

    if args.command == "fetch-chapter":
        cmd_fetch_chapter(args)
    elif args.command == "fetch-book":
        cmd_fetch_book(args)
    elif args.command == "analyze":
        cmd_analyze(args)


if __name__ == "__main__":
    main()
