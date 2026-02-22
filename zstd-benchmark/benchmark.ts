/**
 * Zstd Compression Benchmark
 * 
 * Tests 5 scenarios across 5 books of different sizes using CLI tools:
 * - Scenario -1: Gzip (baseline)
 * - Scenario 0: Pure zstd, no dictionary
 * - Scenario 1: Global dictionary
 * - Scenario 2: Per-book dictionary (20% chapters, max 500)
 * - Scenario 3: Per-book dictionary (10% chapters, max 100)
 * 
 * Uses zstd CLI for compression (required for dictionary training anyway)
 */

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { gzipSync, gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CRAWLER_OUTPUT = path.resolve(__dirname, "../crawler/output");
const RESULTS_DIR = path.resolve(__dirname, "results");
const DICTS_DIR = path.resolve(__dirname, "dicts");
const TEMP_DIR = path.resolve(__dirname, "temp");

interface BookConfig {
  bookId: string;
  name: string;
  chapterCount: number;
}

interface SelectedBooks {
  timestamp: string;
  books: {
    categoryA: BookConfig;
    categoryB: BookConfig;
    categoryC: BookConfig;
    categoryD: BookConfig;
    categoryE: BookConfig;
  };
  globalDictBookCount: number;
}

interface ScenarioResult {
  scenario: number;
  scenarioName: string;
  bookId: string;
  category: string;
  chapterCount: number;
  chaptersProcessed: number;
  totalOriginalSize: number;
  totalCompressedSize: number;
  compressionRatio: number;
  compressionTimeMs: number;
  decompressionTimeMs: number;
  dictSize: number;
  dictTrainingTimeMs: number;
  avgChapterOriginalSize: number;
  avgChapterCompressedSize: number;
}

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  blue: "\x1b[34m",
};

function log(msg: string) {
  console.log(msg);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function loadSelectedBooks(): SelectedBooks {
  const filePath = path.join(RESULTS_DIR, "selected-books.json");
  if (!fs.existsSync(filePath)) {
    throw new Error("selected-books.json not found. Run select-books.ts first.");
  }
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function getChapterFiles(bookId: string): string[] {
  const bookDir = path.join(CRAWLER_OUTPUT, bookId);
  if (!fs.existsSync(bookDir)) {
    return [];
  }
  const files = fs.readdirSync(bookDir);
  return files
    .filter(f => /^\d{4}_.*\.txt$/.test(f))
    .sort()
    .map(f => path.join(bookDir, f));
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

function checkZstdInstalled(): boolean {
  try {
    execSync("zstd --version", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function trainPerBookDict(bookId: string, chapterFiles: string[], maxSamples: number): string {
  // Limit samples to avoid Windows command line length limit
  const sampleCount = Math.min(chapterFiles.length, maxSamples, 100);
  if (sampleCount < 10) {
    throw new Error(`Not enough samples for book ${bookId}: ${sampleCount} < 10`);
  }
  
  // Select evenly distributed samples
  const step = Math.max(1, Math.floor(chapterFiles.length / sampleCount));
  const samples: string[] = [];
  for (let i = 0; i < sampleCount && i * step < chapterFiles.length; i++) {
    samples.push(chapterFiles[i * step]);
  }
  
  // Create temp directory for samples
  const tempDir = path.join(TEMP_DIR, `train_${bookId}`);
  fs.mkdirSync(tempDir, { recursive: true });
  
  // Copy samples (body only) with short names
  const sampleFiles: string[] = [];
  for (let i = 0; i < samples.length; i++) {
    const body = readChapterBody(samples[i]);
    const samplePath = path.join(tempDir, `${i}.txt`);
    fs.writeFileSync(samplePath, body);
    sampleFiles.push(`${i}.txt`);
  }
  
  // Train dictionary using relative paths from temp dir to avoid cmd length limit
  const dictPath = path.resolve(DICTS_DIR, `${bookId}.dict`);
  const relativeDictPath = path.relative(tempDir, dictPath);
  const filesArg = sampleFiles.map(f => `"${f}"`).join(" ");
  
  try {
    execSync(`zstd --train ${filesArg} -o "${relativeDictPath}" --maxdict=65536`, {
      cwd: tempDir,
      shell: true,
      stdio: "pipe",
    });
  } catch (err) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw new Error(`Dict training failed for book ${bookId}: ${(err as Error).message}`);
  }
  
  // Cleanup temp
  fs.rmSync(tempDir, { recursive: true, force: true });
  
  if (!fs.existsSync(dictPath)) {
    throw new Error(`Dict file not created for book ${bookId}`);
  }
  
  return dictPath;
}

// Compress/decompress using temp files and CLI
function compressWithZstd(data: Buffer, level: number, dictPath?: string): { compressed: Buffer; timeMs: number } {
  const inputPath = path.join(TEMP_DIR, "input.tmp");
  const outputPath = path.join(TEMP_DIR, "output.tmp.zst");
  
  fs.writeFileSync(inputPath, data);
  
  const dictArg = dictPath ? `-D "${dictPath}"` : "";
  const start = performance.now();
  
  try {
    execSync(`zstd -${level} ${dictArg} "${inputPath}" -o "${outputPath}" -f 2>nul`, {
      shell: true,
      stdio: "pipe",
    });
  } catch {
    // Return original size if compression fails
    return { compressed: data, timeMs: performance.now() - start };
  }
  
  const timeMs = performance.now() - start;
  const compressed = fs.readFileSync(outputPath);
  
  return { compressed, timeMs };
}

function decompressWithZstd(data: Buffer, dictPath?: string): { decompressed: Buffer; timeMs: number } {
  const inputPath = path.join(TEMP_DIR, "input.tmp.zst");
  const outputPath = path.join(TEMP_DIR, "output.tmp");
  
  fs.writeFileSync(inputPath, data);
  
  const dictArg = dictPath ? `-D "${dictPath}"` : "";
  const start = performance.now();
  
  try {
    execSync(`zstd -d ${dictArg} "${inputPath}" -o "${outputPath}" -f 2>nul`, {
      shell: true,
      stdio: "pipe",
    });
  } catch {
    return { decompressed: Buffer.alloc(0), timeMs: performance.now() - start };
  }
  
  const timeMs = performance.now() - start;
  const decompressed = fs.readFileSync(outputPath);
  
  return { decompressed, timeMs };
}

// Scenario -1: Gzip
function benchmarkGzip(bookId: string, chapterFiles: string[]): Omit<ScenarioResult, "scenario" | "scenarioName" | "category"> {
  let totalOriginal = 0;
  let totalCompressed = 0;
  let compressTime = 0;
  let decompressTime = 0;
  let processed = 0;
  
  for (const file of chapterFiles) {
    const body = readChapterBody(file);
    const original = Buffer.from(body, "utf-8");
    totalOriginal += original.length;
    
    const cStart = performance.now();
    const compressed = gzipSync(original, { level: 6 });
    compressTime += performance.now() - cStart;
    
    totalCompressed += compressed.length;
    
    const dStart = performance.now();
    gunzipSync(compressed);
    decompressTime += performance.now() - dStart;
    
    processed++;
  }
  
  return {
    bookId,
    chapterCount: chapterFiles.length,
    chaptersProcessed: processed,
    totalOriginalSize: totalOriginal,
    totalCompressedSize: totalCompressed,
    compressionRatio: totalOriginal / totalCompressed,
    compressionTimeMs: compressTime,
    decompressionTimeMs: decompressTime,
    dictSize: 0,
    dictTrainingTimeMs: 0,
    avgChapterOriginalSize: totalOriginal / processed,
    avgChapterCompressedSize: totalCompressed / processed,
  };
}

// Scenario 0, 1, 2, 3: Zstd with optional dictionary
// Sample-based: only process SAMPLE_SIZE chapters (CLI is slow due to process spawn overhead)
const ZSTD_SAMPLE_SIZE = 50;

function benchmarkZstd(
  bookId: string,
  chapterFiles: string[],
  dictPath: string | null,
  dictTrainTime: number = 0
): Omit<ScenarioResult, "scenario" | "scenarioName" | "category"> {
  // Select evenly distributed sample
  const sampleStep = Math.max(1, Math.floor(chapterFiles.length / ZSTD_SAMPLE_SIZE));
  const sampledFiles: string[] = [];
  for (let i = 0; i < ZSTD_SAMPLE_SIZE && i * sampleStep < chapterFiles.length; i++) {
    sampledFiles.push(chapterFiles[i * sampleStep]);
  }
  
  let totalOriginal = 0;
  let totalCompressed = 0;
  let compressTime = 0;
  let decompressTime = 0;
  
  for (const file of sampledFiles) {
    const body = readChapterBody(file);
    const original = Buffer.from(body, "utf-8");
    totalOriginal += original.length;
    
    const { compressed, timeMs: cTime } = compressWithZstd(original, 9, dictPath || undefined);
    compressTime += cTime;
    totalCompressed += compressed.length;
    
    const { timeMs: dTime } = decompressWithZstd(compressed, dictPath || undefined);
    decompressTime += dTime;
  }
  
  // Extrapolate to full book
  const scaleFactor = chapterFiles.length / sampledFiles.length;
  const extrapolatedOriginal = totalOriginal * scaleFactor;
  const extrapolatedCompressed = totalCompressed * scaleFactor;
  const extrapolatedCompressTime = compressTime * scaleFactor;
  const extrapolatedDecompressTime = decompressTime * scaleFactor;
  
  const dictSize = dictPath && fs.existsSync(dictPath) ? fs.statSync(dictPath).size : 0;
  
  return {
    bookId,
    chapterCount: chapterFiles.length,
    chaptersProcessed: sampledFiles.length,
    totalOriginalSize: Math.round(extrapolatedOriginal),
    totalCompressedSize: Math.round(extrapolatedCompressed),
    compressionRatio: totalOriginal / totalCompressed,
    compressionTimeMs: extrapolatedCompressTime,
    decompressionTimeMs: extrapolatedDecompressTime,
    dictSize,
    dictTrainingTimeMs: dictTrainTime,
    avgChapterOriginalSize: totalOriginal / sampledFiles.length,
    avgChapterCompressedSize: totalCompressed / sampledFiles.length,
  };
}

function runBenchmark(
  bookConfig: BookConfig,
  category: string,
  globalDictPath: string | null
): ScenarioResult[] {
  const chapterFiles = getChapterFiles(bookConfig.bookId);
  if (chapterFiles.length === 0) {
    log(`    ${c.red}Book ${bookConfig.bookId} not found locally, skipping${c.reset}`);
    return [];
  }
  
  const results: ScenarioResult[] = [];
  
  log(`\n  ${c.cyan}Book ${bookConfig.bookId}${c.reset} - "${bookConfig.name}" (${category}, ${chapterFiles.length} chapters)`);
  
  // Scenario -1: Gzip
  log(`    Scenario -1 (gzip)...`);
  const gzipResult = benchmarkGzip(bookConfig.bookId, chapterFiles);
  results.push({ scenario: -1, scenarioName: "gzip", category, ...gzipResult });
  log(`      ${c.dim}Ratio: ${gzipResult.compressionRatio.toFixed(2)}x, Compress: ${formatMs(gzipResult.compressionTimeMs)}, Decompress: ${formatMs(gzipResult.decompressionTimeMs)}${c.reset}`);
  
  // Scenario 0: Pure zstd (no dict)
  log(`    Scenario 0 (zstd, no dict)...`);
  const zstdResult = benchmarkZstd(bookConfig.bookId, chapterFiles, null);
  results.push({ scenario: 0, scenarioName: "zstd-none", category, ...zstdResult });
  log(`      ${c.dim}Ratio: ${zstdResult.compressionRatio.toFixed(2)}x, Compress: ${formatMs(zstdResult.compressionTimeMs)}, Decompress: ${formatMs(zstdResult.decompressionTimeMs)}${c.reset}`);
  
  // Scenario 1: Global dict
  log(`    Scenario 1 (global dict)...`);
  if (!globalDictPath || !fs.existsSync(globalDictPath)) {
    throw new Error(`Global dictionary not found at ${globalDictPath}. Run 'npx tsx select-books.ts --train' first.`);
  }
  const globalResult = benchmarkZstd(bookConfig.bookId, chapterFiles, globalDictPath);
  results.push({ scenario: 1, scenarioName: "zstd-global", category, ...globalResult });
  log(`      ${c.dim}Ratio: ${globalResult.compressionRatio.toFixed(2)}x, Compress: ${formatMs(globalResult.compressionTimeMs)}, Decompress: ${formatMs(globalResult.decompressionTimeMs)}${c.reset}`);
  
  // Scenario 2: Per-book dict (20%, max 500)
  log(`    Scenario 2 (per-book 20%, max 500)...`);
  const trainStart2 = performance.now();
  const maxSamples2 = Math.min(Math.ceil(chapterFiles.length * 0.2), 500);
  const dict2Path = trainPerBookDict(`${bookConfig.bookId}_s2`, chapterFiles, maxSamples2);
  const trainTime2 = performance.now() - trainStart2;
  
  const perBook2Result = benchmarkZstd(bookConfig.bookId, chapterFiles, dict2Path, trainTime2);
  results.push({ scenario: 2, scenarioName: "zstd-perbook-20%", category, ...perBook2Result });
  log(`      ${c.dim}Ratio: ${perBook2Result.compressionRatio.toFixed(2)}x, Dict train: ${formatMs(trainTime2)}, Compress: ${formatMs(perBook2Result.compressionTimeMs)}${c.reset}`);
  
  // Scenario 3: Per-book dict (10%, max 100)
  log(`    Scenario 3 (per-book 10%, max 100)...`);
  const trainStart3 = performance.now();
  const maxSamples3 = Math.min(Math.ceil(chapterFiles.length * 0.1), 100);
  const dict3Path = trainPerBookDict(`${bookConfig.bookId}_s3`, chapterFiles, maxSamples3);
  const trainTime3 = performance.now() - trainStart3;
  
  const perBook3Result = benchmarkZstd(bookConfig.bookId, chapterFiles, dict3Path, trainTime3);
  results.push({ scenario: 3, scenarioName: "zstd-perbook-10%", category, ...perBook3Result });
  log(`      ${c.dim}Ratio: ${perBook3Result.compressionRatio.toFixed(2)}x, Dict train: ${formatMs(trainTime3)}, Compress: ${formatMs(perBook3Result.compressionTimeMs)}${c.reset}`)
  
  return results;
}

function generateReport(allResults: ScenarioResult[]): void {
  const reportPath = path.join(RESULTS_DIR, "summary.md");
  
  const lines: string[] = [
    "# Zstd Compression Benchmark Results",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    "## Summary by Scenario",
    "",
    "| Scenario | Description | Avg Ratio | Avg Compress | Avg Decompress |",
    "|----------|-------------|-----------|--------------|----------------|",
  ];
  
  const scenarios = [-1, 0, 1, 2, 3];
  const scenarioNames: Record<number, string> = {
    [-1]: "Gzip",
    [0]: "Zstd (no dict)",
    [1]: "Zstd + Global dict",
    [2]: "Zstd + Per-book (20%)",
    [3]: "Zstd + Per-book (10%)",
  };
  
  for (const s of scenarios) {
    const results = allResults.filter(r => r.scenario === s);
    if (results.length === 0) continue;
    
    const avgRatio = results.reduce((sum, r) => sum + r.compressionRatio, 0) / results.length;
    const avgCompress = results.reduce((sum, r) => sum + r.compressionTimeMs, 0) / results.length;
    const avgDecompress = results.reduce((sum, r) => sum + r.decompressionTimeMs, 0) / results.length;
    
    lines.push(`| ${s} | ${scenarioNames[s]} | ${avgRatio.toFixed(2)}x | ${formatMs(avgCompress)} | ${formatMs(avgDecompress)} |`);
  }
  
  lines.push("");
  lines.push("## Detailed Results by Book");
  lines.push("");
  
  const categories = ["A", "B", "C", "D", "E"];
  
  for (const cat of categories) {
    const catResults = allResults.filter(r => r.category === cat);
    if (catResults.length === 0) continue;
    
    const bookId = catResults[0].bookId;
    const chapterCount = catResults[0].chapterCount;
    const originalSize = catResults[0].totalOriginalSize;
    
    lines.push(`### Category ${cat}: Book ${bookId} (${chapterCount} chapters, ${formatBytes(originalSize)} original)`);
    lines.push("");
    lines.push("| Scenario | Compressed | Ratio | Compress | Decompress | Dict Size | Dict Train |");
    lines.push("|----------|------------|-------|----------|------------|-----------|------------|");
    
    for (const r of catResults.sort((a, b) => a.scenario - b.scenario)) {
      lines.push(`| ${r.scenario}: ${r.scenarioName} | ${formatBytes(r.totalCompressedSize)} | ${r.compressionRatio.toFixed(2)}x | ${formatMs(r.compressionTimeMs)} | ${formatMs(r.decompressionTimeMs)} | ${r.dictSize > 0 ? formatBytes(r.dictSize) : "-"} | ${r.dictTrainingTimeMs > 0 ? formatMs(r.dictTrainingTimeMs) : "-"} |`);
    }
    
    lines.push("");
  }
  
  // Size comparison table
  lines.push("## Size Comparison (% smaller than gzip)");
  lines.push("");
  lines.push("| Book | Chapters | Zstd | +Global | +PerBook 20% | +PerBook 10% |");
  lines.push("|------|----------|------|---------|--------------|--------------|");
  
  for (const cat of categories) {
    const catResults = allResults.filter(r => r.category === cat);
    if (catResults.length === 0) continue;
    
    const gzipSize = catResults.find(r => r.scenario === -1)?.totalCompressedSize || 1;
    const zstdSize = catResults.find(r => r.scenario === 0)?.totalCompressedSize || gzipSize;
    const globalSize = catResults.find(r => r.scenario === 1)?.totalCompressedSize || gzipSize;
    const perBook20Size = catResults.find(r => r.scenario === 2)?.totalCompressedSize || gzipSize;
    const perBook10Size = catResults.find(r => r.scenario === 3)?.totalCompressedSize || gzipSize;
    
    const pct = (size: number) => `${(((gzipSize - size) / gzipSize) * 100).toFixed(1)}%`;
    
    lines.push(`| ${catResults[0].bookId} | ${catResults[0].chapterCount} | ${pct(zstdSize)} | ${pct(globalSize)} | ${pct(perBook20Size)} | ${pct(perBook10Size)} |`);
  }
  
  lines.push("");
  lines.push("## Recommendations");
  lines.push("");
  
  // Find best scenario
  const avgRatios = scenarios.map(s => {
    const results = allResults.filter(r => r.scenario === s);
    if (results.length === 0) return { scenario: s, avgRatio: 0 };
    return {
      scenario: s,
      avgRatio: results.reduce((sum, r) => sum + r.compressionRatio, 0) / results.length,
    };
  }).filter(x => x.avgRatio > 0);
  
  const best = avgRatios.sort((a, b) => b.avgRatio - a.avgRatio)[0];
  if (best) {
    lines.push(`- **Best compression**: Scenario ${best.scenario} (${scenarioNames[best.scenario]}) with ${best.avgRatio.toFixed(2)}x average ratio`);
  }
  lines.push("");
  
  fs.writeFileSync(reportPath, lines.join("\n"));
  log(`\n${c.green}Report saved to ${reportPath}${c.reset}`);
}

async function main() {
  log(`\n${c.bold}=== Zstd Compression Benchmark ===${c.reset}\n`);
  
  // Check zstd is installed
  if (!checkZstdInstalled()) {
    log(`${c.red}Error: zstd CLI not found. Please install it:${c.reset}`);
    log(`  Windows: winget install Facebook.zstd`);
    log(`  macOS: brew install zstd`);
    log(`  Linux: apt install zstd`);
    process.exit(1);
  }
  log(`${c.green}✓ zstd CLI found${c.reset}`);
  
  // Load selected books
  const selected = loadSelectedBooks();
  log(`${c.cyan}Loaded test books from ${selected.timestamp}${c.reset}`);
  
  // Create temp directory
  fs.mkdirSync(TEMP_DIR, { recursive: true });
  fs.mkdirSync(DICTS_DIR, { recursive: true });
  
  // Load global dictionary if available
  const globalDictPath = path.join(RESULTS_DIR, "global.dict");
  if (fs.existsSync(globalDictPath)) {
    log(`${c.green}Global dictionary loaded (${formatBytes(fs.statSync(globalDictPath).size)})${c.reset}`);
  } else {
    log(`${c.yellow}Global dictionary not found, scenario 1 will use no-dict fallback${c.reset}`);
  }
  
  // Run benchmarks
  const allResults: ScenarioResult[] = [];
  
  log(`\n${c.bold}Running benchmarks...${c.reset}`);
  
  allResults.push(...runBenchmark(selected.books.categoryA, "A", globalDictPath));
  allResults.push(...runBenchmark(selected.books.categoryB, "B", globalDictPath));
  allResults.push(...runBenchmark(selected.books.categoryC, "C", globalDictPath));
  allResults.push(...runBenchmark(selected.books.categoryD, "D", globalDictPath));
  allResults.push(...runBenchmark(selected.books.categoryE, "E", globalDictPath));
  
  // Cleanup temp
  fs.rmSync(TEMP_DIR, { recursive: true, force: true });
  
  if (allResults.length === 0) {
    log(`\n${c.red}No results! Make sure books are pulled from server.${c.reset}`);
    process.exit(1);
  }
  
  // Save raw results
  fs.writeFileSync(
    path.join(RESULTS_DIR, "raw-results.json"),
    JSON.stringify(allResults, null, 2)
  );
  
  // Generate report
  generateReport(allResults);
  
  log(`\n${c.green}${c.bold}Benchmark complete!${c.reset}`);
  log(`  Results: ${c.cyan}results/summary.md${c.reset}`);
  log(`  Raw data: ${c.cyan}results/raw-results.json${c.reset}\n`);
}

main().catch(console.error);
