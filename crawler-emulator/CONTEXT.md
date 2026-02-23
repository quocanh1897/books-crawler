# MTC Crawler

## Overview

Download books from metruyencv.net via its mobile API + emulator UI automation. The app is a Flutter-based Android app ("Novel Fever") that encrypts API responses, but caches **decrypted plaintext** in its local SQLite database. We trigger in-app downloads and extract the plaintext from the DB.

## Architecture

```
Emulator (MTC Debug APK)  ←→  mitmproxy (:8083)  ←→  android.lonoapp.net
     ↓
  SQLite DB (plaintext chapters)
     ↓
  grab_book.py  →  output/{book_id}/*.txt
```

## Quick Start

```bash
# Prerequisites: emulator running + mitmproxy on :8083
cd /Users/alenguyen/Documents/mtc/crawler

# Grab a single book by name
python3 grab_book.py "hủ bại thế giới"

# Download ALL bookmarked books (batch)
python3 batch_grab.py

# List all bookmarked books with status
python3 batch_grab.py --list

# Download only the next 5 pending books
python3 batch_grab.py --limit 5
```

## Scripts

| File              | Purpose                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------ |
| `grab_book.py`    | **Single book** — end-to-end: API search → app UI search → trigger download → monitor DB → extract txt |
| `batch_grab.py`   | **Batch download** — reads bookmarked list from DB, loops through pending books calling grab_book      |
| `config.py`       | API configuration (base URL, bearer token, headers)                                                    |
| `extract_book.py` | Standalone DB extraction — monitor + extract after manual download trigger                             |

## How `grab_book.py` Works

1. **API search**: `filter[keyword]` on `/api/books` → gets `book_id` + `chapter_count`
2. **Launch app**: navigate to Đánh dấu (bookmarks) tab
3. **Open search**: tap magnifying glass icon (882, 122)
4. **Type book name**: ASCII approximation via `adb input text` (diacritics-insensitive matching)
5. **3-dot menu**: tap 3-dot icon on search result → bottom sheet
6. **Tải truyện**: tap download option → fill chapter range dialog
7. **Confirm**: keyboard navigation (TAB → TAB → ENTER) for dialog buttons
8. **Monitor DB**: poll SQLite every 10s until all chapters downloaded
9. **Extract**: save individual `.txt` files + combined book file

## Key Technical Details

- **Search text**: `adb shell input text` only handles ASCII. Use `unicodedata.normalize("NFKD")` to strip Vietnamese diacritics. App search matches "hu bai the gioi" → "Hủ Bại Thế Giới"
- **Tab context**: must be on "Đánh dấu" tab BEFORE opening search, otherwise search defaults to "Lịch sử" (empty history)
- **Short queries**: only first 4 words typed (avoids issues with commas/special chars)
- **Dialog buttons**: TAB+ENTER works; direct taps on Flutter dialog buttons are unreliable
- **Keep app open**: do NOT press BACK after confirming download — it closes the app and stops the download
- **Chapter count**: must match exact total — invalid range silently fails

## Output Structure

```
output/{book_id}/
├── metadata.json                # book metadata (id, name, chapter_count, etc.)
├── 0001_chuong-1-slug.txt       # individual chapters
├── 0002_chuong-2-slug.txt
├── ...
└── Book Name.txt                # combined full book
```

## Downloaded Books

| Book                                | ID     | Chapters | Date       |
| ----------------------------------- | ------ | -------- | ---------- |
| Hủ Bại Thế Giới                     | 148610 | 256      | 2026-02-16 |
| Cẩu Tại Võ Đạo Thế Giới Thành Thánh | 144812 | 1050     | 2026-02-15 |
| (unknown)                           | 145005 | 961      | 2026-02-15 |
| (unknown)                           | 137544 | 712      | 2026-02-15 |

## Emulator Setup

- **AVD**: `Medium_Phone_API_36.1` (arm64-v8a, Google APIs)
- **APK**: `apk/mtc1.4.4/aligned_emu.apk` (reflutter-patched, debuggable)
- **Proxy**: mitmproxy on `:8083` (reflutter default, emulator → `10.0.2.2:8083`)
- **Launch**: `~/Library/Android/sdk/emulator/emulator -avd Medium_Phone_API_36.1`
- **DB extraction**: `adb shell "run-as com.novelfever.app.android.debug cat databases/app_database.db"`

## Platform Compatibility

**Currently macOS-only.** See `WINDOWS_MIGRATION.md` for the plan to add Windows 11 support. Key blockers:
- Hardcoded macOS ADB/SDK paths
- `/tmp/` temp directory (Unix-only)
- `multiprocessing.get_context('fork')` (not available on Windows)
- `sips` image tool (macOS-only)
- `start_emulators.sh` (Bash script)
