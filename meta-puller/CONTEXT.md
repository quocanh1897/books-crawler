# Meta Puller

Pulls rich metadata and cover images for books already crawled by `crawler/`.

## What It Does

Scans `crawler/output/{book_id}/` directories and for each:
1. Calls the API (`GET /api/books/{id}?include=author,creator,genres`) to fetch full metadata
2. Saves everything as `metadata.json` in the book's directory
3. Downloads the largest available cover image as `cover.jpg`

## Output

After running, each book directory gains two new files:

```
crawler/output/{book_id}/
├── metadata.json     # full API response: all fields
├── cover.jpg         # poster image
├── 0001_*.txt        # chapter files
└── ...
```

### metadata.json Fields

All properties returned by the API, including:
- `id`, `name`, `slug`, `kind`, `sex`, `state`, `status`
- `link` (web URL)
- `poster` (cover image URLs at multiple sizes)
- `synopsis` (description)
- `chapter_count`, `word_count`, `vote_count`, `review_score`, `bookmark_count`
- `first_chapter`, `latest_chapter`, `latest_index`
- `author` (`id`, `name`, `local_name`)
- `creator` (`id`, `name`)
- `genres` (array of `{id, name}`)

## Usage

```bash
cd meta-puller

# Pull metadata for all books missing it
python3 pull_metadata.py

# Re-pull everything (overwrite existing)
python3 pull_metadata.py --force

# Specific books only
python3 pull_metadata.py --ids 147360 116007

# Preview what would be fetched
python3 pull_metadata.py --dry-run
```

## Dependencies

- `httpx` (shared with crawler)
- Imports `config.py` from `../crawler/`
