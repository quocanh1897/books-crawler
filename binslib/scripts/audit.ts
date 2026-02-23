/**
 * Audit — scan crawler output and compressed bundles to report
 * download completion and compression status across all books.
 *
 * Usage:
 *   npx tsx scripts/audit.ts
 *   npx tsx scripts/audit.ts --verbose          # list every incomplete / uncompressed book
 *   npx tsx scripts/audit.ts --ids 100114 100267
 *   npx tsx scripts/audit.ts --source mtc       # only MTC books
 *   npx tsx scripts/audit.ts --source ttv       # only TTV books
 */

import fs from "fs";
import path from "path";

// ─── Config ──────────────────────────────────────────────────────────────────

const CRAWLER_OUTPUT =
  process.env.CRAWLER_OUTPUT_DIR ||
  path.resolve(__dirname, "../../crawler/output");
const TTV_CRAWLER_OUTPUT =
  process.env.TTV_CRAWLER_OUTPUT_DIR ||
  path.resolve(__dirname, "../../crawler-tangthuvien/output");
const CHAPTERS_DIR = path.resolve(
  process.env.CHAPTERS_DIR || "./data/compressed",
);

// ─── Bundle header reader ────────────────────────────────────────────────────

const BUNDLE_MAGIC = Buffer.from("BLIB");
const BUNDLE_HEADER_SIZE = 12; // magic(4) + version(4) + count(4)

function readBundleChapterCount(bundlePath: string): number {
  let fd: number;
  try {
    fd = fs.openSync(bundlePath, "r");
  } catch {
    return 0;
  }
  try {
    const hdr = Buffer.alloc(BUNDLE_HEADER_SIZE);
    const bytesRead = fs.readSync(fd, hdr, 0, BUNDLE_HEADER_SIZE, 0);
    if (bytesRead < BUNDLE_HEADER_SIZE) return 0;
    if (!hdr.subarray(0, 4).equals(BUNDLE_MAGIC)) return 0;
    if (hdr.readUInt32LE(4) !== 1) return 0; // version check
    return hdr.readUInt32LE(8);
  } finally {
    fs.closeSync(fd);
  }
}

// ─── CLI args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const VERBOSE = args.includes("--verbose") || args.includes("-v");

const SOURCE_FILTER: "all" | "mtc" | "ttv" = (() => {
  const idx = args.indexOf("--source");
  if (idx === -1 || !args[idx + 1]) return "all";
  const v = args[idx + 1].toLowerCase();
  if (v === "mtc" || v === "ttv") return v;
  return "all";
})();

const SPECIFIC_IDS: Set<string> = (() => {
  const idx = args.indexOf("--ids");
  if (idx === -1) return new Set<string>();
  const ids = new Set<string>();
  for (let i = idx + 1; i < args.length; i++) {
    if (args[i].startsWith("--")) break;
    if (/^\d+$/.test(args[i])) ids.add(args[i]);
  }
  return ids;
})();

// ─── Colors ──────────────────────────────────────────────────────────────────

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
  magenta: "\x1b[35m",
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

function pct(part: number, total: number): string {
  if (total === 0) return "N/A";
  return `${((part / total) * 100).toFixed(1)}%`;
}

// ─── Scan ────────────────────────────────────────────────────────────────────

interface BookEntry {
  bookId: string;
  bookDir: string;
  source: "mtc" | "ttv";
}

function scanNumericDirs(dir: string, source: "mtc" | "ttv"): BookEntry[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((e) => /^\d+$/.test(e))
    .map((e) => ({ bookId: e, bookDir: path.join(dir, e), source }));
}

interface BookAudit {
  bookId: string;
  source: "mtc" | "ttv";
  expectedChapters: number; // from book.json chapters_saved
  txtFiles: number; // actual .txt chapter files on disk
  hasMetadata: boolean; // metadata.json exists
  hasBookJson: boolean; // book.json exists
  hasCover: boolean; // cover.jpg exists
  bundleChapters: number; // chapters in .bundle (0 = no bundle)
  bundleSize: number; // bundle file size in bytes
  txtTotalSize: number; // total size of .txt chapter files
  downloadComplete: boolean;
  fullyCompressed: boolean;
}

function auditBook(entry: BookEntry): BookAudit {
  const { bookId, bookDir, source } = entry;

  // Read book.json for expected chapter count
  let expectedChapters = 0;
  let hasBookJson = false;
  const bookJsonPath = path.join(bookDir, "book.json");
  try {
    if (fs.existsSync(bookJsonPath)) {
      hasBookJson = true;
      const bj = JSON.parse(fs.readFileSync(bookJsonPath, "utf-8"));
      expectedChapters = bj.chapters_saved || 0;
    }
  } catch {
    /* ignore */
  }

  // Count actual .txt chapter files and their total size
  let txtFiles = 0;
  let txtTotalSize = 0;
  try {
    const entries = fs.readdirSync(bookDir);
    for (const f of entries) {
      if (/^\d{4}_/.test(f) && f.endsWith(".txt")) {
        txtFiles++;
        try {
          txtTotalSize += fs.statSync(path.join(bookDir, f)).size;
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* ignore */
  }

  const hasMetadata = fs.existsSync(path.join(bookDir, "metadata.json"));
  const hasCover = fs.existsSync(path.join(bookDir, "cover.jpg"));

  // Check bundle
  const bundlePath = path.join(CHAPTERS_DIR, `${bookId}.bundle`);
  let bundleChapters = 0;
  let bundleSize = 0;
  try {
    if (fs.existsSync(bundlePath)) {
      bundleChapters = readBundleChapterCount(bundlePath);
      bundleSize = fs.statSync(bundlePath).size;
    }
  } catch {
    /* ignore */
  }

  // A book is "download complete" when it has book.json and the .txt file
  // count meets or exceeds the expected chapters_saved value.
  // Books without book.json are counted as incomplete (unknown state).
  const downloadComplete =
    hasBookJson && expectedChapters > 0 && txtFiles >= expectedChapters;

  // A book is "fully compressed" when its bundle contains at least as many
  // chapters as there are .txt source files (i.e. all downloaded chapters
  // are represented in the bundle).
  const fullyCompressed = txtFiles > 0 && bundleChapters >= txtFiles;

  return {
    bookId,
    source,
    expectedChapters,
    txtFiles,
    hasMetadata,
    hasBookJson,
    hasCover,
    bundleChapters,
    bundleSize,
    txtTotalSize,
    downloadComplete,
    fullyCompressed,
  };
}

// ─── Main ────────────────────────────────────────────────────────────────────

function main() {
  const startedAt = Date.now();

  let allEntries: BookEntry[] = [];
  if (SOURCE_FILTER !== "ttv") {
    allEntries.push(...scanNumericDirs(CRAWLER_OUTPUT, "mtc"));
  }
  if (SOURCE_FILTER !== "mtc") {
    allEntries.push(...scanNumericDirs(TTV_CRAWLER_OUTPUT, "ttv"));
  }
  if (SPECIFIC_IDS.size > 0) {
    allEntries = allEntries.filter((e) => SPECIFIC_IDS.has(e.bookId));
  }

  const mtcCount = allEntries.filter((e) => e.source === "mtc").length;
  const ttvCount = allEntries.filter((e) => e.source === "ttv").length;

  process.stdout.write(
    `\n${c.bold}Binslib Audit${c.reset}\n` +
      `  MTC dirs:    ${c.cyan}${formatNum(mtcCount)}${c.reset}\n` +
      `  TTV dirs:    ${c.cyan}${formatNum(ttvCount)}${c.reset}\n` +
      `  Bundles dir: ${c.cyan}${CHAPTERS_DIR}${c.reset}\n` +
      `  Scanning...\n`,
  );

  // Audit every book
  const results: BookAudit[] = [];
  let processed = 0;
  for (const entry of allEntries) {
    results.push(auditBook(entry));
    processed++;
    if (processed % 1000 === 0) {
      process.stdout.write(
        `\r  Scanned ${formatNum(processed)} / ${formatNum(allEntries.length)} books...`,
      );
    }
  }
  process.stdout.write(
    `\r  Scanned ${formatNum(processed)} / ${formatNum(allEntries.length)} books...done\n`,
  );

  // ─── Aggregate stats ──────────────────────────────────────────────────────

  let totalExpected = 0;
  let totalTxtFiles = 0;
  let totalTxtSize = 0;
  let totalBundleChapters = 0;
  let totalBundleSize = 0;

  let booksWithBookJson = 0;
  let booksWithMetadata = 0;
  let booksWithCover = 0;
  let booksDownloadComplete = 0;
  let booksPartialDownload = 0; // has book.json, has some .txt, but not all
  let booksNoChapters = 0; // has dir but 0 .txt files
  let booksNoBookJson = 0;
  let booksWithBundle = 0;
  let booksFullyCompressed = 0;
  let booksPartiallyCompressed = 0; // bundle exists but fewer chapters than .txt

  const incomplete: BookAudit[] = [];
  const uncompressed: BookAudit[] = [];

  for (const r of results) {
    totalExpected += r.expectedChapters;
    totalTxtFiles += r.txtFiles;
    totalTxtSize += r.txtTotalSize;
    totalBundleChapters += r.bundleChapters;
    totalBundleSize += r.bundleSize;

    if (r.hasBookJson) booksWithBookJson++;
    else booksNoBookJson++;
    if (r.hasMetadata) booksWithMetadata++;
    if (r.hasCover) booksWithCover++;

    if (r.txtFiles === 0) {
      booksNoChapters++;
    } else if (r.downloadComplete) {
      booksDownloadComplete++;
    } else {
      booksPartialDownload++;
      incomplete.push(r);
    }

    if (r.bundleChapters > 0) {
      booksWithBundle++;
      if (r.fullyCompressed) {
        booksFullyCompressed++;
      } else {
        booksPartiallyCompressed++;
      }
    }
    if (r.txtFiles > 0 && !r.fullyCompressed) {
      uncompressed.push(r);
    }
  }

  const duration = Date.now() - startedAt;

  // ─── Report ────────────────────────────────────────────────────────────────

  const border = `${c.blue}┌${"─".repeat(60)}┐${c.reset}`;
  const bottom = `${c.blue}└${"─".repeat(60)}┘${c.reset}`;
  const sep = `${c.blue}├${"─".repeat(60)}┤${c.reset}`;
  const row = (label: string, value: string, color = c.white) =>
    `${c.blue}│${c.reset}  ${label.padEnd(32)}${color}${value.padStart(24)}${c.reset}  ${c.blue}│${c.reset}`;
  const header = (text: string) =>
    `${c.blue}│${c.reset}${c.bold}${c.cyan}  ${text.padEnd(58)}${c.reset}${c.blue}│${c.reset}`;

  const lines = [
    "",
    border,
    `${c.blue}│${c.reset}${c.bold}              Binslib Library Audit                         ${c.reset}${c.blue}│${c.reset}`,
    sep,
    header("DOWNLOAD STATUS"),
    sep,
    row("Total book directories:", formatNum(allEntries.length)),
    row("  MTC:", formatNum(mtcCount)),
    row("  TTV:", formatNum(ttvCount)),
    sep,
    row(
      "Download complete:",
      `${formatNum(booksDownloadComplete)}  (${pct(booksDownloadComplete, allEntries.length)})`,
      c.green,
    ),
    row(
      "Partial download:",
      `${formatNum(booksPartialDownload)}  (${pct(booksPartialDownload, allEntries.length)})`,
      booksPartialDownload > 0 ? c.yellow : c.white,
    ),
    row(
      "No chapters (empty dir):",
      `${formatNum(booksNoChapters)}  (${pct(booksNoChapters, allEntries.length)})`,
      booksNoChapters > 0 ? c.red : c.white,
    ),
    row(
      "Missing book.json:",
      formatNum(booksNoBookJson),
      booksNoBookJson > 0 ? c.yellow : c.white,
    ),
    sep,
    row("Expected chapters (book.json):", formatNum(totalExpected)),
    row("Actual .txt files on disk:", formatNum(totalTxtFiles)),
    row(
      "Chapter deficit:",
      formatNum(Math.max(0, totalExpected - totalTxtFiles)),
      totalExpected > totalTxtFiles ? c.red : c.green,
    ),
    row("Total .txt size:", formatBytes(totalTxtSize)),
    sep,
    header("METADATA & ASSETS"),
    sep,
    row(
      "Have metadata.json:",
      `${formatNum(booksWithMetadata)}  (${pct(booksWithMetadata, allEntries.length)})`,
    ),
    row(
      "Missing metadata.json:",
      formatNum(allEntries.length - booksWithMetadata),
      allEntries.length - booksWithMetadata > 0 ? c.yellow : c.white,
    ),
    row(
      "Have cover.jpg:",
      `${formatNum(booksWithCover)}  (${pct(booksWithCover, allEntries.length)})`,
    ),
    sep,
    header("COMPRESSION STATUS (.bundle)"),
    sep,
    row(
      "Books with .bundle:",
      `${formatNum(booksWithBundle)}  (${pct(booksWithBundle, allEntries.length)})`,
    ),
    row(
      "Fully compressed:",
      `${formatNum(booksFullyCompressed)}  (${pct(booksFullyCompressed, allEntries.length)})`,
      c.green,
    ),
    row(
      "Partially compressed:",
      formatNum(booksPartiallyCompressed),
      booksPartiallyCompressed > 0 ? c.yellow : c.white,
    ),
    row(
      "Not compressed:",
      `${formatNum(uncompressed.length)}  (${pct(uncompressed.length, allEntries.length)})`,
      uncompressed.length > 0 ? c.red : c.green,
    ),
    sep,
    row("Chapters in bundles:", formatNum(totalBundleChapters)),
    row("Total bundle size:", formatBytes(totalBundleSize)),
    row(
      "Compression ratio:",
      totalTxtSize > 0 && totalBundleSize > 0
        ? `${((1 - totalBundleSize / totalTxtSize) * 100).toFixed(1)}%`
        : "N/A",
    ),
    sep,
    row("Scan duration:", `${(duration / 1000).toFixed(1)}s`, c.dim),
    bottom,
  ];

  for (const line of lines) process.stdout.write(line + "\n");

  // ─── Verbose lists ─────────────────────────────────────────────────────────

  if (VERBOSE) {
    if (incomplete.length > 0) {
      // Sort by deficit descending
      incomplete.sort(
        (a, b) =>
          b.expectedChapters - b.txtFiles - (a.expectedChapters - a.txtFiles),
      );
      const show = incomplete.slice(0, 50);
      process.stdout.write(
        `\n${c.yellow}${c.bold}Incomplete downloads (${formatNum(incomplete.length)} books):${c.reset}\n`,
      );
      process.stdout.write(
        `  ${"Book ID".padEnd(12)}${"Source".padEnd(8)}${"Expected".padStart(10)}${"On disk".padStart(10)}${"Deficit".padStart(10)}${"   Status"}\n`,
      );
      process.stdout.write(`  ${"─".repeat(66)}\n`);
      for (const r of show) {
        const deficit = r.expectedChapters - r.txtFiles;
        const status = r.hasMetadata ? "" : " (no metadata)";
        process.stdout.write(
          `  ${r.bookId.padEnd(12)}${r.source.padEnd(8)}${formatNum(r.expectedChapters).padStart(10)}${formatNum(r.txtFiles).padStart(10)}${c.red}${formatNum(deficit).padStart(10)}${c.reset}${c.dim}${status}${c.reset}\n`,
        );
      }
      if (incomplete.length > 50) {
        process.stdout.write(
          `  ${c.dim}... and ${formatNum(incomplete.length - 50)} more${c.reset}\n`,
        );
      }
    }

    if (uncompressed.length > 0) {
      // Sort by txt file count descending (biggest uncompressed books first)
      const notCompressed = uncompressed.filter((r) => r.bundleChapters === 0);
      notCompressed.sort((a, b) => b.txtFiles - a.txtFiles);
      const show = notCompressed.slice(0, 50);
      if (show.length > 0) {
        process.stdout.write(
          `\n${c.red}${c.bold}Not compressed (${formatNum(notCompressed.length)} books, no .bundle):${c.reset}\n`,
        );
        process.stdout.write(
          `  ${"Book ID".padEnd(12)}${"Source".padEnd(8)}${"Chapters".padStart(10)}${"Size".padStart(12)}\n`,
        );
        process.stdout.write(`  ${"─".repeat(42)}\n`);
        for (const r of show) {
          process.stdout.write(
            `  ${r.bookId.padEnd(12)}${r.source.padEnd(8)}${formatNum(r.txtFiles).padStart(10)}${formatBytes(r.txtTotalSize).padStart(12)}\n`,
          );
        }
        if (notCompressed.length > 50) {
          process.stdout.write(
            `  ${c.dim}... and ${formatNum(notCompressed.length - 50)} more${c.reset}\n`,
          );
        }
      }
    }
  } else if (incomplete.length > 0 || uncompressed.length > 0) {
    process.stdout.write(
      `\n  ${c.dim}Run with ${c.white}--verbose${c.dim} to list individual incomplete / uncompressed books.${c.reset}\n`,
    );
  }

  process.stdout.write("\n");
}

main();
