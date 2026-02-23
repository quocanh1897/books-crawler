/**
 * Book Selection Script
 * 
 * 1. Reads fresh_books_download.json to find books by chapter count
 * 2. Selects 5 test books (one from each size category)
 * 3. Generates rsync commands to pull only those books from server
 * 4. After pulling, collects samples and trains global dictionary
 */

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FRESH_BOOKS_JSON = path.resolve(__dirname, "../crawler-descryptor/fresh_books_download.json");
const CRAWLER_OUTPUT = path.resolve(__dirname, "../crawler/output");
const RESULTS_DIR = path.resolve(__dirname, "results");
const TRAINING_DIR = path.resolve(__dirname, "training");


interface BookEntry {
  id: number;
  name: string;
  slug: string;
  chapter_count: number;
  status: string;
}

interface SelectedBook {
  bookId: string;
  name: string;
  chapterCount: number;
}

interface SelectedBooks {
  categoryA: SelectedBook; // >3000 chapters
  categoryB: SelectedBook; // 2000-3000 chapters
  categoryC: SelectedBook; // 1000-2000 chapters
  categoryD: SelectedBook; // 500-1000 chapters
  categoryE: SelectedBook; // <500 chapters
  globalDictBooks: SelectedBook[]; // 500 books for global dict training
}

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  blue: "\x1b[34m",
};

function log(msg: string) {
  console.log(msg);
}

function loadFreshBooks(): BookEntry[] {
  log(`${c.cyan}Loading ${FRESH_BOOKS_JSON}...${c.reset}`);
  const data = fs.readFileSync(FRESH_BOOKS_JSON, "utf-8");
  const books: BookEntry[] = JSON.parse(data);
  log(`  Found ${books.length} books`);
  return books;
}

function selectTestBooks(books: BookEntry[]): SelectedBooks {
  log(`\n${c.cyan}Selecting test books...${c.reset}`);
  
  // Sort by chapter count descending
  books.sort((a, b) => b.chapter_count - a.chapter_count);
  
  // Filter by category - adjust based on available data
  // If no >3000 books, use the largest available
  const categoryA = books.filter(b => b.chapter_count > 2500);
  const categoryB = books.filter(b => b.chapter_count >= 2000 && b.chapter_count <= 2500);
  const categoryC = books.filter(b => b.chapter_count >= 1000 && b.chapter_count < 2000);
  const categoryD = books.filter(b => b.chapter_count >= 500 && b.chapter_count < 1000);
  const categoryE = books.filter(b => b.chapter_count >= 100 && b.chapter_count < 500);
  
  log(`  Category A (>2500 chapters): ${categoryA.length} books`);
  log(`  Category B (2000-2500 chapters): ${categoryB.length} books`);
  log(`  Category C (1000-2000 chapters): ${categoryC.length} books`);
  log(`  Category D (500-1000 chapters): ${categoryD.length} books`);
  log(`  Category E (100-500 chapters): ${categoryE.length} books`);
  
  // Pick middle book from each category for representativeness
  const pickMiddle = (arr: BookEntry[], fallback?: BookEntry[]): SelectedBook => {
    const source = arr.length > 0 ? arr : (fallback || []);
    if (source.length === 0) throw new Error("No books in category");
    // Sort by chapter count descending
    source.sort((a, b) => b.chapter_count - a.chapter_count);
    const book = source[Math.floor(source.length / 2)];
    return {
      bookId: String(book.id),
      name: book.name,
      chapterCount: book.chapter_count,
    };
  };
  
  // For global dict: pick 500 random books with >1000 chapters
  const largeBooks = books.filter(b => b.chapter_count > 1000);
  const shuffled = largeBooks.sort(() => Math.random() - 0.5);
  const globalDictBooks = shuffled.slice(0, 500).map(b => ({
    bookId: String(b.id),
    name: b.name,
    chapterCount: b.chapter_count,
  }));
  
  // Use fallbacks if categories are empty
  const allLargeBooks = books.filter(b => b.chapter_count >= 2000);
  
  const selected: SelectedBooks = {
    categoryA: pickMiddle(categoryA, allLargeBooks),
    categoryB: pickMiddle(categoryB, allLargeBooks),
    categoryC: pickMiddle(categoryC),
    categoryD: pickMiddle(categoryD),
    categoryE: pickMiddle(categoryE),
    globalDictBooks,
  };
  
  log(`\n${c.green}Selected test books:${c.reset}`);
  log(`  A: ${selected.categoryA.bookId} - "${selected.categoryA.name}" (${selected.categoryA.chapterCount} ch)`);
  log(`  B: ${selected.categoryB.bookId} - "${selected.categoryB.name}" (${selected.categoryB.chapterCount} ch)`);
  log(`  C: ${selected.categoryC.bookId} - "${selected.categoryC.name}" (${selected.categoryC.chapterCount} ch)`);
  log(`  D: ${selected.categoryD.bookId} - "${selected.categoryD.name}" (${selected.categoryD.chapterCount} ch)`);
  log(`  E: ${selected.categoryE.bookId} - "${selected.categoryE.name}" (${selected.categoryE.chapterCount} ch)`);
  log(`\n  Global dict training: ${globalDictBooks.length} books`);
  
  return selected;
}

function checkLocalBooks(selected: SelectedBooks): boolean {
  const testBookIds = [
    selected.categoryA.bookId,
    selected.categoryB.bookId,
    selected.categoryC.bookId,
    selected.categoryD.bookId,
    selected.categoryE.bookId,
  ];
  
  let allExist = true;
  log(`\n${c.cyan}Checking local books...${c.reset}`);
  
  for (const bookId of testBookIds) {
    const bookDir = path.join(CRAWLER_OUTPUT, bookId);
    const exists = fs.existsSync(bookDir);
    const chapterCount = exists 
      ? fs.readdirSync(bookDir).filter(f => /^\d{4}_.*\.txt$/.test(f)).length 
      : 0;
    
    if (exists && chapterCount > 0) {
      log(`  ${c.green}✓${c.reset} Book ${bookId}: ${chapterCount} chapters`);
    } else {
      log(`  ${c.yellow}✗${c.reset} Book ${bookId}: not found locally`);
      allExist = false;
    }
  }
  
  return allExist;
}

function collectTrainingSamples(selected: SelectedBooks): string[] {
  log(`\n${c.cyan}Collecting training samples for global dict...${c.reset}`);
  
  const samplePaths: string[] = [];
  
  for (const book of selected.globalDictBooks) {
    const bookDir = path.join(CRAWLER_OUTPUT, book.bookId);
    if (!fs.existsSync(bookDir)) continue;
    
    const files = fs.readdirSync(bookDir).filter(f => /^\d{4}_.*\.txt$/.test(f));
    if (files.length > 0) {
      // Pick random chapter
      const randomFile = files[Math.floor(Math.random() * files.length)];
      samplePaths.push(path.join(bookDir, randomFile));
    }
  }
  
  log(`  Found ${samplePaths.length} samples`);
  return samplePaths;
}

function copyTrainingSamples(samplePaths: string[]): void {
  log(`\n${c.cyan}Copying training samples...${c.reset}`);
  
  fs.mkdirSync(TRAINING_DIR, { recursive: true });
  
  // Clear existing
  const existing = fs.readdirSync(TRAINING_DIR);
  for (const f of existing) {
    fs.unlinkSync(path.join(TRAINING_DIR, f));
  }
  
  for (let i = 0; i < samplePaths.length; i++) {
    const src = samplePaths[i];
    const dest = path.join(TRAINING_DIR, `sample_${i.toString().padStart(4, "0")}.txt`);
    fs.copyFileSync(src, dest);
  }
  
  log(`  Copied ${samplePaths.length} samples to ${TRAINING_DIR}`);
}

function trainGlobalDictionary(): void {
  log(`\n${c.cyan}Training global dictionary...${c.reset}`);
  
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const dictPath = path.join(RESULTS_DIR, "global.dict");
  
  // Get all sample files (explicit paths, not wildcards - Windows doesn't expand them)
  const sampleFiles = fs.readdirSync(TRAINING_DIR)
    .filter(f => f.endsWith(".txt"))
    .map(f => path.join(TRAINING_DIR, f));
  
  if (sampleFiles.length < 10) {
    throw new Error(`Not enough samples (${sampleFiles.length}). Need at least 10.`);
  }
  
  log(`  Found ${sampleFiles.length} sample files`);
  
  // Pass files explicitly (Windows doesn't expand wildcards)
  const filesArg = sampleFiles.map(f => `"${f}"`).join(" ");
  const cmd = `zstd --train ${filesArg} -o "${dictPath}" --maxdict=131072`;
  
  try {
    log(`  Training dictionary...`);
    execSync(cmd, { stdio: "pipe", shell: true });
    
    if (!fs.existsSync(dictPath)) {
      throw new Error("Dict file was not created");
    }
    
    const dictSize = fs.statSync(dictPath).size;
    log(`  ${c.green}Created global.dict (${(dictSize / 1024).toFixed(1)} KB)${c.reset}`);
  } catch (err) {
    throw new Error(`Global dict training failed: ${(err as Error).message}`);
  }
}

function saveSelectedBooks(selected: SelectedBooks): void {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  
  const output = {
    timestamp: new Date().toISOString(),
    books: {
      categoryA: selected.categoryA,
      categoryB: selected.categoryB,
      categoryC: selected.categoryC,
      categoryD: selected.categoryD,
      categoryE: selected.categoryE,
    },
    globalDictBookCount: selected.globalDictBooks.length,
  };
  
  fs.writeFileSync(
    path.join(RESULTS_DIR, "selected-books.json"),
    JSON.stringify(output, null, 2)
  );
  
  // Save global dict books separately (for pull-books.ts)
  fs.writeFileSync(
    path.join(RESULTS_DIR, "global-dict-books.json"),
    JSON.stringify(selected.globalDictBooks, null, 2)
  );
  
  log(`\n${c.green}Saved selection to results/selected-books.json${c.reset}`);
  log(`${c.green}Saved dict books to results/global-dict-books.json${c.reset}`);
}

// Main
async function main() {
  const args = process.argv.slice(2);
  const trainMode = args.includes("--train");
  
  log(`\n${c.bold}=== Zstd Benchmark: Book Selection ===${c.reset}\n`);
  
  const books = loadFreshBooks();
  const selected = selectTestBooks(books);
  
  saveSelectedBooks(selected);
  
  const allLocal = checkLocalBooks(selected);
  
  if (!allLocal) {
    log(`\n${c.yellow}${c.bold}Next steps:${c.reset}`);
    log(`  1. Pull books from server:`);
    log(`     ${c.cyan}npx tsx pull-books.ts${c.reset}`);
    log(`  2. Train global dictionary:`);
    log(`     ${c.cyan}npx tsx select-books.ts --train${c.reset}`);
  } else if (trainMode) {
    const samples = collectTrainingSamples(selected);
    if (samples.length > 0) {
      copyTrainingSamples(samples);
      trainGlobalDictionary();
    }
    log(`\n${c.green}${c.bold}Ready!${c.reset} Run ${c.cyan}npx tsx benchmark.ts${c.reset} to start benchmarking.\n`);
  } else {
    log(`\n${c.green}All test books exist locally.${c.reset}`);
    log(`  Run ${c.cyan}npx tsx select-books.ts --train${c.reset} to train global dictionary.`);
  }
}

main().catch(console.error);
