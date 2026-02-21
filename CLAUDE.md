# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

MTC is a multi-source Vietnamese web novel crawling, decryption, conversion, and serving platform. It downloads books from metruyencv.com (via Android emulator automation or direct API decryption) and truyen.tangthuvien.vn (HTML scraping), converts them to EPUB, and serves them through a self-hosted web reader.

## Subprojects

| Directory              | Language    | Purpose                                                         |
| ---------------------- | ----------- | --------------------------------------------------------------- |
| `crawler/`             | Python 3.9+ | Emulator-based book grabber (UI automation + SQLite extraction) |
| `crawler-descryptor/`  | Python 3.9+ | Direct API decryption — no emulator needed                      |
| `crawler-tangthuvien/` | Python 3.9+ | HTML scraper for truyen.tangthuvien.vn                          |
| `meta-puller/`         | Python 3.9+ | Fetches book metadata + cover images from API                   |
| `epub-converter/`      | Python 3.12 | Converts .txt chapters to EPUB 3.0 (Docker)                     |
| `progress-checking/`   | Python 3.9+ | Real-time terminal TUI dashboard (rich)                         |
| `binslib/`             | TypeScript  | Next.js 15 / React 19 web reader and catalog                    |

## Common Commands

### Crawler (emulator-based — macOS only)

```bash
cd crawler/
./start_emulators.sh                    # launch emulators + mitmproxy
python3 grab_book.py "book name"        # single book end-to-end
python3 batch_grab.py                   # all bookmarked books
python3 parallel_grab.py               # dual-emulator parallel download
python3 parallel_grab.py --list        # show pending books
```

### Crawler-Descryptor (API-based — preferred for bulk)

```bash
cd crawler-descryptor/
pip install -r requirements.txt
python3 main.py fetch-book <book_id>    # single book
python3 batch_download.py               # batch (hardcoded IDs)
python3 download_top1000.py -w 100      # top ranked books, 100 workers
```

### Crawler-Tangthuvien

```bash
cd crawler-tangthuvien/
pip install -r requirements.txt
python3 discover.py --pages 50          # scrape book listings
python3 batch_download.py -w 3          # download discovered books
```

### Meta-Puller

```bash
cd meta-puller/
python3 pull_metadata.py                # all books missing metadata
python3 pull_metadata.py --ids 147360   # specific books
```

### EPUB Converter (Docker)

```bash
cd epub-converter/
docker compose run --rm epub-converter
docker compose run --rm epub-converter --ids 100358 128390
```

### Progress Dashboard

```bash
cd progress-checking/
pip install -r requirements.txt
python3 dashboard.py                    # full monitoring
python3 dashboard.py --no-device        # output-only (no adb)
```

### Binslib Web App

```bash
cd binslib/
npm install
npm run db:migrate                      # run Drizzle migrations
npm run import:full                     # full import from crawler outputs
npm run import                          # incremental import
npm run import:cron                     # background polling (every 30 min)
npm run dev                             # dev server on localhost:3000
npm run db:studio                       # Drizzle Studio GUI

# Docker deployment
docker compose up -d
docker compose logs -f binslib-importer
```

## Architecture

### Data Pipeline

```
discover → download → decrypt → extract → metadata → epub → serve
```

1. **Discovery**: API rankings (`crawler-descryptor/download_top1000.py`) or tangthuvien listings (`crawler-tangthuvien/discover.py`)
2. **Download + Decrypt**: Either emulator-based (crawler/) or API-based (crawler-descryptor/)
3. **Metadata**: `meta-puller/` enriches with covers, authors, genres
4. **EPUB**: `epub-converter/` generates EPUB 3.0 files
5. **Import**: `binslib/scripts/import.ts` scans all output dirs into SQLite
6. **Serve**: `binslib/` Next.js app with reader, search (FTS5), bookmarks

### MTC Encryption (solved)

- Mobile API returns AES-128-CBC encrypted content in Laravel envelope format
- The key is embedded at positions [17:33] within the encrypted response itself
- See `crawler-descryptor/src/decrypt.py` for the extraction algorithm
- Original approach (crawler/): bypass encryption by extracting plaintext from app's SQLite DB

### Output Format (shared across crawlers)

```
{crawler}/output/{book_id}/
├── book.json          # or metadata.json — book info
├── cover.jpg          # cover image (from meta-puller)
├── 0001_slug.txt      # individual chapters
└── Book Name.txt      # combined full book
```

Tangthuvien uses 10M+ ID offset to avoid collision with MTC book IDs.

### Binslib Stack

- Next.js 15 App Router with SSR
- SQLite + Drizzle ORM + FTS5 full-text search
- NextAuth.js v5 (credentials auth)
- Tailwind CSS 4
- On-demand EPUB generation from stored chapters

## Key Technical Notes

- Python crawlers use `from __future__ import annotations` for 3.9 compatibility
- `crawler/` is macOS-only (hardcoded ADB paths, `sips`, fork-based multiprocessing)
- `crawler-descryptor/` and `crawler-tangthuvien/` are cross-platform
- reflutter hardcodes proxy port to 8083 — all emulators share `10.0.2.2:8083`
- Flutter ignores Android system proxy, env vars, and user CA certificates
- APK must have `android:debuggable="true"` for `run-as` DB access
- Binslib imports from both `crawler/output/` and `crawler-tangthuvien/output/`
- MTC API auth: Bearer token only (x-signature header is not validated server-side)
- MTC API base URL: `https://android.lonoapp.net`
