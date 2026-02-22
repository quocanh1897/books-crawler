/**
 * Native Zstd Benchmark
 * 
 * Tests actual compression performance using @aspect/zstd bindings
 * (same as production code in chapter-storage.ts)
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync, gunzipSync } from "node:zlib";
import { compress, decompress } from "zstd-napi";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CRAWLER_OUTPUT = path.resolve(__dirname, "../../crawler/output");

interface BookResult {
  bookId: string;
  chapters: number;
  originalSize: number;
  gzip: { size: number; ratio: number; compressMs: number; decompressMs: number };
  zstd: { size: number; ratio: number; compressMs: number; decompressMs: number };
  zstdDict?: { size: number; ratio: number; compressMs: number; decompressMs: number };
}

function getChapterFiles(bookId: string): string[] {
  const bookDir = path.join(CRAWLER_OUTPUT, bookId);
  if (!fs.existsSync(bookDir)) return [];
  return fs.readdirSync(bookDir)
    .filter(f => /^\d{4}_.*\.txt$/.test(f))
    .map(f => path.join(bookDir, f))
    .slice(0, 200); // Limit to 200 chapters for quick test
}

function readChapterBody(filePath: string): string {
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const title = lines[0]?.trim() || "";
  let bodyStart = 1;
  while (bodyStart < lines.length && lines[bodyStart].trim() === "") bodyStart++;
  if (bodyStart < lines.length && lines[bodyStart].trim() === title) bodyStart++;
  return lines.slice(bodyStart).join("\n").trim();
}

async function benchmarkBook(bookId: string, dictBuffer?: Buffer): Promise<BookResult | null> {
  const files = getChapterFiles(bookId);
  if (files.length === 0) {
    console.log(`  Book ${bookId}: not found`);
    return null;
  }

  const bodies = files.map(f => Buffer.from(readChapterBody(f), "utf-8"));
  const totalOriginal = bodies.reduce((sum, b) => sum + b.length, 0);

  // Gzip benchmark
  let gzipSize = 0;
  const gzipStart = performance.now();
  const gzipCompressed = bodies.map(b => {
    const c = gzipSync(b, { level: 6 });
    gzipSize += c.length;
    return c;
  });
  const gzipCompressTime = performance.now() - gzipStart;

  const gzipDecompStart = performance.now();
  gzipCompressed.forEach(c => gunzipSync(c));
  const gzipDecompTime = performance.now() - gzipDecompStart;

  // Zstd benchmark (no dict)
  let zstdSize = 0;
  const zstdStart = performance.now();
  const zstdCompressed = bodies.map(b => {
    const c = compress(b, 3);
    zstdSize += c.length;
    return c;
  });
  const zstdCompressTime = performance.now() - zstdStart;

  const zstdDecompStart = performance.now();
  zstdCompressed.forEach(c => decompress(c));
  const zstdDecompTime = performance.now() - zstdDecompStart;

  const result: BookResult = {
    bookId,
    chapters: files.length,
    originalSize: totalOriginal,
    gzip: {
      size: gzipSize,
      ratio: totalOriginal / gzipSize,
      compressMs: gzipCompressTime,
      decompressMs: gzipDecompTime,
    },
    zstd: {
      size: zstdSize,
      ratio: totalOriginal / zstdSize,
      compressMs: zstdCompressTime,
      decompressMs: zstdDecompTime,
    },
  };

  // Zstd with dict (if provided)
  if (dictBuffer) {
    const { Compressor, Decompressor } = await import("zstd-napi");
    const compressor = new Compressor();
    compressor.loadDictionary(dictBuffer);
    const decompressor = new Decompressor();
    decompressor.loadDictionary(dictBuffer);

    let zstdDictSize = 0;
    const zstdDictStart = performance.now();
    const zstdDictCompressed = bodies.map(b => {
      const c = compressor.compress(b);
      zstdDictSize += c.length;
      return c;
    });
    const zstdDictCompressTime = performance.now() - zstdDictStart;

    const zstdDictDecompStart = performance.now();
    zstdDictCompressed.forEach(c => decompressor.decompress(c));
    const zstdDictDecompTime = performance.now() - zstdDictDecompStart;

    result.zstdDict = {
      size: zstdDictSize,
      ratio: totalOriginal / zstdDictSize,
      compressMs: zstdDictCompressTime,
      decompressMs: zstdDictDecompTime,
    };
  }

  return result;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

async function main() {
  console.log("\n=== Native Zstd Benchmark (@aspect/zstd) ===\n");

  // Load global dictionary if exists
  const dictPath = path.resolve(__dirname, "../../zstd-benchmark/results/global.dict");
  let dictBuffer: Buffer | undefined;
  if (fs.existsSync(dictPath)) {
    dictBuffer = fs.readFileSync(dictPath);
    console.log(`Global dictionary loaded (${formatSize(dictBuffer.length)})\n`);
  } else {
    console.log("No global dictionary found\n");
  }

  // Test books from selected-books.json
  const selectedPath = path.resolve(__dirname, "../../zstd-benchmark/results/selected-books.json");
  let bookIds: string[] = [];
  
  if (fs.existsSync(selectedPath)) {
    const selected = JSON.parse(fs.readFileSync(selectedPath, "utf-8"));
    bookIds = Object.values(selected.books).map((b: any) => b.bookId);
  } else {
    // Fallback: find some books in crawler/output
    const dirs = fs.readdirSync(CRAWLER_OUTPUT).filter(d => /^\d+$/.test(d)).slice(0, 5);
    bookIds = dirs;
  }

  console.log("Testing books:", bookIds.join(", "), "\n");

  const results: BookResult[] = [];

  for (const bookId of bookIds) {
    console.log(`Benchmarking book ${bookId}...`);
    const result = await benchmarkBook(bookId, dictBuffer);
    if (result) {
      results.push(result);
      console.log(`  ${result.chapters} chapters, ${formatSize(result.originalSize)} original`);
      console.log(`  Gzip:      ${result.gzip.ratio.toFixed(2)}x, compress ${formatMs(result.gzip.compressMs)}, decompress ${formatMs(result.gzip.decompressMs)}`);
      console.log(`  Zstd:      ${result.zstd.ratio.toFixed(2)}x, compress ${formatMs(result.zstd.compressMs)}, decompress ${formatMs(result.zstd.decompressMs)}`);
      if (result.zstdDict) {
        console.log(`  Zstd+Dict: ${result.zstdDict.ratio.toFixed(2)}x, compress ${formatMs(result.zstdDict.compressMs)}, decompress ${formatMs(result.zstdDict.decompressMs)}`);
      }
      console.log();
    }
  }

  // Summary
  if (results.length > 0) {
    console.log("=== Summary ===\n");
    console.log("| Book | Chapters | Original | Gzip | Zstd | Zstd+Dict | Gzip Time | Zstd Time |");
    console.log("|------|----------|----------|------|------|-----------|-----------|-----------|");
    
    for (const r of results) {
      const gzipTime = r.gzip.compressMs + r.gzip.decompressMs;
      const zstdTime = r.zstd.compressMs + r.zstd.decompressMs;
      const dictRatio = r.zstdDict ? `${r.zstdDict.ratio.toFixed(2)}x` : "-";
      console.log(`| ${r.bookId} | ${r.chapters} | ${formatSize(r.originalSize)} | ${r.gzip.ratio.toFixed(2)}x | ${r.zstd.ratio.toFixed(2)}x | ${dictRatio} | ${formatMs(gzipTime)} | ${formatMs(zstdTime)} |`);
    }

    // Averages
    const avgGzipRatio = results.reduce((s, r) => s + r.gzip.ratio, 0) / results.length;
    const avgZstdRatio = results.reduce((s, r) => s + r.zstd.ratio, 0) / results.length;
    const avgDictRatio = results.filter(r => r.zstdDict).reduce((s, r) => s + r.zstdDict!.ratio, 0) / results.filter(r => r.zstdDict).length || 0;
    
    const totalGzipTime = results.reduce((s, r) => s + r.gzip.compressMs + r.gzip.decompressMs, 0);
    const totalZstdTime = results.reduce((s, r) => s + r.zstd.compressMs + r.zstd.decompressMs, 0);

    console.log("\n### Averages");
    console.log(`- Gzip ratio: ${avgGzipRatio.toFixed(2)}x`);
    console.log(`- Zstd ratio: ${avgZstdRatio.toFixed(2)}x`);
    if (avgDictRatio > 0) console.log(`- Zstd+Dict ratio: ${avgDictRatio.toFixed(2)}x`);
    console.log(`- Zstd is ${(totalGzipTime / totalZstdTime).toFixed(1)}x faster than Gzip (total time)`);
  }
}

main().catch(console.error);
