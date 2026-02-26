# Meta Puller

Pulls cover images for books in the MTC platform. Discovers books from binslib bundle files (not crawler/output).

> **Note**: `book-ingest/generate_plan.py` is the recommended replacement for this tool. It combines catalog discovery, per-book metadata enrichment, ID-range scanning, and cover downloading into a single file. `pull_metadata.py` is kept for backward compatibility but may be removed in a future cleanup.

## What It Does

Two independent operations that can be combined:

1. **`--meta-only`** — Paginates the API catalog (`GET /api/books`), cross-references with local bundle chapter counts, and writes a download plan to `book-ingest/data/books_plan_mtc.json`. This is a lightweight version of `generate_plan.py`'s default mode.

2. **`--cover-only`** — Downloads missing cover images from the API directly to `binslib/public/covers/{book_id}.jpg`. Discovers book IDs by scanning `binslib/data/compressed/*.bundle`.

Running without flags performs both operations.

## Data Sources

| Data | Source | Path |
|------|--------|------|
| Book discovery | BLIB bundle files | `binslib/data/compressed/*.bundle` |
| Cover images (output) | API poster URLs | `binslib/public/covers/{book_id}.jpg` |
| Plan file (output) | API catalog + bundle cross-ref | `book-ingest/data/books_plan_mtc.json` |

No dependency on `crawler/output/`. No dependency on external config files — API credentials are inlined.

## Usage

```bash
cd meta-puller

# Default: generate plan + pull covers
python3 pull_metadata.py

# Only update the download plan
python3 pull_metadata.py --meta-only

# Only pull missing covers
python3 pull_metadata.py --cover-only

# Specific book covers
python3 pull_metadata.py --cover-only --ids 132599 131197

# Re-download all covers
python3 pull_metadata.py --cover-only --force

# Preview
python3 pull_metadata.py --dry-run
```

## Recommended Alternative

For production use, prefer `book-ingest/generate_plan.py` which provides all of the above plus:

- `--refresh` — enrich the plan with full per-book metadata (author, genres, tags, synopsis, poster, stats) via async batch fetching (150 concurrent requests)
- `--scan` — probe the full MTC ID range (100003–153500+) to discover books invisible to the catalog listing endpoint
- `--fix-author` — generate synthetic authors from creators when the author field is missing or a placeholder

```bash
cd book-ingest
python3 generate_plan.py                                # catalog → plan + covers
python3 generate_plan.py --refresh --scan --fix-author  # full enrichment
python3 generate_plan.py --cover-only --ids 132599      # specific covers
```

## Dependencies

- `httpx` — HTTP client for API requests and cover downloads
- `rich` — progress bars, tables, and styled console output