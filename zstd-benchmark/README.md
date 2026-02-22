# Zstd Compression Benchmark

Benchmarks different zstd compression strategies for Vietnamese novel chapters.

## Scenarios

| Scenario | Description |
|----------|-------------|
| **-1** | Gzip level 6 (baseline) |
| **0** | Pure zstd level 9, no dictionary |
| **1** | Global dictionary (500 random chapters from 500 different books with >1000 chapters) |
| **2** | Per-book dictionary (20% of chapters, max 500 for training) |
| **3** | Per-book dictionary (10% of chapters, max 100 for training) |

## Test Books

Each scenario tests 5 books of different sizes:
- Book A: >3000 chapters
- Book B: 2000-3000 chapters
- Book C: 1000-2000 chapters
- Book D: 500-1000 chapters
- Book E: 100-500 chapters

## Usage

```bash
# Install dependencies
npm install

# Step 1: Select books (reads from fresh_books_download.json)
npx tsx select-books.ts

# Step 2: Pull books from server
npx tsx pull-books.ts              # Pull all (test + dict books)
npx tsx pull-books.ts --test-only  # Pull only 5 test books
npx tsx pull-books.ts --dict-only  # Pull only dict training books
npx tsx pull-books.ts --dry-run    # Show what would be pulled

# Step 3: Train global dictionary
npx tsx select-books.ts --train

# Step 4: Run benchmark
npx tsx benchmark.ts

# Step 5: View results
cat results/summary.md
```

### npm scripts

```bash
npm run select      # Step 1
npm run pull        # Step 2 (all books)
npm run pull:test   # Step 2 (test books only)
npm run pull:dict   # Step 2 (dict books only)
npm run train       # Step 3
npm run bench       # Step 4
npm run all         # Run all steps sequentially
```

## Server Setup

Books are pulled from:
- Server: `alex@192.168.1.22`
- Path: `/data/mtc/crawler/output`

The pull script is smart about bandwidth:
- **Test books**: Full content (5 books)
- **Dict training books**: Only 1 chapter each (500 books × 1 file)

## Output

```
results/
├── selected-books.json      # The 5 test books
├── global-dict-books.json   # 500 books for global dict training
├── global.dict              # Global dictionary (after training)
├── raw-results.json         # All measurements
└── summary.md               # Human-readable comparison report
```

## Requirements

- Node.js 18+
- `zstd` CLI for dictionary training
  - Windows: `winget install Facebook.zstd`
  - macOS: `brew install zstd`
  - Linux: `apt install zstd`
- SSH access to server (for pulling books)
