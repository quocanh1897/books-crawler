# MTC

A multi-source Vietnamese web novel platform — crawling, decryption, conversion, and self-hosted reading.

Downloads books from [metruyencv.net](https://metruyencv.com) (via API decryption or Android emulator automation) and [truyen.tangthuvien.vn](https://truyen.tangthuvien.vn) (HTML scraping), imports them into a SQLite database, converts to EPUB, and serves through a web reader.

## Architecture

```txt
┌─────────────────────────────────────────────────────────────────┐
│                        Data Sources                             │
│  metruyencv.net (AES-128-CBC encrypted API)                     │
│  truyen.tangthuvien.vn (public HTML)                            │
└──────────────┬────────────────────────┬─────────────────────────┘
               │                        │
    ┌──────────┴──────────┐  ┌──────────┴───────────────┐
    │ crawler-descryptor  │  │ crawler-tangthuvien      │
    │ API decrypt (fast)  │  │ HTML scraper             │
    ├─────────────────────┤  ├──────────────────────────┤
    │ crawler             │  │                          │
    │ emulator UI auto    │  │                          │
    └──────────┬──────────┘  └──────────┬───────────────┘
               │                        │
               └────────┬───────────────┘
                        ↓
            crawler/output/{book_id}/
            ├── metadata.json          ← meta-puller (API metadata + cover)
            ├── cover.jpg
            └── 0001_slug.txt ...      ← temporary chapter files
                        │
                        ↓
              binslib/scripts/import.ts --cleanup
                        │
               ┌────────┴────────┐
               ↓                 ↓
        SQLite database    .txt files deleted
        (binslib.db)       (disk space freed)
               │
        ┌──────┴──────┐
        ↓              ↓
   binslib webapp   epub-converter
   (Next.js reader) (EPUB 3.0 generation)
```

## Components

| Directory              | Language   | Purpose                                                    |
| ---------------------- | ---------- | ---------------------------------------------------------- |
| `crawler-descryptor/`  | Python     | Direct API decryption — bulk download, no emulator needed  |
| `crawler-tangthuvien/` | Python     | HTML scraper for truyen.tangthuvien.vn                     |
| `crawler/`             | Python     | Emulator-based grabber (UI automation + SQLite extraction) |
| `meta-puller/`         | Python     | Fetches book metadata + cover images from MTC API          |
| `epub-converter/`      | Python     | Converts chapters to EPUB 3.0 (Docker)                     |
| `binslib/`             | TypeScript | Next.js 15 web reader, catalog, and SQLite import pipeline |
| `progress-checking/`   | Python     | Real-time terminal TUI dashboard                           |

## Quick Start

### Download books (API-based — preferred)

```bash
cd crawler-descryptor/
pip install -r requirements.txt

python3 main.py fetch-book 100358            # single book by ID
python3 batch_download.py 100441 101481      # specific book IDs
python3 download_top1000.py -w 100           # top ranked books, 100 workers
```

### Download books (tangthuvien)

```bash
cd crawler-tangthuvien/
pip install -r requirements.txt

python3 discover.py --pages 50               # scrape book listings
python3 batch_download.py -w 5               # download discovered books
```

### Pull metadata and covers

```bash
cd meta-puller/
python3 pull_metadata.py                     # all books missing metadata
python3 pull_metadata.py --ids 147360 --force  # specific books, force refresh
```

### Import to database and clean up

```bash
cd binslib/
npm install
npx tsx scripts/import.ts                    # incremental import
npx tsx scripts/import.ts --full             # full re-import
npx tsx scripts/import.ts --cleanup          # import + delete .txt files after
npx tsx scripts/import.ts --ids 100358 100441  # specific books only
```

Chapter `.txt` files are temporary — after import, chapters live in the SQLite database and the `.txt` files can be safely removed with `--cleanup`.

### Serve the web reader

```bash
cd binslib/
npm run dev                                  # dev server on localhost:3000

# Or with Docker
docker compose up -d
```

### Convert to EPUB

```bash
cd epub-converter/
docker compose run --rm epub-converter                   # all books
docker compose run --rm epub-converter --ids 100358      # specific book
```

The converter reads chapters from the SQLite database (falling back to `.txt` files on disk if available).

### Download books (emulator-based — legacy)

```bash
cd crawler/
./start_emulators.sh                         # launch emulators + mitmproxy
python3 grab_book.py "book name"             # single book end-to-end
python3 batch_grab.py                        # all bookmarked books
python3 parallel_grab.py                     # dual-emulator parallel download
```

Requires macOS, Android SDK, patched APK. See `KNOWLEDGE.md` for full setup details.

### Monitor progress

```bash
cd progress-checking/
pip install -r requirements.txt
python3 dashboard.py                         # full monitoring TUI
python3 dashboard.py --no-device             # output-only (no adb)
```

## Data Pipeline

```txt
discover → download → decrypt → metadata → import (SQLite) → serve / epub
                                               ↓
                                     cleanup .txt files
```

1. **Discovery** — API rankings (`crawler-descryptor`) or HTML scraping (`crawler-tangthuvien`)
2. **Download + Decrypt** — API-based decryption (preferred) or emulator automation
3. **Metadata** — `meta-puller` enriches with covers, authors, genres from API
4. **Import** — `binslib/scripts/import.ts` scans output dirs into SQLite
5. **Cleanup** — `.txt` chapter files deleted after import (`--cleanup` flag)
6. **Serve** — `binslib` Next.js app with reader, search (FTS5), bookmarks
7. **EPUB** — `epub-converter` generates EPUB 3.0 from SQLite or `.txt` files

## Output Format

After crawling, each book directory contains:

```txt
crawler/output/{book_id}/
├── metadata.json          # full API metadata (kept permanently)
├── cover.jpg              # poster image (kept permanently)
├── book.json              # download stats: chapters_saved, total_in_db (kept)
├── 0001_chuong-1-slug.txt # chapter files (temporary — removed after import)
├── 0002_chuong-2-slug.txt
└── ...
```

After `import.ts --cleanup`, only `metadata.json`, `cover.jpg`, and `book.json` remain on disk. All chapter content lives in the SQLite database.

Tangthuvien books use a 10,000,000+ ID offset to avoid collision with MTC book IDs.

## MTC Encryption

The mobile API encrypts chapter content (AES-128-CBC, Laravel envelope). The encryption has been **fully reverse-engineered** — no emulator, external key, or Frida hooks needed.

The server embeds a per-response AES key at positions `[17:33]` within the base64 content string. The key is extracted, removed, and the remaining base64 decoded into a standard Laravel encryption envelope. See `crawler-descryptor/README.md` for the full algorithm.

The original approach (`crawler/`) bypassed encryption entirely by extracting plaintext from the app's local SQLite database via UI automation.

## Binslib Web App

- **Next.js 15** App Router with SSR
- **SQLite** + Drizzle ORM + FTS5 full-text search
- **NextAuth.js v5** (credentials auth)
- **Tailwind CSS 4**
- On-demand EPUB generation from stored chapters
- Background import daemon (`--cron` mode)

## Prerequisites

| Component             | Requirements                                      |
| --------------------- | ------------------------------------------------- |
| `crawler-descryptor`  | Python 3.9+, `httpx`, `pycryptodome`              |
| `crawler-tangthuvien` | Python 3.9+, `httpx`, `beautifulsoup4`, `lxml`    |
| `meta-puller`         | Python 3.9+, `httpx`, `rich`                      |
| `epub-converter`      | Docker (or Python 3.12 with `ebooklib`, `Pillow`) |
| `binslib`             | Node.js 22+, npm                                  |
| `crawler` (emulator)  | macOS, Android SDK, patched APK, mitmproxy        |
| `progress-checking`   | Python 3.9+, `rich`                               |

## Project Structure

```txt
mtc/
├── README.md                          # This file
├── CLAUDE.md                          # AI assistant guidance
├── KNOWLEDGE.md                       # Project knowledge base
├── API.md                             # API endpoint documentation
├── ENCRYPTION.md                      # Encryption analysis
├── CHANGELOG.md
├── crawler-descryptor/                # API-based decryption crawler
│   ├── main.py                        #   CLI: fetch-chapter, fetch-book
│   ├── batch_download.py              #   Parallel batch download
│   ├── download_top1000.py            #   Ranking-based bulk download
│   └── src/                           #   decrypt.py, client.py, utils.py
├── crawler-tangthuvien/               # TTV HTML scraper
│   ├── discover.py                    #   Scrape book listings
│   ├── batch_download.py              #   Async parallel download
│   └── src/                           #   client.py, parser.py, utils.py
├── crawler/                           # Emulator-based grabber (legacy)
│   ├── config.py                      #   API config (shared by meta-puller)
│   ├── grab_book.py                   #   Single-book end-to-end
│   ├── parallel_grab.py               #   Dual-emulator orchestrator
│   ├── progress-checking/             #   audit.py
│   └── output/                        #   (gitignored) book data
├── meta-puller/                       # Metadata + cover fetcher
│   └── pull_metadata.py
├── epub-converter/                    # EPUB 3.0 converter (Docker)
│   ├── convert.py                     #   CLI entry point
│   ├── epub_builder.py                #   Core EPUB build logic
│   └── docker-compose.yml
├── binslib/                           # Next.js web reader
│   ├── scripts/import.ts              #   SQLite import + cleanup pipeline
│   ├── src/                           #   App Router pages, API routes
│   ├── data/binslib.db                #   (gitignored) SQLite database
│   └── docker-compose.yml
├── progress-checking/                 # Terminal TUI dashboard
│   └── dashboard.py
└── apk/                               # (gitignored) patched APKs
```

## License

Private project — not for redistribution.
