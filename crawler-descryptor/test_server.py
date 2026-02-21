#!/usr/bin/env python3
"""Quick test: fetch 1 chapter, download 3 books with 3 workers."""
from __future__ import annotations
import asyncio, sys, os, time
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "crawler"))

import httpx
from config import BASE_URL, HEADERS
from src.decrypt import decrypt_content
from src.utils import count_existing_chapters, save_chapter, save_metadata

async def test_single():
    async with httpx.AsyncClient(headers=HEADERS, timeout=30) as client:
        ch_id = 10340503
        print(f"Fetching chapter {ch_id}...")
        t1 = time.time()
        r = await client.get(f"{BASE_URL}/api/chapters/{ch_id}")
        t2 = time.time()
        print(f"  Status: {r.status_code}, time: {t2-t1:.2f}s")
        d = r.json()
        if not d.get("success"):
            print(f"  ERROR: {d}")
            return False
        ch = d.get("data", {}).get("chapter", d.get("data", {}))
        content = ch.get("content", "")
        if content:
            plain = decrypt_content(content)
            print(f"  Decrypted OK: {len(plain)} chars")
        nxt = ch.get("next")
        print(f"  Next: {nxt}")
        return True

async def test_book(client, sem, book_id, first_ch, max_ch=5):
    """Download a few chapters of a book."""
    async with sem:
        print(f"  Book {book_id}: starting from ch {first_ch}")
        ch_id = first_ch
        saved = 0
        t1 = time.time()
        while ch_id and saved < max_ch:
            r = await client.get(f"{BASE_URL}/api/chapters/{ch_id}")
            d = r.json()
            if not d.get("success"):
                print(f"  Book {book_id}: API error at ch {ch_id}: {d.get('message','?')}")
                break
            ch = d.get("data", {}).get("chapter", d.get("data", {}))
            nxt = ch.get("next")
            ch_id = nxt.get("id") if nxt else None
            content = ch.get("content", "")
            if content:
                plain = decrypt_content(content)
                saved += 1
        elapsed = time.time() - t1
        rate = saved / elapsed if elapsed > 0 else 0
        print(f"  Book {book_id}: saved {saved} in {elapsed:.1f}s ({rate:.1f}/s)")

async def test_parallel():
    sem = asyncio.Semaphore(10)
    async with httpx.AsyncClient(headers=HEADERS, timeout=30) as client:
        books = [
            (148610, 25068413),  # Hủ Bại Thế Giới
            (100267, 10340503),  # Ta Đem Trái Đất Làm Thành Võng Du
            (100358, 10351619),  # Vô Thượng Sát Thần
        ]
        tasks = [test_book(client, sem, bid, fch, 10) for bid, fch in books]
        await asyncio.gather(*tasks)

async def main():
    print("=== Single chapter test ===")
    ok = await test_single()
    if not ok:
        print("Single chapter failed, aborting")
        return

    print("\n=== Parallel book test (3 books, 10 ch each) ===")
    await test_parallel()
    print("\nDone!")

asyncio.run(main())
