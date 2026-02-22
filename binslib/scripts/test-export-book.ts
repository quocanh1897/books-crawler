/**
 * Test export script for a single book
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Compressor } from "zstd-napi";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BOOK_ID = process.argv[2] || "113592";
const CRAWLER_OUTPUT = path.resolve(__dirname, "../../crawler/output");
const OUTPUT_DIR = path.resolve(__dirname, "../data/test-compressed");
const DICT_PATH = path.resolve(__dirname, "../data/global.dict");

console.log(`\n=== Test Export: Book ${BOOK_ID} ===\n`);

// Initialize compressor with dictionary
const compressor = new Compressor();
compressor.setParameters({ compressionLevel: 3 });

if (fs.existsSync(DICT_PATH)) {
  compressor.loadDictionary(fs.readFileSync(DICT_PATH));
  console.log(`Dictionary loaded: ${DICT_PATH}`);
} else {
  console.log("No dictionary found, using plain zstd");
}

const bookDir = path.join(CRAWLER_OUTPUT, BOOK_ID);
if (!fs.existsSync(bookDir)) {
  console.error(`Book directory not found: ${bookDir}`);
  process.exit(1);
}

const chapterFiles = fs
  .readdirSync(bookDir)
  .filter((f) => /^\d{4}_/.test(f) && f.endsWith(".txt"))
  .sort();

console.log(`Found ${chapterFiles.length} chapters\n`);

const outDir = path.join(OUTPUT_DIR, BOOK_ID);
fs.mkdirSync(outDir, { recursive: true });

let totalOriginal = 0;
let totalCompressed = 0;
let exported = 0;

const startTime = performance.now();

for (const file of chapterFiles) {
  const match = file.match(/^(\d+)_(.+)\.txt$/);
  if (!match) continue;

  const indexNum = parseInt(match[1], 10);
  const srcPath = path.join(bookDir, file);
  const content = fs.readFileSync(srcPath, "utf-8");

  // Extract body (skip title)
  const lines = content.split("\n");
  const title = lines[0]?.trim() || "";
  let bodyStart = 1;
  while (bodyStart < lines.length && lines[bodyStart].trim() === "") bodyStart++;
  if (bodyStart < lines.length && lines[bodyStart].trim() === title) bodyStart++;
  const body = lines.slice(bodyStart).join("\n").trim();

  const bodyBuf = Buffer.from(body, "utf-8");
  totalOriginal += bodyBuf.length;

  const compressed = compressor.compress(bodyBuf);
  totalCompressed += compressed.length;

  const outFile = path.join(outDir, `${indexNum}.txt.zst`);
  fs.writeFileSync(outFile, compressed);
  exported++;

  if (exported <= 5 || exported % 50 === 0) {
    const ratio = (bodyBuf.length / compressed.length).toFixed(2);
    console.log(`  Chapter ${indexNum}: ${bodyBuf.length} → ${compressed.length} bytes (${ratio}x)`);
  }
}

const elapsed = performance.now() - startTime;
const ratio = totalOriginal / totalCompressed;

console.log(`\n=== Results ===`);
console.log(`Chapters exported: ${exported}`);
console.log(`Original size: ${(totalOriginal / 1024).toFixed(1)} KB`);
console.log(`Compressed size: ${(totalCompressed / 1024).toFixed(1)} KB`);
console.log(`Compression ratio: ${ratio.toFixed(2)}x`);
console.log(`Time: ${elapsed.toFixed(0)} ms`);
console.log(`Output: ${outDir}`);
