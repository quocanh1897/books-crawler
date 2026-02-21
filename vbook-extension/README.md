# vBook Extension — Binslib

A vbook extension for reading novels from [lib.binscode.site](https://lib.binscode.site), a self-hosted Vietnamese web novel library.

## Features

- **Home/Discovery**: Browse books by views, bookmarks, comments, review score, recently updated, and completed
- **Genre Browsing**: Filter books by genre with book counts
- **Search**: Full-text search across the library (FTS5-powered)
- **Book Detail**: Cover, author, synopsis, status, genres, word/chapter counts
- **Chapter List**: Full table of contents
- **Chapter Reader**: Formatted chapter content

## Extension Structure

```
vbook-extension/
├── plugin.json              # Extension metadata and script mappings
└── src/
    ├── config.js            # BASE_URL and API_URL constants
    ├── home.js              # Discovery tabs (rankings by different metrics)
    ├── homecontent.js       # Fetches ranked books for each tab
    ├── genre.js             # Lists all genres with book counts
    ├── genrecontent.js      # Fetches books filtered by genre
    ├── detail.js            # Book detail (metadata, author, genres)
    ├── search.js            # Full-text book search
    ├── toc.js               # Chapter list for a book
    └── chap.js              # Chapter content (formatted as HTML)
```

## How It Works

The extension is entirely API-driven — no HTML scraping. It communicates with the binslib backend through these JSON APIs:

| Script            | API Endpoint                                 | Purpose                |
| ----------------- | -------------------------------------------- | ---------------------- |
| `homecontent.js`  | `GET /api/rankings?metric=...`               | Ranked book lists      |
| `genre.js`        | `GET /api/genres`                            | Genre list with counts |
| `genrecontent.js` | `GET /api/rankings?genre=...`                | Books by genre         |
| `detail.js`       | `GET /api/books/by-slug/{slug}`              | Book metadata          |
| `search.js`       | `GET /api/search?scope=books&q=...`          | Full-text search       |
| `toc.js`          | `GET /api/books/by-slug/{slug}/chapters`     | Chapter titles         |
| `chap.js`         | `GET /api/books/by-slug/{slug}/chapters/{n}` | Chapter body           |

The slug-based API endpoints (`/api/books/by-slug/...`) were added to binslib specifically for this extension, since the chapter pages render client-side and can't be reliably scraped.

## Installation

1. Copy the `vbook-extension/` folder into the vBook extensions directory
2. Ensure `lib.binscode.site` is accessible from the device

## Configuration

Edit `src/config.js` to point to a different binslib instance:

```javascript
var BASE_URL = "https://lib.binscode.site";
var API_URL = BASE_URL + "/api";
```

## Required Backend APIs

This extension requires the binslib backend (`binslib/`) to have the following API routes deployed:

- `GET /api/rankings` — existing
- `GET /api/genres` — existing
- `GET /api/search` — existing
- `GET /api/books/by-slug/[slug]` — added for this extension
- `GET /api/books/by-slug/[slug]/chapters` — added for this extension
- `GET /api/books/by-slug/[slug]/chapters/[indexNum]` — added for this extension

## URL Pattern

The extension matches book URLs of the form:

```
lib.binscode.site/doc-truyen/{book-slug}
```

Chapter URLs follow the pattern:

```
lib.binscode.site/doc-truyen/{book-slug}/chuong-{N}
```
