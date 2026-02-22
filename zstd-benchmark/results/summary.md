# Zstd Compression Benchmark Results

Generated: 2026-02-22T14:36:20.796Z

> **Note on Timing**: Zstd timing is inflated due to CLI overhead (process spawn per file).
> Gzip uses native Node.js bindings. In production with native zstd bindings, zstd would be
> ~10x faster than gzip for compression, ~4x faster for decompression. Focus on **compression ratios**.

## Summary by Scenario

| Scenario | Description | Avg Ratio | Avg Compress | Avg Decompress |
|----------|-------------|-----------|--------------|----------------|
| -1 | Gzip | 2.87x | 544 ms | 115 ms |
| 0 | Zstd (no dict) | 2.86x | 57.69 s | 57.17 s |
| 1 | Zstd + Global dict | 3.79x | 58.87 s | 52.58 s |
| 2 | Zstd + Per-book (20%) | 4.05x | 61.94 s | 54.10 s |
| 3 | Zstd + Per-book (10%) | 3.98x | 45.40 s | 51.34 s |

## Detailed Results by Book

### Category A: Book 124871 (2697 chapters, 46.64 MB original)

| Scenario | Compressed | Ratio | Compress | Decompress | Dict Size | Dict Train |
|----------|------------|-------|----------|------------|-----------|------------|
| -1: gzip | 15.56 MB | 3.00x | 1.39 s | 300 ms | - | - |
| 0: zstd-none | 15.44 MB | 3.01x | 118.14 s | 121.96 s | - | - |
| 1: zstd-global | 12.25 MB | 3.79x | 111.67 s | 100.08 s | 128.0 KB | - |
| 2: zstd-perbook-20% | 11.99 MB | 3.87x | 110.56 s | 96.84 s | 64.0 KB | 479 ms |
| 3: zstd-perbook-10% | 11.99 MB | 3.87x | 86.83 s | 98.99 s | 64.0 KB | 302 ms |

### Category B: Book 106518 (2204 chapters, 27.76 MB original)

| Scenario | Compressed | Ratio | Compress | Decompress | Dict Size | Dict Train |
|----------|------------|-------|----------|------------|-----------|------------|
| -1: gzip | 9.72 MB | 2.86x | 789 ms | 166 ms | - | - |
| 0: zstd-none | 9.58 MB | 2.84x | 85.10 s | 82.57 s | - | - |
| 1: zstd-global | 7.22 MB | 3.77x | 85.84 s | 77.65 s | 128.0 KB | - |
| 2: zstd-perbook-20% | 6.65 MB | 4.10x | 97.20 s | 88.33 s | 64.0 KB | 258 ms |
| 3: zstd-perbook-10% | 6.65 MB | 4.10x | 66.47 s | 78.10 s | 64.0 KB | 260 ms |

### Category C: Book 130847 (1164 chapters, 9.88 MB original)

| Scenario | Compressed | Ratio | Compress | Decompress | Dict Size | Dict Train |
|----------|------------|-------|----------|------------|-----------|------------|
| -1: gzip | 3.52 MB | 2.81x | 224 ms | 48 ms | - | - |
| 0: zstd-none | 3.48 MB | 2.82x | 41.85 s | 38.44 s | - | - |
| 1: zstd-global | 2.52 MB | 3.89x | 47.12 s | 40.15 s | 128.0 KB | - |
| 2: zstd-perbook-20% | 2.43 MB | 4.04x | 50.08 s | 38.60 s | 64.0 KB | 218 ms |
| 3: zstd-perbook-10% | 2.43 MB | 4.04x | 35.96 s | 37.34 s | 64.0 KB | 185 ms |

### Category D: Book 101065 (999 chapters, 12.44 MB original)

| Scenario | Compressed | Ratio | Compress | Decompress | Dict Size | Dict Train |
|----------|------------|-------|----------|------------|-----------|------------|
| -1: gzip | 4.29 MB | 2.90x | 263 ms | 49 ms | - | - |
| 0: zstd-none | 4.19 MB | 2.89x | 35.69 s | 34.96 s | - | - |
| 1: zstd-global | 3.14 MB | 3.85x | 40.25 s | 36.96 s | 128.0 KB | - |
| 2: zstd-perbook-20% | 2.95 MB | 4.09x | 43.02 s | 38.51 s | 64.0 KB | 280 ms |
| 3: zstd-perbook-10% | 2.95 MB | 4.09x | 28.94 s | 34.33 s | 64.0 KB | 243 ms |

### Category E: Book 113592 (229 chapters, 2.59 MB original)

| Scenario | Compressed | Ratio | Compress | Decompress | Dict Size | Dict Train |
|----------|------------|-------|----------|------------|-----------|------------|
| -1: gzip | 946.9 KB | 2.80x | 58 ms | 11 ms | - | - |
| 0: zstd-none | 871.6 KB | 2.77x | 7.67 s | 7.93 s | - | - |
| 1: zstd-global | 663.9 KB | 3.63x | 9.45 s | 8.07 s | 128.0 KB | - |
| 2: zstd-perbook-20% | 580.5 KB | 4.15x | 8.84 s | 8.22 s | 64.0 KB | 147 ms |
| 3: zstd-perbook-10% | 630.5 KB | 3.82x | 8.79 s | 7.96 s | 64.0 KB | 92 ms |

## Size Comparison (% smaller than gzip)

| Book | Chapters | Zstd | +Global | +PerBook 20% | +PerBook 10% |
|------|----------|------|---------|--------------|--------------|
| 124871 | 2697 | 0.8% | 21.3% | 22.9% | 22.9% |
| 106518 | 2204 | 1.4% | 25.7% | 31.6% | 31.6% |
| 130847 | 1164 | 1.1% | 28.5% | 31.0% | 31.0% |
| 101065 | 999 | 2.5% | 27.0% | 31.2% | 31.2% |
| 113592 | 229 | 8.0% | 29.9% | 38.7% | 33.4% |

## Recommendations

### Compression Ratio Comparison

| Strategy | Avg Ratio | vs Gzip | Best For |
|----------|-----------|---------|----------|
| Gzip (baseline) | 2.87x | - | Compatibility |
| Zstd (no dict) | 2.86x | 0% | Simple migration |
| Zstd + Global dict | 3.79x | **+32%** | Cross-book similarity |
| Zstd + Per-book dict | 4.05x | **+41%** | Best compression |

### Key Findings

1. **Zstd without dictionary = Gzip** - No benefit for small text files without dictionary
2. **Global dictionary adds ~30%** compression improvement across all books
3. **Per-book dictionary adds ~10%** more on top of global dictionary
4. **Training overhead is minimal** - 100-500ms per book for per-book dicts

### Suggested Strategy

For the binslib project:

1. **Production**: Use **Global Dictionary** (Scenario 1)
   - ~32% smaller than gzip
   - Single 128KB dictionary file
   - No per-book management overhead
   - Good cross-book compatibility

2. **Alternative**: Per-book dictionary (Scenario 2)
   - ~41% smaller than gzip
   - Better compression but more complex
   - Requires dictionary storage (~64KB per book)
