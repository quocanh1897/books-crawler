# Binslib

Next.js web reader and data pipeline for Vietnamese web novels. Imports crawled book data into SQLite, serves it through a web UI at [lib.binscode.site](https://lib.binscode.site), and exposes JSON APIs for the vBook Android extension.

## Stack

- Next.js 15 (App Router, SSR, Turbopack)
- SQLite + Drizzle ORM + FTS5 full-text search
- NextAuth.js v5 (credentials auth)
- Tailwind CSS 4
- zstd compression for chapter storage (with optional global dictionary)

## Setup

```bash
npm install
npm run db:migrate
npm run import:full      # import all crawler output
npm run dev              # http://localhost:3000
```

## Data Pipeline

The pipeline has two stages: **import** (crawler files → SQLite + compressed disk storage) and **export** (DB chapter bodies → compressed disk files, for migration).

### Storage layout

```
data/
  binslib.db                  # SQLite — metadata, chapter index, users, FTS
  compressed/
    {book_id}/
      {index}.txt.zst         # zstd-compressed chapter body
  import-log.txt              # import run history
  export-log.txt              # export run history
  global.dict                 # optional zstd dictionary for better compression
```

Chapter bodies are stored as individual zstd-compressed files on disk, not in the database. The `chapters` table in SQLite holds only metadata (title, slug, word count, book/index references). This keeps the DB small (< 1 GB) while supporting millions of chapters.

---

## Import Process

**Script**: `scripts/import.ts`

Scans crawler output directories and loads book data into SQLite. Each book folder is expected to follow the shared crawler output format:

```
crawler/output/{book_id}/
  metadata.json           # book metadata (name, author, genres, stats, etc.)
  book.json               # crawler state (chapters_saved count)
  cover.jpg               # cover image
  0001_chapter-slug.txt   # chapter files: {4-digit index}_{slug}.txt
  0002_chapter-slug.txt
  ...
```

### What the import does

For each book directory (scanned from both `crawler/output/` and `crawler-tangthuvien/output/`):

1. **Reads `metadata.json`** — if missing, tries to fetch it by running `meta-puller/pull_metadata.py`
2. **Computes a metadata hash** (MD5) for change detection in incremental mode
3. **Incremental skip logic** — in default mode, skips books where both the metadata hash and `updated_at` timestamp are unchanged, and the DB already has all chapters from `book.json`
4. **Copies `cover.jpg`** to `public/covers/{book_id}.jpg` for serving by Next.js
5. **Imports in a single SQLite transaction** per book:
   - Upserts author, genres (auto-assigns IDs for TTV genres without numeric IDs), and tags
   - Inserts or replaces the book row with all metadata fields and a `source` column (`mtc` or `ttv`)
   - For each chapter `.txt` file:
     - Extracts the title from the first line
     - Strips the title and leading blanks to get the body text
     - Writes the body to disk as a zstd-compressed file via `chapter-storage.ts`
     - Inserts a chapter metadata row (title, slug, word count) into SQLite
6. **Prints a boxed report** with counts of scanned/imported/skipped/failed books, chapters added, covers copied, and DB size

### Import modes

```bash
# Incremental (default) — only imports new or changed books
npm run import
npx tsx scripts/import.ts

# Full re-import — clears all data and re-imports everything
npm run import:full
npx tsx scripts/import.ts --full

# Cron daemon — polls for new data on an interval
npm run import:cron
npx tsx scripts/import.ts --cron --interval 10   # every 10 minutes (default: 30)

# Target specific books
npx tsx scripts/import.ts --ids 100267 102205

# Dry run — reports what would be imported without making changes
npx tsx scripts/import.ts --dry-run

# Cleanup — deletes source .txt files from crawler/output after successful import
npx tsx scripts/import.ts --cleanup

# Quiet — suppresses progress bars (for scripts/CI)
npx tsx scripts/import.ts --quiet
```

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | `file:./data/binslib.db` | SQLite database path |
| `CRAWLER_OUTPUT_DIR` | `../crawler/output` | MTC crawler output directory |
| `TTV_CRAWLER_OUTPUT_DIR` | `../crawler-tangthuvien/output` | TTV crawler output directory |
| `META_PULLER_DIR` | `../meta-puller` | Path to meta-puller scripts |
| `CHAPTERS_DIR` | `./data/compressed` | Where compressed chapter files are stored |
| `ZSTD_DICT_PATH` | `./data/global.dict` | Optional zstd dictionary for compression |

---

## Export Process

Two export scripts move chapter body text from the database (or crawler files) to compressed files on disk. These were created as part of a storage migration to shrink the database from ~39 GB to < 1 GB.

### Export from DB (`scripts/export-chapters.ts`)

Reads chapter bodies from the `chapters.body` column in SQLite, writes them as zstd-compressed files, and optionally NULLs the DB body to reclaim space.

```bash
# Export all chapters, NULL DB body in batches of 1000
npx tsx scripts/export-chapters.ts

# Preview what would be exported
npx tsx scripts/export-chapters.ts --dry-run

# Write to disk but keep DB body intact
npx tsx scripts/export-chapters.ts --keep-db

# Custom batch size for NULLing DB rows
npx tsx scripts/export-chapters.ts --batch 5000
```

**How it works:**
1. Queries all chapters where `body IS NOT NULL`
2. For each chapter: skips if a `.zst` or `.gz` file already exists on disk, otherwise compresses with zstd and writes to `data/compressed/{book_id}/{index}.txt.zst`
3. In batches of N, runs `UPDATE chapters SET body = NULL` to free DB space
4. Prints a report with export counts, bytes written, and DB size before/after
5. Suggests running `VACUUM` afterward to reclaim freed space in the DB file

### Export from files (`scripts/export-from-files.ts`)

Reads `.txt` chapter files directly from crawler output directories (bypassing the database) and compresses them to disk using parallel worker threads.

```bash
# Export with auto-detected worker count (= CPU cores)
npx tsx scripts/export-from-files.ts

# Custom worker count
npx tsx scripts/export-from-files.ts --workers 6

# Preview
npx tsx scripts/export-from-files.ts --dry-run
```

**How it works:**
1. Scans both `crawler/output/` and `crawler-tangthuvien/output/` for book directories
2. Splits work across N worker threads (round-robin by book)
3. Each worker: reads chapter `.txt` files, extracts body (strips title line), compresses with zstd (using global dictionary if available), writes to `data/compressed/{book_id}/{index}.txt.zst`
4. Skips chapters that already have `.zst` or `.gz` files on disk (safe to re-run)
5. Reports compression ratio, throughput, and per-worker stats

---

## Chapter Storage Module

**File**: `src/lib/chapter-storage.ts`

The central read/write layer for chapter bodies on disk. All import and export scripts, plus the web reader, go through this module.

| Function | Description |
|---|---|
| `writeChapterBody(bookId, index, body)` | Compresses with zstd (level 3) and writes to `data/compressed/{bookId}/{index}.txt.zst` |
| `readChapterBody(bookId, index)` | Reads from disk — tries `.zst` first, falls back to `.gz` (migration compat). Returns `null` if no file exists |
| `resolveChapterBody(bookId, index, dbBody)` | Tries disk first, falls back to the DB body value. Enables the dual-read migration layer |
| `chapterFileExists(bookId, index)` | Returns `true` if either `.zst` or `.gz` file exists |

The compressor/decompressor instances are lazily initialized singletons. If `data/global.dict` exists, it is loaded as a shared zstd dictionary for better compression ratios on small chapters.

## Docker

```bash
docker compose up -d
```

The `docker-compose.yml` mounts crawler output directories, meta-puller, epub-converter, and the `data/` volume. The container runs the Next.js production server on port 8460.

## npm Scripts

| Script | Description |
|---|---|
| `npm run dev` | Start dev server (Turbopack) |
| `npm run build` | Production build |
| `npm run start` | Start production server |
| `npm run db:generate` | Generate Drizzle migrations |
| `npm run db:migrate` | Run migrations + create FTS tables |
| `npm run import` | Incremental import |
| `npm run import:full` | Full re-import (clears existing data) |
| `npm run import:cron` | Import daemon (polls every 30 min) |
