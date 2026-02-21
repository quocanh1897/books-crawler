# epub-converter

Converts books from `crawler/output/` into EPUB 3.0 files, ready for e-readers.

## How it works

1. **Discovery** — scans `crawler/output/` for book directories containing chapter `.txt` files
2. **Metadata** — reads `metadata.json` for title, author, genres. If missing, auto-invokes `meta-puller` to fetch it from the API
3. **Cover** — embeds `cover.jpg` as the EPUB cover page (validated with Pillow)
4. **Chapters** — parses `{INDEX}_{slug}.txt` files, sorted numerically. First line = chapter title, rest = body paragraphs converted to XHTML
5. **Styling** — applies a clean CSS stylesheet with Vietnamese serif fonts, proper line-height, and indented paragraphs
6. **Output** — writes `{BookName}.epub` into `epub-converter/epub-output/{book_id}/`, along with copies of all non-txt source files (metadata.json, cover.jpg, book.json)
7. **Audit** — appends/updates an `## EPUB Conversion` section in `crawler/AUDIT.md`

## Output Structure

```
epub-converter/
└── epub-output/
    ├── 128390/
    │   ├── Để Ngươi Thổ Lộ, Ngươi Tìm Tới Hắc Đạo Thiên Kim.epub
    │   ├── metadata.json    ← copied from crawler/output/128390/
    │   ├── book.json        ← copied
    │   └── cover.jpg        ← copied
    ├── 100358/
    │   ├── Vô Thượng Sát Thần.epub
    │   ├── metadata.json
    │   ├── book.json
    │   └── cover.jpg
    └── ...
```

## Usage (Docker Compose)

```bash
cd epub-converter

# Convert all eligible books
docker compose run --rm epub-converter

# Convert specific books
docker compose run --rm epub-converter --ids 100358 128390

# List all books with their status
docker compose run --rm epub-converter --list

# Preview what would be converted
docker compose run --rm epub-converter --dry-run

# Force reconvert (overwrite existing .epub files)
docker compose run --rm epub-converter --force

# Skip AUDIT.md update
docker compose run --rm epub-converter --no-audit
```

## Usage (local Python, no Docker)

```bash
cd epub-converter
pip install -r requirements.txt
python3 convert.py --list
python3 convert.py --ids 100358
```

## Files

| File                | Purpose                                       |
| ------------------- | --------------------------------------------- |
| `convert.py`        | CLI entry point, book discovery, progress bars |
| `epub_builder.py`   | Core EPUB creation (ebooklib + Pillow)         |
| `Dockerfile`        | Python 3.12-slim image with dependencies       |
| `docker-compose.yml`| Service definition with volume mounts          |
| `requirements.txt`  | Python dependencies                            |
| `CONTEXT.md`        | This documentation file                        |

## Dependencies

| Package   | Version   | Purpose                                           |
| --------- | --------- | ------------------------------------------------- |
| ebooklib  | >= 0.18   | EPUB 3.0 creation                                 |
| rich      | >= 13.0   | Terminal progress bars and styled output           |
| Pillow    | >= 10.0   | Cover image validation                             |
| httpx     | >= 0.27.0 | Required by meta-puller when auto-fetching metadata |

## Volume Mounts (Docker)

| Host path        | Container path      | Purpose                                    |
| ---------------- | ------------------- | ------------------------------------------ |
| `../crawler`     | `/data/crawler`     | output/, config.py, AUDIT.md               |
| `../meta-puller` | `/data/meta-puller` | Auto-fetch missing metadata via the API    |
| `./`             | `/data/epub-output` | EPUB output: epub-output/{book_id}/ dirs   |

## CLI Flags

| Flag                | Description                                              |
| ------------------- | -------------------------------------------------------- |
| `--ids N...`        | Convert specific book IDs only (default: all)            |
| `--status STATUS`   | Filter by book status: `ongoing`, `completed`, `paused`  |
| `--list`            | List eligible books with status/meta/cover/epub info     |
| `--dry-run`         | Show what would be converted without doing it             |
| `--force`           | Reconvert even if .epub already exists                    |
| `--no-audit`        | Skip updating the EPUB Conversion section in AUDIT.md    |

## EPUB Structure

Each generated EPUB contains:
- Cover page with `cover.jpg` (if available)
- All chapters in order, with clean XHTML formatting
- Table of contents with chapter titles
- Vietnamese language metadata (`lang: vi`)
- Author and genre metadata from the API

## AUDIT.md Integration

After conversion, an `## EPUB Conversion` section is appended to (or updated in) `crawler/AUDIT.md` with:
- Summary table: Done / Failed / Skipped counts
- **Converted** sub-table: ID, chapter count, EPUB filename, book name
- **Failed** sub-table: ID, error message, book name
