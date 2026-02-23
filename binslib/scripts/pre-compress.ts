/**
 * Pre-compress — parallel chapter compression from crawler output files
 *
 * Reads .txt chapter files from crawler/output and crawler-tangthuvien/output,
 * compresses them with zstd in parallel using worker threads, and writes to
 * data/compressed/{book_id}.bundle (per-book bundle format).
 *
 * This is an optional step before import. The import script will detect
 * pre-compressed bundles and skip compression for those books, only
 * inserting metadata into SQLite.
 *
 * Progress:
 *   - Dual progress bars: books and chapters
 *   - Real-time detail log: data/pre-compress-detail.log (per-book stats)
 *   - Summary log: data/pre-compress-log.txt
 *
 * Usage:
 *   npx tsx scripts/pre-compress.ts
 *   npx tsx scripts/pre-compress.ts --workers 6    # default: CPU count
 *   npx tsx scripts/pre-compress.ts --ids 110007 102205
 *   npx tsx scripts/pre-compress.ts --dry-run
 *   npx tsx scripts/pre-compress.ts --quiet
 */

import fs from "fs";
import path from "path";
import os from "os";
import { Worker, isMainThread, parentPort, workerData } from "worker_threads";
import { Compressor } from "zstd-napi";

// ─── Bundle format constants (must match src/lib/chapter-storage.ts) ─────────

const BUNDLE_MAGIC = Buffer.from("BLIB");
const BUNDLE_VERSION = 1;
const BUNDLE_HEADER_SIZE = 12; // magic(4) + version(4) + count(4)
const BUNDLE_ENTRY_SIZE = 16; // indexNum(4) + offset(4) + compLen(4) + rawLen(4)

// ─── Worker Thread ───────────────────────────────────────────────────────────

if (!isMainThread) {
  const { books, chaptersDir, dryRun, dictPath } = workerData as {
    books: { bookId: string; bookDir: string }[];
    chaptersDir: string;
    dryRun: boolean;
    dictPath: string | null;
  };

  // Initialize compressor with dictionary for this worker
  const compressor = new Compressor();
  compressor.setParameters({ compressionLevel: 3 });
  if (!dictPath || !fs.existsSync(dictPath)) {
    parentPort!.postMessage({
      type: "done",
      exported: 0,
      skipped: 0,
      failed: 0,
      bytesWritten: 0,
      bytesRead: 0,
      failures: [
        {
          bookId: "N/A",
          file: "N/A",
          error: `FATAL: dictionary not found: ${dictPath}`,
        },
      ],
    });
    process.exit(1);
  }
  compressor.loadDictionary(fs.readFileSync(dictPath));

  let exported = 0;
  let skipped = 0;
  let failed = 0;
  let bytesWritten = 0;
  let bytesRead = 0;
  const failures: { bookId: string; file: string; error: string }[] = [];

  /**
   * Read the chapter count from an existing .bundle file header.
   * Returns 0 if the bundle doesn't exist or is invalid.
   */
  function readBundleChapterCount(bundlePath: string): number {
    let fd: number;
    try {
      fd = fs.openSync(bundlePath, "r");
    } catch {
      return 0;
    }
    try {
      const hdr = Buffer.alloc(BUNDLE_HEADER_SIZE);
      const read = fs.readSync(fd, hdr, 0, BUNDLE_HEADER_SIZE, 0);
      if (read < BUNDLE_HEADER_SIZE) return 0;
      if (!hdr.subarray(0, 4).equals(BUNDLE_MAGIC)) return 0;
      if (hdr.readUInt32LE(4) !== BUNDLE_VERSION) return 0;
      return hdr.readUInt32LE(8);
    } finally {
      fs.closeSync(fd);
    }
  }

  /**
   * Write a per-book bundle from a map of chapter data.
   * Matches the BLIB format from chapter-storage.ts.
   */
  function writeBundle(
    bundlePath: string,
    chapters: Map<number, { compressed: Buffer; rawLen: number }>,
  ): number {
    if (chapters.size === 0) return 0;

    const sorted = [...chapters.entries()].sort((a, b) => a[0] - b[0]);
    const count = sorted.length;
    const dataStart = BUNDLE_HEADER_SIZE + count * BUNDLE_ENTRY_SIZE;

    // Compute layout
    const layout: {
      indexNum: number;
      offset: number;
      compLen: number;
      rawLen: number;
      compressed: Buffer;
    }[] = [];
    let cursor = dataStart;
    for (const [indexNum, { compressed, rawLen }] of sorted) {
      layout.push({
        indexNum,
        offset: cursor,
        compLen: compressed.length,
        rawLen,
        compressed,
      });
      cursor += compressed.length;
    }

    // Assemble file buffer
    const buf = Buffer.alloc(cursor);
    BUNDLE_MAGIC.copy(buf, 0);
    buf.writeUInt32LE(BUNDLE_VERSION, 4);
    buf.writeUInt32LE(count, 8);

    for (let i = 0; i < layout.length; i++) {
      const base = BUNDLE_HEADER_SIZE + i * BUNDLE_ENTRY_SIZE;
      const e = layout[i];
      buf.writeUInt32LE(e.indexNum, base);
      buf.writeUInt32LE(e.offset, base + 4);
      buf.writeUInt32LE(e.compLen, base + 8);
      buf.writeUInt32LE(e.rawLen, base + 12);
    }

    for (const e of layout) {
      e.compressed.copy(buf, e.offset);
    }

    // Atomic write: temp → rename
    const tmpPath = bundlePath + `.tmp.${process.pid}`;
    try {
      fs.writeFileSync(tmpPath, buf);
      fs.renameSync(tmpPath, bundlePath);
    } catch (err) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        /* ignore */
      }
      throw err;
    }

    return buf.length;
  }

  for (const { bookId, bookDir } of books) {
    const chapterFiles = fs
      .readdirSync(bookDir)
      .filter((f: string) => /^\d{4}_/.test(f) && f.endsWith(".txt"))
      .sort();

    if (chapterFiles.length === 0) {
      parentPort!.postMessage({
        type: "book_done",
        bookId,
        chapters: 0,
        exported: 0,
        skipped: 0,
        failed: 0,
      });
      continue;
    }

    const bundlePath = path.join(chaptersDir, `${bookId}.bundle`);

    // Skip if bundle already has all chapters
    const existingCount = readBundleChapterCount(bundlePath);
    if (existingCount >= chapterFiles.length) {
      skipped += chapterFiles.length;
      parentPort!.postMessage({
        type: "book_done",
        bookId,
        chapters: chapterFiles.length,
        exported: 0,
        skipped: chapterFiles.length,
        failed: 0,
      });
      continue;
    }

    if (dryRun) {
      exported += chapterFiles.length;
      parentPort!.postMessage({
        type: "book_done",
        bookId,
        chapters: chapterFiles.length,
        exported: chapterFiles.length,
        skipped: 0,
        failed: 0,
      });
      continue;
    }

    // Collect all chapters for this book into memory, then write one bundle
    const chaptersMap = new Map<
      number,
      { compressed: Buffer; rawLen: number }
    >();
    let bookExported = 0;
    let bookFailed = 0;

    for (const file of chapterFiles) {
      const match = file.match(/^(\d+)_(.+)\.txt$/);
      if (!match) continue;
      const indexNum = parseInt(match[1], 10);

      try {
        const srcPath = path.join(bookDir, file);
        const content = fs.readFileSync(srcPath, "utf-8");
        const srcSize = Buffer.byteLength(content, "utf-8");
        bytesRead += srcSize;

        const lines = content.split("\n");
        const title = lines[0]?.trim() || "";
        let bodyStart = 1;
        while (bodyStart < lines.length && lines[bodyStart].trim() === "")
          bodyStart++;
        if (bodyStart < lines.length && lines[bodyStart].trim() === title)
          bodyStart++;
        const body = lines.slice(bodyStart).join("\n").trim();

        const raw = Buffer.from(body, "utf-8");
        const compressed = compressor.compress(raw);
        chaptersMap.set(indexNum, { compressed, rawLen: raw.length });
        bookExported++;
      } catch (err) {
        bookFailed++;
        failed++;
        failures.push({
          bookId,
          file,
          error: (err as Error).message?.slice(0, 120) || "Unknown",
        });
      }
    }

    // Write the single bundle file for this book
    if (chaptersMap.size > 0) {
      try {
        fs.mkdirSync(chaptersDir, { recursive: true });
        const bundleSize = writeBundle(bundlePath, chaptersMap);
        bytesWritten += bundleSize;
        exported += bookExported;
      } catch (err) {
        // If bundle write itself fails, count all chapters as failed
        failed += bookExported;
        exported -= 0; // didn't add yet
        bookFailed += bookExported;
        bookExported = 0;
        failures.push({
          bookId,
          file: `${bookId}.bundle`,
          error: (err as Error).message?.slice(0, 120) || "Bundle write failed",
        });
      }
    }

    parentPort!.postMessage({
      type: "book_done",
      bookId,
      chapters: chapterFiles.length,
      exported: bookExported,
      skipped: 0,
      failed: bookFailed,
    });
  }

  parentPort!.postMessage({
    type: "done",
    exported,
    skipped,
    failed,
    bytesWritten,
    bytesRead,
    failures,
  });

  process.exit(0);
}

// ─── Main Thread ─────────────────────────────────────────────────────────────

import cliProgress from "cli-progress";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const QUIET = args.includes("--quiet");

const SPECIFIC_IDS: string[] = (() => {
  const idx = args.indexOf("--ids");
  if (idx === -1) return [];
  const ids: string[] = [];
  for (let i = idx + 1; i < args.length; i++) {
    if (args[i].startsWith("--")) break;
    if (/^\d+$/.test(args[i])) ids.push(args[i]);
  }
  return ids;
})();

function getArgValue(flag: string, defaultVal: string): string {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : defaultVal;
}

const NUM_WORKERS = Math.max(
  1,
  parseInt(getArgValue("--workers", String(os.cpus().length)), 10),
);

const CRAWLER_OUTPUT =
  process.env.CRAWLER_OUTPUT_DIR ||
  path.resolve(__dirname, "../../crawler/output");
const TTV_CRAWLER_OUTPUT =
  process.env.TTV_CRAWLER_OUTPUT_DIR ||
  path.resolve(__dirname, "../../crawler-tangthuvien/output");
const CHAPTERS_DIR = path.resolve(
  process.env.CHAPTERS_DIR || "./data/compressed",
);
const DICT_PATH = path.resolve(
  process.env.ZSTD_DICT_PATH || "./data/global.dict",
);
if (!fs.existsSync(DICT_PATH)) {
  process.stderr.write(
    `\n\x1b[31m\x1b[1mFATAL:\x1b[0m Global zstd dictionary not found: ${DICT_PATH}\n` +
      `  Pre-compress requires a dictionary for consistent compression.\n` +
      `  Place a dictionary at data/global.dict or set ZSTD_DICT_PATH.\n\n`,
  );
  process.exit(1);
}
const LOG_FILE = path.resolve(__dirname, "../data/pre-compress-log.txt");

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  blue: "\x1b[34m",
  white: "\x1b[37m",
};

function log(msg: string) {
  if (!QUIET) process.stdout.write(msg + "\n");
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const sec = s % 60;
  if (m < 60) return `${m}m ${sec}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ${sec}s`;
}

function formatNum(n: number): string {
  return n.toLocaleString("en-US");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function timestamp(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function scanBookDirs(dir: string): { bookId: string; bookDir: string }[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((e) => /^\d+$/.test(e))
    .map((e) => ({ bookId: e, bookDir: path.join(dir, e) }));
}

// ─── Scan ────────────────────────────────────────────────────────────────────

const startedAt = Date.now();

let allBooks = [
  ...scanBookDirs(CRAWLER_OUTPUT),
  ...scanBookDirs(TTV_CRAWLER_OUTPUT),
];

if (SPECIFIC_IDS.length > 0) {
  const idSet = new Set(SPECIFIC_IDS);
  allBooks = allBooks.filter((b) => idSet.has(b.bookId));
}

log(
  `\n${c.bold}[${timestamp()}] Parallel chapter export from crawler files${c.reset}`,
);
log(`  Sources: ${c.cyan}${CRAWLER_OUTPUT}${c.reset}`);
log(`           ${c.cyan}${TTV_CRAWLER_OUTPUT}${c.reset}`);
log(`  Target:  ${c.cyan}${CHAPTERS_DIR}${c.reset}`);
log(`  Books:   ${c.cyan}${formatNum(allBooks.length)}${c.reset}`);
log(`  Workers: ${c.cyan}${NUM_WORKERS}${c.reset}`);
log(`  Dry run: ${DRY_RUN ? "yes" : "no"}`);
log("");

// Estimate chapter counts from metadata (avoids expensive readdirSync scans)
log(`  ${c.dim}Estimating chapter counts...${c.reset}`);
let totalChapters = 0;
for (const { bookDir } of allBooks) {
  try {
    const metaPath = path.join(bookDir, "metadata.json");
    const bookJsonPath = path.join(bookDir, "book.json");
    if (fs.existsSync(metaPath)) {
      const mj = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
      totalChapters += mj.chapter_count || mj.chapters_saved || 0;
    } else if (fs.existsSync(bookJsonPath)) {
      const bj = JSON.parse(fs.readFileSync(bookJsonPath, "utf-8"));
      totalChapters += bj.chapters_saved || bj.chapter_count || 0;
    }
  } catch {
    /* use 0 */
  }
}
log(
  `  Total chapters (estimated): ${c.cyan}${formatNum(totalChapters)}${c.reset}\n`,
);

// ─── Split work across workers ───────────────────────────────────────────────

const chunks: { bookId: string; bookDir: string }[][] = Array.from(
  { length: NUM_WORKERS },
  () => [],
);
for (let i = 0; i < allBooks.length; i++) {
  chunks[i % NUM_WORKERS].push(allBooks[i]);
}

// ─── Launch workers ──────────────────────────────────────────────────────────

const DETAIL_LOG_FILE = path.resolve(
  __dirname,
  "../data/pre-compress-detail.log",
);

// Initialize detail log
fs.mkdirSync(path.dirname(DETAIL_LOG_FILE), { recursive: true });
fs.appendFileSync(
  DETAIL_LOG_FILE,
  `\n${"=".repeat(60)}\n[${timestamp()}] Pre-compress started - ${formatNum(allBooks.length)} books, ~${formatNum(totalChapters)} chapters\n${"=".repeat(60)}\n`,
);

const multiBar = QUIET
  ? null
  : new cliProgress.MultiBar({
      clearOnComplete: false,
      hideCursor: true,
      format: `  {name}  ${c.green}{bar}${c.reset} {value}/{total}  {percentage}%  ETA: {eta_formatted}  ${c.dim}{detail}${c.reset}`,
      barsize: 20,
    });

const bookBar = multiBar?.create(allBooks.length, 0, {
  name: "Books   ",
  detail: "starting...",
});
const chapterBar = multiBar?.create(totalChapters || 1, 0, {
  name: "Chapters",
  detail: "",
});
if (chapterBar && totalChapters > 0) chapterBar.setTotal(totalChapters);

let booksProcessed = 0;
let chaptersProcessed = 0;
let totalExported = 0;
let totalSkipped = 0;
let totalFailed = 0;
let totalBytesWritten = 0;
let totalBytesRead = 0;
const allFailures: { bookId: string; file: string; error: string }[] = [];
let workersFinished = 0;

function logDetail(msg: string) {
  fs.appendFileSync(DETAIL_LOG_FILE, `[${timestamp()}] ${msg}\n`);
}

const workerPromises = chunks.map((chunk, idx) => {
  if (chunk.length === 0) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    const worker = new Worker(__filename, {
      workerData: {
        books: chunk,
        chaptersDir: CHAPTERS_DIR,
        dryRun: DRY_RUN,
        dictPath: DICT_PATH,
      },
      execArgv: ["--require", "tsx/cjs"],
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    worker.on("message", (msg: any) => {
      if (msg.type === "book_done") {
        booksProcessed++;
        chaptersProcessed += msg.chapters;
        bookBar?.update(booksProcessed, {
          detail: `book ${msg.bookId}`,
        });
        chapterBar?.update(chaptersProcessed, {
          detail: `+${msg.exported} new, ${msg.skipped} skip`,
        });
        // Real-time logging
        if (msg.exported > 0 || msg.failed > 0) {
          logDetail(
            `Book ${msg.bookId}: ${msg.chapters} ch, exported=${msg.exported}, skipped=${msg.skipped}, failed=${msg.failed}`,
          );
        }
      } else if (msg.type === "done") {
        totalExported += msg.exported;
        totalSkipped += msg.skipped;
        totalFailed += msg.failed;
        totalBytesWritten += msg.bytesWritten;
        totalBytesRead += msg.bytesRead;
        allFailures.push(...msg.failures);
        workersFinished++;
      }
    });

    worker.on("error", reject);
    worker.on("exit", (code) => {
      if (code !== 0)
        reject(new Error(`Worker ${idx} exited with code ${code}`));
      else resolve();
    });
  });
});

Promise.all(workerPromises)
  .then(() => {
    bookBar?.update(allBooks.length, { detail: "done" });
    chapterBar?.update(totalChapters, { detail: "done" });
    multiBar?.stop();

    const duration = Date.now() - startedAt;

    // ─── Report ──────────────────────────────────────────────────────
    const border = `${c.blue}┌${"─".repeat(52)}┐${c.reset}`;
    const bottom = `${c.blue}└${"─".repeat(52)}┘${c.reset}`;
    const sep = `${c.blue}├${"─".repeat(52)}┤${c.reset}`;
    const row = (label: string, value: string, color = c.white) =>
      `${c.blue}│${c.reset}  ${label.padEnd(24)}${color}${value.padStart(24)}${c.reset}  ${c.blue}│${c.reset}`;

    const lines = [
      "",
      border,
      `${c.blue}│${c.reset}${c.bold}     Pre-compress Report                             ${c.reset}${c.blue}│${c.reset}`,
      sep,
      row("Mode:", DRY_RUN ? "dry-run" : "export"),
      row("Workers:", String(NUM_WORKERS)),
      row("Started:", timestamp()),
      row("Duration:", formatDuration(duration)),
      sep,
      row("Books processed:", formatNum(allBooks.length)),
      row("Chapters exported:", formatNum(totalExported), c.green),
      row("Chapters skipped:", formatNum(totalSkipped), c.yellow),
      row(
        "Chapters failed:",
        formatNum(totalFailed),
        totalFailed > 0 ? c.red : c.white,
      ),
      sep,
      row("Source read:", formatBytes(totalBytesRead)),
      row("Bundles written:", formatBytes(totalBytesWritten), c.green),
      row(
        "Compression ratio:",
        totalBytesRead > 0
          ? `${((1 - totalBytesWritten / totalBytesRead) * 100).toFixed(1)}%`
          : "N/A",
      ),
      row(
        "Throughput:",
        duration > 0
          ? `${formatBytes(totalBytesRead / (duration / 1000))}/s`
          : "N/A",
      ),
      bottom,
    ];

    if (!QUIET) {
      for (const line of lines) process.stdout.write(line + "\n");
    }

    if (allFailures.length > 0) {
      log(`\n${c.red}${c.bold}Failed:${c.reset}`);
      for (const f of allFailures.slice(0, 20)) {
        log(`  ${c.red}•${c.reset} ${f.bookId}/${f.file}: ${f.error}`);
      }
      if (allFailures.length > 20)
        log(`  ${c.dim}... and ${allFailures.length - 20} more${c.reset}`);
    }

    const entry = [
      `[${timestamp()}] pre-compress workers=${NUM_WORKERS} duration=${formatDuration(duration)}`,
      `  books=${allBooks.length} exported=${totalExported} skipped=${totalSkipped} failed=${totalFailed}`,
      `  read=${formatBytes(totalBytesRead)} written=${formatBytes(totalBytesWritten)}`,
      "",
    ].join("\n");
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, entry);

    // Write summary to detail log
    logDetail(`${"=".repeat(60)}`);
    logDetail(
      `COMPLETED: ${formatNum(totalExported)} compressed, ${formatNum(totalSkipped)} skipped, ${formatNum(totalFailed)} failed`,
    );
    logDetail(
      `Duration: ${formatDuration(duration)}, Read: ${formatBytes(totalBytesRead)}, Written: ${formatBytes(totalBytesWritten)}`,
    );
    logDetail(`${"=".repeat(60)}\n`);

    log(`\n  ${c.cyan}Detail log:${c.reset} ${DETAIL_LOG_FILE}\n`);

    if (totalFailed > 0) process.exit(1);
  })
  .catch((err) => {
    multiBar?.stop();
    log(`\n${c.red}${c.bold}Fatal error:${c.reset} ${err.message}`);
    logDetail(`FATAL ERROR: ${err.message}`);
    process.exit(1);
  });
