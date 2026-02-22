# Zstd Compression Benchmark

Benchmarks different zstd compression strategies for Vietnamese novel chapters.

## Results Summary

| Strategy | Avg Ratio | vs Gzip | Notes |
|----------|-----------|---------|-------|
| Gzip | 2.87x | - | Baseline |
| Zstd (no dict) | 2.86x | 0% | No benefit for small files |
| **Zstd + Global dict** | **3.79x** | **+32%** | Recommended |
| Zstd + Per-book dict | 4.05x | +41% | Best compression |

**Recommendation**: Use **Global Dictionary** for ~30% size reduction with minimal complexity.

See `results/summary.md` for full analysis.

## Scenarios

| Scenario | Description |
|----------|-------------|
| **-1** | Gzip level 6 (baseline) |
| **0** | Pure zstd level 9, no dictionary |
| **1** | Global dictionary (150 chapters from test books) |
| **2** | Per-book dictionary (20% of chapters, max 100 for training) |
| **3** | Per-book dictionary (10% of chapters, max 100 for training) |

## Test Books

Each scenario tests 5 books of different sizes:
- Book A: >2500 chapters
- Book B: 2000-2500 chapters
- Book C: 1000-2000 chapters
- Book D: 500-1000 chapters
- Book E: <500 chapters

## Quick Start

```bash
npm install
npx tsx train-global-dict.ts   # Train global dictionary
npx tsx benchmark.ts           # Run benchmark
```

## Full Usage

```bash
# Install dependencies
npm install

# Step 1: Select books (reads from fresh_books_download.json)
npx tsx select-books.ts

# Step 2: Pull books from server (if not local)
npx tsx pull-books.ts --test-only

# Step 3: Train global dictionary
npx tsx train-global-dict.ts

# Step 4: Run benchmark
npx tsx benchmark.ts

# Step 5: View results
cat results/summary.md
```

## Server Setup

Books are pulled from:
- Server: `alex@192.168.1.22`
- Path: `/data/mtc/crawler/output`

## Output

```
results/
├── selected-books.json      # The 5 test books
├── global.dict              # Global dictionary (128 KB)
├── raw-results.json         # All measurements
└── summary.md               # Human-readable comparison report
```

## Requirements

- Node.js 18+
- `zstd` CLI for dictionary training
  - Windows: `winget install Meta.Zstandard`
  - macOS: `brew install zstd`
  - Linux: `apt install zstd`
- SSH access to server (for pulling books)

## Notes

- Benchmark uses CLI-based zstd (slower than native bindings)
- Timing data is dominated by process spawn overhead
- Compression ratios are accurate and meaningful
- For production, use native bindings (`@aspect/zstd`) for ~10x faster performance
