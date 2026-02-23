#!/usr/bin/env python3
"""
End-to-end automated book grabber: search → download → extract.

Uses keyboard navigation (TAB / arrow keys / ENTER) instead of
coordinate-based tapping for robust UI automation.

Flow:
  1. Search API for book_id + chapter_count
  2. Open app → search icon → type name → find in bookmarks
  3. Open 3-dot menu → Tải truyện → fill chapter range → confirm
  4. Monitor DB → extract decrypted plaintext → combined .txt

Usage:
    python3 grab_book.py "hủ bại thế giới"
    python3 grab_book.py "some book" --book-id 12345 --chapters 500
    python3 grab_book.py "some book" --skip-search   # already in bookmarks
"""
from __future__ import annotations

import glob
import json
import os
import re
import sqlite3
import subprocess
import sys
import time
import unicodedata

import httpx

from config import BASE_URL, HEADERS

ADB = os.path.expanduser("~/Library/Android/sdk/platform-tools/adb")
DEVICE = "emulator-5554"
PACKAGE = "com.novelfever.app.android.debug"
ACTIVITY = "com.example.novelfeverx.MainActivity"
OUTPUT_DIR = "output"
MAX_SEARCH_WORDS = 8
SEARCH_ICON = (882, 122)
SEARCH_FIELD = (350, 68)


def set_device(serial: str):
    """Switch target emulator. Resets uiautomator2 connection."""
    global DEVICE, _u2_device
    DEVICE = serial
    _u2_device = None



def clear_download_queue():
    """Remove bloated download queue from SharedPreferences to prevent ANR.

    The app accumulates download entries in flutter.downloadQueueWithId.
    When this gets too large, the app freezes on startup or when triggering
    new downloads. Clearing it before each session prevents this.
    """
    import xml.etree.ElementTree as ET
    prefs_xml = subprocess.run(
        [ADB, "-s", DEVICE, "shell",
         f"run-as {PACKAGE} cat shared_prefs/FlutterSharedPreferences.xml"],
        capture_output=True, timeout=10,
    ).stdout
    if not prefs_xml or b"<map" not in prefs_xml:
        return
    try:
        root = ET.fromstring(prefs_xml)
        removed = False
        for child in list(root):
            if "downloadQueue" in (child.get("name") or ""):
                root.remove(child)
                removed = True
        if not removed:
            return
        cleaned = ET.tostring(root, encoding="unicode", xml_declaration=True)
        tmp = "/data/local/tmp/_flutter_prefs_clean.xml"
        # Write cleaned prefs via temp file
        local = f"/tmp/mtc_prefs_clean_{DEVICE}.xml"
        with open(local, "w") as f:
            f.write(cleaned)
        subprocess.run([ADB, "-s", DEVICE, "push", local, tmp],
                       capture_output=True, timeout=10)
        subprocess.run([ADB, "-s", DEVICE, "shell",
                        f"run-as {PACKAGE} cp {tmp} shared_prefs/FlutterSharedPreferences.xml"],
                       capture_output=True, timeout=10)
        print(f"  [clean] Removed download queue from {PACKAGE}")
    except Exception as e:
        print(f"  [clean] Warning: {e}")


# ── ADB helpers ──────────────────────────────────────────────────────────────

def adb(*args: str, timeout: int = 30) -> bytes:
    cmd = [ADB, "-s", DEVICE] + list(args)
    return subprocess.run(cmd, capture_output=True, timeout=timeout).stdout


def key(code: str, delay: float = 0.4):
    """Send a single key event."""
    adb("shell", "input", "keyevent", code)
    time.sleep(delay)


def tap(x: int, y: int, delay: float = 0.5):
    adb("shell", "input", "tap", str(x), str(y))
    time.sleep(delay)


def type_text(s: str, delay: float = 0.5):
    """Type ASCII text. Spaces encoded as %s for adb."""
    adb("shell", "input", "text", s)
    time.sleep(delay)


_u2_device = None

def type_unicode(s: str, delay: float = 0.5):
    """Type Unicode/Vietnamese text using uiautomator2's send_keys."""
    global _u2_device
    if _u2_device is None:
        import uiautomator2 as u2
        import warnings
        warnings.filterwarnings("ignore")
        _u2_device = u2.connect(DEVICE)
    _u2_device.send_keys(s)
    time.sleep(delay)


def back(delay: float = 0.5):
    key("KEYCODE_BACK", delay)


def enter(delay: float = 0.5):
    key("KEYCODE_ENTER", delay)


def tab(delay: float = 0.4):
    key("KEYCODE_TAB", delay)


def down(delay: float = 0.3):
    key("KEYCODE_DPAD_DOWN", delay)


def up(delay: float = 0.3):
    key("KEYCODE_DPAD_UP", delay)


def right(delay: float = 0.3):
    key("KEYCODE_DPAD_RIGHT", delay)


def left(delay: float = 0.3):
    key("KEYCODE_DPAD_LEFT", delay)


def screencap(tag: str = "sc") -> str:
    """Take a screenshot, return PNG path. Also saves BMP for pixel analysis."""
    path = f"/tmp/mtc_{tag}_{int(time.time())}.png"
    png = subprocess.run(
        [ADB, "-s", DEVICE, "exec-out", "screencap", "-p"],
        capture_output=True, timeout=10,
    ).stdout
    with open(path, "wb") as f:
        f.write(png)
    # Convert to BMP for pixel analysis
    bmp = path.replace(".png", ".bmp")
    subprocess.run(["sips", "-s", "format", "bmp", path, "--out", bmp], capture_output=True)
    print(f"  [screenshot] {path}")
    return path


def find_3dot_y(png_path: str) -> int | None:
    """Scan a screenshot BMP for the 3-dot menu icon, return its Y center.

    The 3-dot icon is a vertical stack of 3 gray dots at x≈1000-1060.
    """
    import struct
    bmp_path = png_path.replace(".png", ".bmp")
    with open(bmp_path, "rb") as f:
        data = f.read()
    off = struct.unpack_from("<I", data, 10)[0]
    w = struct.unpack_from("<i", data, 18)[0]
    h = abs(struct.unpack_from("<i", data, 22)[0])
    bpp = struct.unpack_from("<H", data, 28)[0] // 8
    rs = (w * bpp + 3) & ~3

    def px(x, y):
        i = off + y * rs + x * bpp
        return data[i + 2], data[i + 1], data[i]

    # Scan for gray pixel rows at x=1000-1060 (3-dot icon region)
    gray_ys = []
    for y in range(200, 800, 3):
        n = sum(1 for x in range(1000, 1060, 2)
                if 80 < px(x, y)[0] < 180
                and abs(px(x, y)[0] - px(x, y)[1]) < 15)
        if n >= 3:
            gray_ys.append(y)
    if not gray_ys:
        return None

    # Group nearby y values
    groups = []
    g = [gray_ys[0]]
    for y in gray_ys[1:]:
        if y - g[-1] <= 6:
            g.append(y)
        else:
            groups.append((g[0] + g[-1]) // 2)
            g = [y]
    groups.append((g[0] + g[-1]) // 2)

    # Find triplets (3 dots within 60px vertical span)
    i = 0
    while i + 2 < len(groups):
        if groups[i + 2] - groups[i] < 60:
            return (groups[i] + groups[i + 2]) // 2
        i += 1
    return None


def pull_db() -> str:
    db_path = f"/tmp/mtc_grab_{DEVICE}.db"
    data = subprocess.run(
        [ADB, "-s", DEVICE, "shell", f"run-as {PACKAGE} cat databases/app_database.db"],
        capture_output=True, timeout=30,
    ).stdout
    with open(db_path, "wb") as f:
        f.write(data)
    return db_path


def find_tai_truyen_y(png_path: str) -> int | None:
    """Find the Y position of 'Tải truyện' text in a bottom sheet screenshot.

    Scans for dark text blocks in the bottom sheet area (y=1600-2300).
    Returns the center Y of the second text block (first = book title, second = Tải truyện).
    """
    import struct
    bmp_path = png_path.replace(".png", ".bmp")
    with open(bmp_path, "rb") as f:
        data = f.read()
    off = struct.unpack_from("<I", data, 10)[0]
    w = struct.unpack_from("<i", data, 18)[0]
    h = abs(struct.unpack_from("<i", data, 22)[0])
    bpp = struct.unpack_from("<H", data, 28)[0] // 8
    rs = (w * bpp + 3) & ~3

    def px(x, y):
        i = off + y * rs + x * bpp
        return data[i + 2], data[i + 1], data[i]

    # Find dark text rows in bottom sheet area
    items = []
    in_text = False
    start = 0
    for y in range(1600, 2300, 5):
        dark = sum(1 for x in range(80, 600, 5) if all(c < 80 for c in px(x, y)))
        if dark > 3 and not in_text:
            start = y
            in_text = True
        elif dark <= 3 and in_text:
            items.append((start, y))
            in_text = False
    if in_text:
        items.append((start, 2300))

    # Items from bottom: last=Xóa khỏi, second-to-last=Tải truyện.
    # Use [-2] because background list text can bleed through the overlay,
    # adding unpredictable extra items at the start.
    if len(items) >= 2:
        return (items[-2][0] + items[-2][1]) // 2
    if len(items) == 1:
        return (items[0][0] + items[0][1]) // 2
    return None


def strip_diacritics(text: str) -> str:
    """Vietnamese → ASCII (app search is diacritics-insensitive)."""
    nfkd = unicodedata.normalize("NFKD", text)
    out = "".join(c for c in nfkd if not unicodedata.combining(c))
    return out.replace("đ", "d").replace("Đ", "D")


# ── Phase 1: API search ─────────────────────────────────────────────────────

def search_book_api(name: str) -> dict | None:
    """Find the book by name via API. Returns book dict or None."""
    print(f"\n[Phase 1] API search for '{name}'...")

    with httpx.Client(headers=HEADERS, timeout=30) as c:
        # filter[keyword] — exact match
        try:
            r = c.get(f"{BASE_URL}/api/books",
                      params={"filter[keyword]": name, "limit": 5})
            if r.status_code == 200:
                data = r.json()
                if data.get("success") and data.get("data"):
                    book = data["data"][0]
                    if "book" in book:
                        book = book["book"]
                    print(f"  Found: {book['name']} (id={book['id']}, "
                          f"chapters={book.get('chapter_count', '?')})")
                    return book
        except Exception as e:
            print(f"  filter[keyword]: {e}")

        # /api/books/search?keyword= — fuzzy
        try:
            r = c.get(f"{BASE_URL}/api/books/search",
                      params={"keyword": name, "limit": 5})
            if r.status_code == 200:
                data = r.json()
                if data.get("success") and data.get("data"):
                    book = data["data"][0]
                    if "book" in book:
                        book = book["book"]
                    print(f"  Found (fuzzy): {book['name']} (id={book['id']}, "
                          f"chapters={book.get('chapter_count', '?')})")
                    return book
        except Exception as e:
            print(f"  /search: {e}")

    print("  Not found via API.")
    return None


# ── Phase 2: UI automation (keyboard-driven) ────────────────────────────────

def launch_app():
    """Navigate back to clean state and relaunch the app.

    Uses BACK presses (not force-stop) to preserve app state and avoid
    crashes on cold restart.
    """
    print("\n[Phase 2] Launching app...")
    # Press BACK many times to clear any dialogs/sheets/pages
    for _ in range(8):
        back(0.2)
    time.sleep(1)

    # Start the main activity (brings existing app to front or launches fresh)
    adb("shell", "am", "start", "-n", f"{PACKAGE}/{ACTIVITY}")

    # Wait for the app to be in the foreground
    for attempt in range(15):
        time.sleep(2)
        focus = adb("shell", "dumpsys", "window").decode(errors="ignore")
        if PACKAGE in focus and "MainActivity" in focus:
            print(f"  App ready (waited {(attempt+1)*2}s)")
            break
    else:
        # Fallback: force restart if the gentle approach didn't work
        print("  App not responding, force-restarting...")
        adb("shell", "am", "force-stop", PACKAGE)
        time.sleep(2)
        adb("shell", "am", "start", "-n", f"{PACKAGE}/{ACTIVITY}")
        time.sleep(10)
    screencap("home")


def tap_tai_truyen_and_fill(menu_screenshot: str, chapter_count: int,
                            start_chapter: int = 1):
    """Shared logic: tap Tải truyện in bottom sheet → fill dialog → confirm.

    Called after a 3-dot menu is already open (bottom sheet visible).
    This is the SINGLE source of truth for the dialog flow — never duplicate this.

    Uses field underline detection + direct taps on fields (NOT TAB navigation,
    which is unreliable across different Flutter contexts).
    """
    import struct

    # Find and tap Tải truyện — try detected position first, then known positions
    tai_y = find_tai_truyen_y(menu_screenshot)
    candidates = []
    if tai_y:
        candidates.append(tai_y)
    # Known positions from both contexts (bookmarks sheet vs search sheet)
    candidates.extend([1730, 1745, 2040, 2000, 1800, 1900])

    dialog_opened = False
    for y in candidates:
        print(f"  Trying Tải truyện at y={y}...")
        tap(300, y, delay=2)
        # Check if dialog appeared (look for wide underlines = input fields)
        check = screencap("dlg_check")
        bmp_check = check.replace(".png", ".bmp")
        try:
            import struct as _s
            with open(bmp_check, "rb") as _f:
                _d = _f.read()
            _off = _s.unpack_from("<I", _d, 10)[0]
            _w = _s.unpack_from("<i", _d, 18)[0]
            _bpp = _s.unpack_from("<H", _d, 28)[0] // 8
            _rs = (_w * _bpp + 3) & ~3
            def _px(x, y):
                i = _off + y * _rs + x * _bpp
                return _d[i+2], _d[i+1], _d[i]
            # Count wide gray underlines (dialog field indicators)
            wide_lines = 0
            for sy in range(800, 1500, 2):
                n = sum(1 for sx in range(250, 750)
                        if 100 < _px(sx, sy)[0] < 220
                        and abs(_px(sx, sy)[0] - _px(sx, sy)[1]) < 15)
                if n > 300:
                    wide_lines += 1
            if wide_lines >= 2:
                print(f"  Dialog detected!")
                dialog_opened = True
                break
        except Exception:
            pass

    if not dialog_opened:
        print("  WARNING: Dialog may not have opened")

    # Find field underlines in the dialog via pixel scan
    sc = screencap("dialog")
    bmp = sc.replace(".png", ".bmp")
    with open(bmp, "rb") as f:
        data = f.read()
    off = struct.unpack_from("<I", data, 10)[0]
    w = struct.unpack_from("<i", data, 18)[0]
    h = abs(struct.unpack_from("<i", data, 22)[0])
    bpp = struct.unpack_from("<H", data, 28)[0] // 8
    rs = (w * bpp + 3) & ~3

    def px(x, y):
        i = off + y * rs + x * bpp
        return data[i + 2], data[i + 1], data[i]

    # Find the two widest gray underlines (the field underlines)
    scored = []
    for y in range(800, 1500, 2):
        n = sum(1 for x in range(250, 750)
                if 100 < px(x, y)[0] < 220 and abs(px(x, y)[0] - px(x, y)[1]) < 15)
        if n > 100:
            scored.append((y, n))
    # Deduplicate, keep widest per group
    groups = []
    if scored:
        cur_y, cur_w = scored[0]
        for y, w2 in scored[1:]:
            if y - cur_y <= 20:
                if w2 > cur_w:
                    cur_y, cur_w = y, w2
            else:
                groups.append((cur_y, cur_w))
                cur_y, cur_w = y, w2
        groups.append((cur_y, cur_w))
    # Pick the two widest
    groups.sort(key=lambda g: g[1], reverse=True)
    underlines = sorted([g[0] for g in groups[:2]])

    if len(underlines) >= 2:
        field1_y = underlines[0] - 30
        field2_y = underlines[1] - 30
        print(f"  Fields at y={field1_y}, y={field2_y}")
    else:
        # Fallback to default positions
        field1_y = 1100
        field2_y = 1260
        print(f"  WARNING: Underlines not found, using defaults y={field1_y}, y={field2_y}")

    # Pure TAB navigation within the dialog (reliable in Flutter dialogs).
    # Dialog opens with focus on title. TAB order: title → field1 → field2 → Hủy → Đồng ý
    print(f"  Filling: {start_chapter} → {chapter_count}")
    tab(0.5)                   # title → field1
    type_text(str(start_chapter), delay=0.5)
    tab(0.3)                   # field1 → field2
    type_text(str(chapter_count), delay=0.5)

    # TAB TAB ENTER: field2 → Hủy → Đồng ý → confirm
    print("  Confirming: TAB → TAB → ENTER")
    tab(0.3)                   # → Hủy
    tab(0.3)                   # → Đồng ý
    enter(delay=5)             # confirm
    screencap("confirmed")

    # Dismiss bottom sheet (NOT back — back closes the app!)
    tap(540, 400, delay=2)


def ui_search_and_download(book_name: str, chapter_count: int,
                           start_chapter: int = 1) -> bool:
    """Full UI flow: search → 3-dot → Tải truyện → fill → confirm.

    Key insight: must be on "Đánh dấu" tab BEFORE opening search
    so the search view defaults to bookmarks (not history).

    Uses minimal taps for known UI elements + keyboard for navigation.
    """

    # ── Step 1: Ensure we're on Đánh dấu tab first ──────────────────────
    print("  [Step 1] Switching to Đánh dấu tab...")
    tap(370, 255, delay=1)     # Đánh dấu tab in main view
    tap(370, 255, delay=1)     # double-tap to ensure
    screencap("bookmarks_tab")

    # ── Step 2: Open search (from Đánh dấu context) ─────────────────────
    print("  [Step 2] Opening search...")
    tap(882, 122, delay=2)     # search icon
    screencap("search_open")

    # ── Step 3: Type search query (full Vietnamese via uiautomator2) ────
    words = re.split(r"[,;:!?\s]+", book_name)
    words = [w for w in words if w]
    short_query = " ".join(words[:MAX_SEARCH_WORDS])

    print(f"  [Step 3] Typing: '{short_query}'")
    tap(*SEARCH_FIELD, delay=0.5)
    type_unicode(short_query, delay=1)
    enter(delay=3)             # submit search

    # ── Step 4: Find and tap 3-dot icon ──────────────────────────────────
    sc4 = screencap("find3dot")
    dot_y = find_3dot_y(sc4)

    if not dot_y:
        # Search may have returned no results. Try Lịch sử tab as fallback.
        print("  No result in Đánh dấu, trying Lịch sử tab...")
        tap(70, 141, delay=1)  # tap Lịch sử tab
        time.sleep(2)
        sc4 = screencap("fallback_lichsu")
        dot_y = find_3dot_y(sc4)

    if not dot_y:
        print("  ERROR: Book not found in search results. Skipping.")
        back(1)
        return False

    print(f"  [Step 4] Found 3-dot at y={dot_y}")
    tap(1008, dot_y, delay=3)
    sc5 = screencap("menu")

    # ── Step 5+6: Tải truyện → fill dialog → confirm ───────────────────
    tap_tai_truyen_and_fill(sc5, chapter_count, start_chapter)
    return True


def ui_skip_search_download(bookmark_idx: int, chapter_count: int):
    """Trigger download from bookmarks tab using keyboard navigation.

    Used with --skip-search when book is already bookmarked.
    """
    print("  Navigating to bookmarks tab...")
    # Tap bookmarks tab (one known position in main view)
    tap(370, 255, delay=2)
    tap(370, 255, delay=2)
    screencap("bookmarks")

    # Navigate to the target book's 3-dot icon
    # TAB through: tab bar → first book row → 3-dot → second book row → ...
    print(f"  Navigating to bookmark index {bookmark_idx}...")
    # Each book row has: cover, title, 3-dot. TAB cycles through them.
    # First few TABs get us past the tab bar items.
    for _ in range(3):         # past tab bar
        tab(0.3)
    for _ in range(bookmark_idx):
        # Skip one book row (cover + title + 3-dot = ~3 tabs)
        for _ in range(3):
            tab(0.3)
    # Now at the target book area, tab to the 3-dot icon
    for _ in range(2):
        tab(0.3)
    enter(delay=3)             # open 3-dot menu
    screencap("menu")

    # Select Tải truyện
    print("  Selecting Tải truyện...")
    tab(0.3)
    tab(0.3)
    enter(delay=3)
    screencap("dialog")

    # Fill dialog
    print(f"  Filling: 1 → {chapter_count}")
    type_text("1", delay=0.3)
    tab(0.3)
    type_text(str(chapter_count), delay=0.3)
    back(0.3)
    tab(0.3)
    tab(0.3)
    enter(delay=5)
    screencap("confirmed")

    # Dismiss bottom sheet by tapping above (NOT back — closes app!)
    tap(540, 400, delay=2)


# ── Phase 3: Wait & Extract ─────────────────────────────────────────────────

def wait_for_download(book_id: int, target: int, timeout: int = 3600) -> int:
    """Poll DB until target chapters downloaded."""
    print(f"\n[Phase 3] Waiting for {target} chapters...")
    start = time.time()
    last = 0
    stale = 0

    while time.time() - start < timeout:
        time.sleep(10)
        try:
            conn = sqlite3.connect(pull_db())
            count = conn.execute(
                "SELECT COUNT(*) FROM Chapter WHERE bookId=?", (book_id,)
            ).fetchone()[0]
            conn.close()
        except Exception:
            continue

        if count != last:
            pct = count * 100 // target if target else 0
            print(f"  {int(time.time()-start)}s: {count}/{target} ({pct}%)")
            last = count
            stale = 0
        else:
            stale += 1

        if count >= target:
            print("  Download complete!")
            return count
        if stale > 30:
            print(f"  Stalled at {count}/{target}")
            return count

    print(f"  Timeout at {last}/{target}")
    return last


def extract_chapters(book_id: int, book_name: str) -> int:
    """Extract chapters from DB → individual .txt files.

    Skips chapters whose file already exists on disk so partial
    re-extractions don't overwrite previous data.
    Returns total chapter files on disk (existing + newly saved).
    """
    out = os.path.join(OUTPUT_DIR, str(book_id))
    os.makedirs(out, exist_ok=True)

    # Build set of chapter indices already on disk
    existing_indices: set[int] = set()
    for fname in os.listdir(out):
        if fname.endswith(".txt") and fname[0].isdigit():
            try:
                existing_indices.add(int(fname.split("_", 1)[0]))
            except ValueError:
                pass

    conn = sqlite3.connect(pull_db())
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT * FROM Chapter WHERE bookId=? ORDER BY `index`", (book_id,)
    ).fetchall()
    conn.close()

    newly_saved = 0

    for row in rows:
        idx = row["index"] or row["id"]
        slug = row["slug"] or f"chapter-{idx}"
        name = row["name"] or f"Chapter {idx}"
        content = row["content"] or ""
        if len(content) < 10:
            continue
        if idx in existing_indices:
            continue
        with open(os.path.join(out, f"{idx:04d}_{slug}.txt"), "w", encoding="utf-8") as f:
            f.write(f"{name}\n\n{content}")
        newly_saved += 1

    total_on_disk = len(existing_indices) + newly_saved

    # Write/update metadata.json with extraction stats
    meta_path = os.path.join(out, "metadata.json")
    meta = {}
    if os.path.exists(meta_path):
        try:
            with open(meta_path) as f:
                meta = json.load(f)
        except (json.JSONDecodeError, OSError):
            pass
    meta.update({
        "id": book_id,
        "name": book_name,
        "chapter_count": total_on_disk,
        "total_in_db": len(rows),
    })
    with open(meta_path, "w") as f:
        json.dump(meta, f, indent=2, ensure_ascii=False)

    if newly_saved:
        print(f"  Extracted {newly_saved} new chapters ({total_on_disk} total on disk)")
    else:
        print(f"  No new chapters to extract ({total_on_disk} already on disk)")

    return total_on_disk


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    import argparse
    p = argparse.ArgumentParser(description="Grab a book by name")
    p.add_argument("name", help="Book name (Vietnamese OK)")
    p.add_argument("--book-id", type=int, default=0)
    p.add_argument("--chapters", type=int, default=0)
    p.add_argument("--skip-search", action="store_true",
                    help="Book already bookmarked, go straight to download")
    p.add_argument("--bookmark-idx", type=int, default=0,
                    help="Position in bookmarks (0=first)")
    p.add_argument("--device", default="emulator-5554",
                    help="ADB device serial (default: emulator-5554)")
    args = p.parse_args()

    set_device(args.device)

    book_name = args.name
    book_id = args.book_id
    chapter_count = args.chapters

    print(f"{'='*60}")
    print(f"  Grabbing: {book_name}")
    print(f"{'='*60}")

    # Phase 1: API search
    if not book_id or not chapter_count:
        api = search_book_api(book_name)
        if api:
            book_id = book_id or api["id"]
            chapter_count = chapter_count or api.get("chapter_count", 0)

    if not book_id or not chapter_count:
        print("\n  Could not find book via API.")
        if not book_id:
            book_id = int(input("  Book ID: "))
        if not chapter_count:
            chapter_count = int(input("  Chapters: "))

    print(f"\n  Book ID: {book_id}, Chapters: {chapter_count}")

    # Phase 2: UI automation
    launch_app()

    if args.skip_search:
        ui_skip_search_download(args.bookmark_idx, chapter_count)
    else:
        ui_search_and_download(book_name, chapter_count)

    # Verify download started
    time.sleep(10)
    try:
        conn = sqlite3.connect(pull_db())
        count = conn.execute(
            "SELECT COUNT(*) FROM Chapter WHERE bookId=?", (book_id,)
        ).fetchone()[0]
        conn.close()
        print(f"  DB check: {count} chapters")
        if count == 0:
            print("  WARNING: Download may not have started. Check screenshots.")
    except Exception:
        pass

    # Phase 3: Wait & extract
    final = wait_for_download(book_id, chapter_count)

    print(f"\n[Phase 4] Extracting...")
    saved = extract_chapters(book_id, book_name)

    print(f"\n{'='*60}")
    print(f"  Done! {saved}/{chapter_count} chapters → {OUTPUT_DIR}/{book_id}/")
    print(f"{'='*60}")


if __name__ == "__main__":
    main()
