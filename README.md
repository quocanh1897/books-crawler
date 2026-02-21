# MTC

A multi-source Vietnamese web novel platform: crawling, decryption, conversion, and self-hosted reading. Downloads books from [metruyencv.com](https://metruyencv.com) and [truyen.tangthuvien.vn](https://truyen.tangthuvien.vn), converts them to EPUB, and serves them through a web reader at [lib.binscode.site](https://lib.binscode.site).

## Subprojects

| Directory | Language | Purpose |
|---|---|---|
| `crawler/` | Python 3.9+ | Emulator-based book grabber (UI automation + SQLite extraction) |
| `crawler-descryptor/` | Python 3.9+ | Direct API decryption — no emulator needed |
| `crawler-tangthuvien/` | Python 3.9+ | HTML scraper for truyen.tangthuvien.vn |
| `meta-puller/` | Python 3.9+ | Fetches book metadata + cover images from API |
| `epub-converter/` | Python 3.12 | Converts .txt chapters to EPUB 3.0 (Docker) |
| `progress-checking/` | Python 3.9+ | Real-time terminal TUI dashboard (rich) |
| `binslib/` | TypeScript | Next.js 15 / React 19 web reader and catalog |
| `vbook-extension/` | JavaScript | vBook app extension for reading from binslib |

## Data Pipeline

```
discover → download → decrypt → metadata → epub → import → serve
```

1. **Discover** — API rankings or tangthuvien listings
2. **Download + Decrypt** — Emulator-based (`crawler/`) or API-based (`crawler-descryptor/`)
3. **Metadata** — `meta-puller/` enriches with covers, authors, genres
4. **EPUB** — `epub-converter/` generates EPUB 3.0 files
5. **Import** — `binslib/scripts/import.ts` scans all crawler output directories into SQLite
6. **Serve** — `binslib/` Next.js app with reader, search (FTS5), bookmarks, EPUB download
7. **Mobile** — `vbook-extension/` provides access through the vBook Android app

## Quick Start

### Download books (API-based, preferred)

```bash
cd crawler-descryptor/
pip install -r requirements.txt
python3 main.py fetch-book <book_id>        # single book
python3 batch_download.py                    # batch download
python3 download_top1000.py -w 100           # top ranked books, 100 workers
```

### Download books (emulator-based, macOS only)

```bash
cd crawler/
./start_emulators.sh
python3 grab_book.py "book name"             # single book end-to-end
python3 parallel_grab.py                     # dual-emulator parallel download
```

### Download books (tangthuvien)

```bash
cd crawler-tangthuvien/
pip install -r requirements.txt
python3 discover.py --pages 50               # scrape book listings
python3 batch_download.py -w 3               # download discovered books
```

### Enrich metadata + generate EPUBs

```bash
cd meta-puller/
python3 pull_metadata.py                     # fetch covers, authors, genres

cd ../epub-converter/
docker compose run --rm epub-converter       # convert all books to EPUB
```

### Run the web reader

```bash
cd binslib/
npm install
npm run db:migrate
npm run import:full                          # import all crawler output
npm run dev                                  # http://localhost:3000
```

### Docker deployment

```bash
cd binslib/
docker compose up -d
docker compose logs -f binslib-importer
```

## Architecture

### Output format (shared across crawlers)

```
{crawler}/output/{book_id}/
├── book.json           # book metadata
├── cover.jpg           # cover image (from meta-puller)
├── 0001_slug.txt       # individual chapters
└── Book Name.txt       # combined full book
```

Tangthuvien uses a 10M+ ID offset to avoid collision with MTC book IDs.

### MTC encryption (solved)

The mobile API returns AES-128-CBC encrypted content in a Laravel envelope. The key is embedded at positions `[17:33]` within the encrypted response itself. See `crawler-descryptor/src/decrypt.py` for the extraction algorithm.

### Binslib stack

- Next.js 15 App Router with SSR
- SQLite + Drizzle ORM + FTS5 full-text search
- NextAuth.js v5 (credentials auth)
- Tailwind CSS 4
- On-demand EPUB generation from stored chapters

### vBook extension

A JavaScript extension for the [vBook](https://github.com/AaronLee01/vbook) Android reading app. Entirely API-driven (no scraping), communicates with the binslib backend via slug-based JSON APIs. See [`vbook-extension/README.md`](vbook-extension/README.md).

## Platform Compatibility

- `crawler/` — macOS only (hardcoded ADB paths, `sips`, fork-based multiprocessing)
- `crawler-descryptor/` — cross-platform
- `crawler-tangthuvien/` — cross-platform
- `binslib/` — cross-platform (Docker or Node.js)
- `vbook-extension/` — Android (vBook app)
