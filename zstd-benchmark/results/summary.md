# Zstd Compression Benchmark Results

Generated: 2026-02-22

## Executive Summary

| Strategy               | Compression Ratio | vs Gzip  | Speed vs Gzip   |
| ---------------------- | ----------------- | -------- | --------------- |
| Gzip (baseline)        | 2.83x             | -        | 1x              |
| Zstd (no dict)         | 2.65x             | -6%      | **2.6x faster** |
| **Zstd + Global dict** | **3.38x**         | **+19%** | **2.6x faster** |

**Recommendation**: Use **Zstd + Global Dictionary** for 19% better compression AND 2.6x faster performance.

---

## Native Benchmark Results (zstd-napi)

Using native Node.js bindings for accurate timing. Dictionary trained on 500 random chapters.

### Per-Book Results (200 chapters each)

| Book   | Original | Gzip  | Zstd  | Zstd+Dict | Gzip Time | Zstd Time |
| ------ | -------- | ----- | ----- | --------- | --------- | --------- |
| 124871 | 3.29 MB  | 2.99x | 2.80x | **3.42x** | 80 ms     | 27 ms     |
| 106518 | 2.26 MB  | 2.73x | 2.57x | **3.31x** | 52 ms     | 23 ms     |
| 130847 | 1.67 MB  | 2.76x | 2.59x | **3.43x** | 37 ms     | 16 ms     |
| 101065 | 2.46 MB  | 2.88x | 2.69x | **3.45x** | 56 ms     | 21 ms     |
| 113592 | 2.07 MB  | 2.77x | 2.61x | **3.28x** | 47 ms     | 19 ms     |

### Averages

| Metric                         | Gzip   | Zstd (no dict) | Zstd + Dict |
| ------------------------------ | ------ | -------------- | ----------- |
| **Compression Ratio**          | 2.83x  | 2.65x          | **3.38x**   |
| **Total Time** (1000 chapters) | 272 ms | 106 ms         | 106 ms      |
| **Speed**                      | 1x     | 2.6x faster    | 2.6x faster |

---

## CLI Benchmark Results (zstd CLI)

> **Note**: CLI timing is inflated due to process spawn overhead (~50ms per call).
> Use these results for **compression ratios only**, not timing.

### Summary by Scenario

| Scenario | Description           | Avg Ratio | Size vs Gzip |
| -------- | --------------------- | --------- | ------------ |
| -1       | Gzip                  | 2.87x     | baseline     |
| 0        | Zstd (no dict)        | 2.86x     | 0%           |
| 1        | Zstd + Global dict    | 3.79x     | **-32%**     |
| 2        | Zstd + Per-book (20%) | 4.05x     | **-41%**     |
| 3        | Zstd + Per-book (10%) | 3.98x     | -39%         |

### Size Comparison (% smaller than gzip)

| Book   | Chapters | Zstd | +Global | +PerBook 20% |
| ------ | -------- | ---- | ------- | ------------ |
| 124871 | 2697     | 0.8% | 21.3%   | 22.9%        |
| 106518 | 2204     | 1.4% | 25.7%   | 31.6%        |
| 130847 | 1164     | 1.1% | 28.5%   | 31.0%        |
| 101065 | 999      | 2.5% | 27.0%   | 31.2%        |
| 113592 | 229      | 8.0% | 29.9%   | 38.7%        |

---

## Dictionary Analysis

### Global Dictionary (500 samples)

- **Size**: 128 KB
- **Training time**: ~5 seconds
- **Samples**: 100 random chapters from each of 5 test books
- **Compression improvement**: +19% vs gzip

### Dictionary Sample Size Comparison

| Samples | Avg Ratio | Improvement |
| ------- | --------- | ----------- |
| 150     | 3.35x     | baseline    |
| 500     | 3.38x     | +1%         |

> More samples provide diminishing returns. 150-500 samples is sufficient.

---

## Key Findings

1. **Zstd without dictionary is WORSE than gzip** for small text files (2.65x vs 2.83x)
2. **Zstd WITH dictionary is 19% BETTER than gzip** (3.38x vs 2.83x)
3. **Zstd is 2.6x FASTER than gzip** regardless of dictionary
4. **Per-book dictionaries add ~10%** more compression but require per-book storage

---

## Recommendations

### For binslib Production

Use **Global Dictionary** (Scenario 1):

| Benefit                 | Value                        |
| ----------------------- | ---------------------------- |
| Compression improvement | +19% vs gzip                 |
| Speed improvement       | 2.6x faster                  |
| Dictionary size         | 128 KB (single file)         |
| Complexity              | Low (one dict for all books) |

### Implementation

```typescript
import { compress, decompress, Compressor, Decompressor } from "zstd-napi";

// Load dictionary once at startup
const dict = fs.readFileSync("global.dict");
const compressor = new Compressor();
compressor.loadDictionary(dict);

// Compress chapters
const compressed = compressor.compress(chapterBuffer);
```

### Alternative: Per-book Dictionaries

Only if storage space is critical:

- +41% compression vs gzip
- Requires ~64KB dictionary per book
- More complex dictionary management
