/**
 * Train Global Dictionary from Test Books
 * 
 * Uses random samples from the 5 test books we already have to train
 * a global dictionary. This avoids needing to pull 500 additional books.
 */

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CRAWLER_OUTPUT = path.resolve(__dirname, "../crawler/output");
const RESULTS_DIR = path.resolve(__dirname, "results");
const TRAINING_DIR = path.resolve(__dirname, "training");

interface BookConfig {
  bookId: string;
  name: string;
  chapterCount: number;
}

interface SelectedBooks {
  books: {
    categoryA: BookConfig;
    categoryB: BookConfig;
    categoryC: BookConfig;
    categoryD: BookConfig;
    categoryE: BookConfig;
  };
}

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
};

function log(msg: string) {
  console.log(msg);
}

function loadSelectedBooks(): SelectedBooks {
  const filePath = path.join(RESULTS_DIR, "selected-books.json");
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function getChapterFiles(bookId: string): string[] {
  const bookDir = path.join(CRAWLER_OUTPUT, bookId);
  if (!fs.existsSync(bookDir)) return [];
  return fs.readdirSync(bookDir)
    .filter(f => /^\d{4}_.*\.txt$/.test(f))
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

function collectSamples(): string[] {
  const selected = loadSelectedBooks();
  const books = [
    selected.books.categoryA,
    selected.books.categoryB,
    selected.books.categoryC,
    selected.books.categoryD,
    selected.books.categoryE,
  ];
  
  log(`\n${c.cyan}Collecting samples from test books...${c.reset}`);
  
  const allSamples: string[] = [];
  
  for (const book of books) {
    const chapterFiles = getChapterFiles(book.bookId);
    log(`  Book ${book.bookId}: ${chapterFiles.length} chapters`);
    
    // Take 30 random samples from each book (150 total to fit command line)
    const shuffled = chapterFiles.sort(() => Math.random() - 0.5);
    const samples = shuffled.slice(0, 30);
    allSamples.push(...samples);
  }
  
  log(`  Total samples: ${allSamples.length}`);
  return allSamples;
}

function copySamplesToTrainingDir(samples: string[]): string[] {
  log(`\n${c.cyan}Copying samples to training directory...${c.reset}`);
  
  fs.mkdirSync(TRAINING_DIR, { recursive: true });
  
  // Clear existing
  const existing = fs.readdirSync(TRAINING_DIR);
  for (const f of existing) {
    fs.unlinkSync(path.join(TRAINING_DIR, f));
  }
  
  const samplePaths: string[] = [];
  for (let i = 0; i < samples.length; i++) {
    const body = readChapterBody(samples[i]);
    const destPath = path.join(TRAINING_DIR, `sample_${i.toString().padStart(4, "0")}.txt`);
    fs.writeFileSync(destPath, body);
    samplePaths.push(destPath);
  }
  
  log(`  Copied ${samplePaths.length} samples`);
  return samplePaths;
}

function trainDictionary(samplePaths: string[]): void {
  log(`\n${c.cyan}Training global dictionary...${c.reset}`);
  
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const dictPath = path.resolve(RESULTS_DIR, "global.dict");
  
  log(`  Training with ${samplePaths.length} samples...`);
  
  // Use relative paths from training directory to avoid command line length limit
  const relativeFiles = samplePaths.map(f => path.basename(f));
  const filesArg = relativeFiles.map(f => `"${f}"`).join(" ");
  
  // Run from training directory with relative dict path
  const relativeDictPath = path.relative(TRAINING_DIR, dictPath);
  
  try {
    execSync(`zstd --train ${filesArg} -o "${relativeDictPath}" --maxdict=131072`, {
      cwd: TRAINING_DIR,
      stdio: "pipe",
      shell: true,
    });
    
    if (!fs.existsSync(dictPath)) {
      throw new Error("Dictionary file was not created");
    }
    
    const dictSize = fs.statSync(dictPath).size;
    log(`\n${c.green}${c.bold}Success!${c.reset} Created global.dict (${(dictSize / 1024).toFixed(1)} KB)`);
  } catch (err) {
    log(`\n${c.red}Error: ${(err as Error).message}${c.reset}`);
    process.exit(1);
  }
}

async function main() {
  log(`\n${c.bold}=== Train Global Dictionary ===${c.reset}`);
  
  const samples = collectSamples();
  const samplePaths = copySamplesToTrainingDir(samples);
  trainDictionary(samplePaths);
  
  log(`\nNext: ${c.cyan}npx tsx benchmark.ts${c.reset} to run the benchmark.\n`);
}

main().catch(console.error);
