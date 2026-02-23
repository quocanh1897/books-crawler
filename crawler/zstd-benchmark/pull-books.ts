/**
 * Pull Selected Books from Server
 * 
 * Reads selected-books.json and pulls only the required books from the server.
 * - Test books: Full content (5 books)
 * - Dict training books: Only 1 chapter each (500 books)
 * 
 * Usage:
 *   npx tsx pull-books.ts              # Pull all (test + dict books)
 *   npx tsx pull-books.ts --test-only  # Pull only 5 test books
 *   npx tsx pull-books.ts --dict-only  # Pull only dict training books
 *   npx tsx pull-books.ts --dry-run    # Show what would be pulled
 */

import fs from "node:fs";
import path from "node:path";
import { execSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const RESULTS_DIR = path.resolve(__dirname, "results");
const CRAWLER_OUTPUT = path.resolve(__dirname, "../crawler/output");

const SERVER = "alex@192.168.1.22";
const SERVER_PATH = "/data/mtc/crawler/output";

interface SelectedBook {
  bookId: string;
  name: string;
  chapterCount: number;
}

interface SelectedBooksFile {
  timestamp: string;
  books: {
    categoryA: SelectedBook;
    categoryB: SelectedBook;
    categoryC: SelectedBook;
    categoryD: SelectedBook;
    categoryE: SelectedBook;
  };
  globalDictBookCount: number;
  globalDictBooks?: SelectedBook[];
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

function loadSelectedBooks(): SelectedBooksFile {
  const filePath = path.join(RESULTS_DIR, "selected-books.json");
  if (!fs.existsSync(filePath)) {
    throw new Error("selected-books.json not found. Run 'npx tsx select-books.ts' first.");
  }
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function loadGlobalDictBooks(): SelectedBook[] {
  const filePath = path.join(RESULTS_DIR, "global-dict-books.json");
  if (!fs.existsSync(filePath)) {
    return [];
  }
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function runCommand(cmd: string, dryRun: boolean): boolean {
  if (dryRun) {
    log(`  ${c.dim}[dry-run] ${cmd}${c.reset}`);
    return true;
  }
  
  try {
    execSync(cmd, { stdio: "inherit", shell: true });
    return true;
  } catch {
    return false;
  }
}

function checkSSHConnection(): boolean {
  log(`${c.cyan}Checking SSH connection to ${SERVER}...${c.reset}`);
  try {
    execSync(`ssh -o ConnectTimeout=5 ${SERVER} "echo ok"`, { 
      stdio: "pipe", 
      shell: true,
      timeout: 10000,
    });
    log(`  ${c.green}✓ Connected${c.reset}`);
    return true;
  } catch {
    log(`  ${c.red}✗ Cannot connect to ${SERVER}${c.reset}`);
    log(`  ${c.yellow}Make sure SSH key is set up and server is reachable.${c.reset}`);
    return false;
  }
}

function pullTestBooks(selected: SelectedBooksFile, dryRun: boolean): void {
  const testBooks = [
    { ...selected.books.categoryA, category: "A (>3000 ch)" },
    { ...selected.books.categoryB, category: "B (2000-3000 ch)" },
    { ...selected.books.categoryC, category: "C (1000-2000 ch)" },
    { ...selected.books.categoryD, category: "D (500-1000 ch)" },
    { ...selected.books.categoryE, category: "E (<500 ch)" },
  ];
  
  log(`\n${c.bold}Pulling ${testBooks.length} test books (full content)...${c.reset}\n`);
  
  for (const book of testBooks) {
    const localDir = path.join(CRAWLER_OUTPUT, book.bookId);
    const existingFiles = fs.existsSync(localDir) 
      ? fs.readdirSync(localDir).filter(f => /^\d{4}_.*\.txt$/.test(f)).length 
      : 0;
    
    if (existingFiles >= book.chapterCount * 0.9) {
      log(`  ${c.green}✓${c.reset} Book ${book.bookId} "${book.name}" - already exists (${existingFiles} files)`);
      continue;
    }
    
    log(`  ${c.cyan}↓${c.reset} Book ${book.bookId} "${book.name}" (${book.category})`);
    
    if (!dryRun) {
      fs.mkdirSync(localDir, { recursive: true });
    }
    
    // Use scp on Windows (rsync not available)
    const localDirUnix = localDir.split(path.sep).join("/");
    const cmd = `scp -r "${SERVER}:${SERVER_PATH}/${book.bookId}/*" "${localDirUnix}/"`;
    runCommand(cmd, dryRun);
  }
}

function pullDictBooks(dictBooks: SelectedBook[], dryRun: boolean): void {
  log(`\n${c.bold}Pulling ${dictBooks.length} dict training books (1 chapter each)...${c.reset}\n`);
  
  let pulled = 0;
  let skipped = 0;
  let failed = 0;
  
  for (let i = 0; i < dictBooks.length; i++) {
    const book = dictBooks[i];
    const localDir = path.join(CRAWLER_OUTPUT, book.bookId);
    
    // Check if already has at least 1 chapter
    const existingFiles = fs.existsSync(localDir) 
      ? fs.readdirSync(localDir).filter(f => /^\d{4}_.*\.txt$/.test(f)).length 
      : 0;
    
    if (existingFiles > 0) {
      skipped++;
      continue;
    }
    
    if (!dryRun) {
      fs.mkdirSync(localDir, { recursive: true });
    }
    
    // Pull only first chapter using scp
    const localDirUnix = localDir.split(path.sep).join("/");
    const cmd = `scp "${SERVER}:${SERVER_PATH}/${book.bookId}/0001_*.txt" "${localDirUnix}/" 2>nul`;
    
    if (dryRun) {
      pulled++;
    } else {
      try {
        execSync(cmd, { stdio: "pipe", shell: true });
        pulled++;
      } catch {
        failed++;
      }
    }
    
    // Progress update every 50 books
    if ((i + 1) % 50 === 0 || i === dictBooks.length - 1) {
      process.stdout.write(`\r  Progress: ${i + 1}/${dictBooks.length} (pulled: ${pulled}, skipped: ${skipped}, failed: ${failed})`);
    }
  }
  
  log(`\n\n  ${c.green}Pulled: ${pulled}${c.reset}, Skipped: ${skipped}, Failed: ${failed}`);
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const testOnly = args.includes("--test-only");
  const dictOnly = args.includes("--dict-only");
  
  log(`\n${c.bold}=== Pull Books from Server ===${c.reset}\n`);
  
  if (dryRun) {
    log(`${c.yellow}DRY RUN MODE - no files will be downloaded${c.reset}\n`);
  }
  
  // Load selected books
  const selected = loadSelectedBooks();
  log(`${c.cyan}Loaded selection from ${selected.timestamp}${c.reset}`);
  
  // Load global dict books
  const dictBooks = loadGlobalDictBooks();
  log(`  Test books: 5`);
  log(`  Dict books: ${dictBooks.length}`);
  
  // Check SSH connection
  if (!dryRun && !checkSSHConnection()) {
    process.exit(1);
  }
  
  // Ensure output directory exists
  if (!dryRun) {
    fs.mkdirSync(CRAWLER_OUTPUT, { recursive: true });
  }
  
  // Pull books
  if (!dictOnly) {
    pullTestBooks(selected, dryRun);
  }
  
  if (!testOnly && dictBooks.length > 0) {
    pullDictBooks(dictBooks, dryRun);
  }
  
  log(`\n${c.green}${c.bold}Done!${c.reset}`);
  log(`  Next: ${c.cyan}npx tsx select-books.ts --train${c.reset} to train global dictionary.`);
  log(`  Then: ${c.cyan}npx tsx benchmark.ts${c.reset} to run benchmark.\n`);
}

main().catch((err) => {
  log(`\n${c.red}Error: ${err.message}${c.reset}`);
  process.exit(1);
});
