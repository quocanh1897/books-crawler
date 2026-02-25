# book-ingest

Unified crawl-decrypt-compress-import pipeline for metruyencv (MTC).

Replaces the 3-step pipeline (crawl → pre-compress → import) with a single tool that goes **API → decrypt → compress → bundle + DB** directly, with zero intermediate `.txt` files.

## Quick Start

```bash
pip install -r requirements.txt

# Ingest specific books
python3 ingest.py 100358 100441

# Ingest from plan file with 5 workers
python3 ingest.py -w 5

# Custom plan file
python3 ingest.py --plan path/to/plan.json

# Audit mode — report gaps without downloading
python3 ingest.py --audit-only

# Dry run
python3 ingest.py --dry-run
```

## Usage

```
python3 ingest.py [BOOK_IDS...] [OPTIONS]

Options:
  -w, --workers N       Parallel workers (default: 5)
  --plan PATH           Custom plan JSON file
  --flush-every N       Checkpoint interval in chapters (default: 100)
  --audit-only          Report missing data without downloading
  --dry-run             Simulate without writing
  --offset N            Skip first N entries in plan
  --limit N             Limit to N entries (0 = all)
```

## Architecture

```
API (metruyencv.com)
    │
    ▼
book-ingest (Python, async)
    ├─ fetch book metadata
    ├─ check existing: bundle indices + DB
    ├─ walk chapter linked list:
    │   ├─ fetch → decrypt AES-128-CBC
    │   ├─ compress body with zstd (global.dict)
    │   ├─ buffer in memory
    │   └─ every N chapters: flush bundle + commit DB
    ├─ pull cover image
    └─ update book metadata in DB
```

## File Paths

| Resource | Path |
|---|---|
| Bundle files | `binslib/data/compressed/{book_id}.bundle` |
| SQLite DB | `binslib/data/binslib.db` |
| Zstd dictionary | `binslib/data/global.dict` |
| Cover images | `binslib/public/covers/{book_id}.jpg` |
| Detail log | `book-ingest/data/ingest-detail.log` |
| Summary log | `book-ingest/data/ingest-log.txt` |

## Dependencies

- `httpx` — async HTTP client
- `pycryptodome` — AES-128-CBC decryption
- `pyzstd` — zstd compression with dictionary
- `rich` — progress bars and console output
