# epub-converter

Converts books from BLIB bundle files into EPUB 3.0 format, ready for e-readers.

## How it works

1. **Discovery** — scans `binslib/data/compressed/` for `.bundle` files
2. **Metadata** — reads book name, author, genres, and status from `binslib/data/binslib.db` (SQLite)
3. **Chapter reading** — decompresses chapter bodies from the bundle using zstd (with the shared `global.dict` dictionary). For v2 bundles, chapter titles are read from inline metadata blocks; for v1 or missing titles, the first line of the chapter body is used.
4. **Cover** — reads `binslib/public/covers/{book_id}.jpg` if available
5. **EPUB generation** — builds a valid EPUB 3.0 file using `ebooklib` with proper TOC, navigation, CSS styling, and cover page
6. **Caching** — saves the result to `binslib/data/epub/{book_id}_{chapter_count}.epub`. The chapter count is embedded in the filename so that stale caches are automatically detected when new chapters are ingested.

## Cache Strategy

The filename `{book_id}_{chapter_count}.epub` acts as the cache key:

- **Cache hit**: If the file exists and the chapter count matches the bundle, the book is skipped.
- **Cache miss**: If no cached file exists, or the bundle has more chapters than the cached version, the EPUB is regenerated.
- **Cleanup**: After a successful conversion, any older cached files for the same book (with a different chapter count) are deleted.
- **Force**: `--force` ignores the cache and regenerates unconditionally.

## Data Sources

| Data | Source | Path |
|------|--------|------|
| Chapter bodies | BLIB bundle (zstd compressed) | `binslib/data/compressed/{book_id}.bundle` |
| Zstd dictionary | Global dictionary | `binslib/data/global.dict` |
| Book metadata | SQLite database | `binslib/data/binslib.db` |
| Cover images | JPEG files | `binslib/public/covers/{book_id}.jpg` |
| EPUB output | Cached EPUB files | `binslib/data/epub/{book_id}_{chapter_count}.epub` |

## Output

```
binslib/data/epub/
├── 100358_2500.epub
├── 128390_1200.epub
└── ...
```

Flat directory — one file per book, no subdirectories. The binslib Next.js API serves these files directly via `GET /api/books/{id}/epub`.

## Dependencies

- `ebooklib` — EPUB 3.0 generation
- `pyzstd` — zstd decompression (with dictionary support)
- `rich` — CLI progress bars and formatting
- `Pillow` — cover image validation

## CLI Usage

```bash
# Convert all books with bundles
python3 convert.py

# Specific books
python3 convert.py --ids 100358 128390

# Only completed books
python3 convert.py --status completed

# List all books with conversion status
python3 convert.py --list

# Preview what would be converted
python3 convert.py --dry-run

# Force reconversion (ignore cache)
python3 convert.py --force
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `COMPRESSED_DIR` | `../binslib/data/compressed` | Bundle files directory |
| `DATABASE_PATH` | `../binslib/data/binslib.db` | SQLite database path |
| `COVERS_DIR` | `../binslib/public/covers` | Cover images directory |
| `EPUB_CACHE_DIR` | `../binslib/data/epub` | EPUB output/cache directory |
| `ZSTD_DICT_PATH` | `../binslib/data/global.dict` | Zstd dictionary path |

## Integration with binslib

The Next.js web reader triggers EPUB generation on demand via three API routes:

- `POST /api/books/{id}/download` — triggers conversion if not cached (or stale), returns `{ status: "ready", url }` when done
- `GET /api/books/{id}/download-status` — checks if a cached EPUB exists and whether it needs regeneration (compares cached chapter count vs DB chapter count)
- `GET /api/books/{id}/epub` — serves the cached EPUB file as a download

The download route calls `python3 convert.py --ids {book_id} --force` via `execSync` when generation is needed.