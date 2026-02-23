/**
 * Audit Safe Delete — verify every compressed chapter has an original .txt source
 *
 * Scans all .bundle files and legacy .zst/.gz directories in data/compressed/,
 * then checks that every chapter index has a matching .txt file in the crawler
 * output directories. Reports any "orphaned" chapters that would be lost if
 * the compressed files were deleted.
 *
 * Usage:
 *   npx tsx scripts/is-safe-to-delete.ts
 *   npx tsx scripts/is-safe-to-delete.ts --verbose
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

const VERBOSE = process.argv.includes("--verbose") || process.argv.includes("-v");

// ─── Bundle format constants ─────────────────────────────────────────────────

const BUNDLE_MAGIC = Buffer.from("BLIB");
const BUNDLE_HEADER_SIZE = 12; // magic(4) + version(4) + count(4)
const BUNDLE_ENTRY_SIZE = 16;  // indexNum(4) + offset(4) + compLen(4) + rawLen(4)

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
};

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

// ─── Bundle reader ───────────────────────────────────────────────────────────

function readBundleIndices(bundlePath: string): number[] {
  let fd: number;
  try {
    fd = fs.openSync(bundlePath, "r");
  } catch {
    return [];
  }
  try {
    const hdr = Buffer.alloc(BUNDLE_HEADER_SIZE);
    const bytesRead = fs.readSync(fd, hdr, 0, BUNDLE_HEADER_SIZE, 0);
    if (bytesRead < BUNDLE_HEADER_SIZE) return [];
    if (!hdr.subarray(0, 4).equals(BUNDLE_MAGIC)) return [];
    if (hdr.readUInt32LE(4) !== 1) return [];
    const count = hdr.readUInt32LE(8);
    if (count === 0) return [];

    const indexBufSize = count * BUNDLE_ENTRY_SIZE;
    const indexBuf = Buffer.alloc(indexBufSize);
    const idxRead = fs.readSync(fd, indexBuf, 0, indexBufSize, BUNDLE_HEADER_SIZE);
    if (idxRead < indexBufSize) return [];

    const indices: number[] = [];
    for (let i = 0; i < count; i++) {
      indices.push(indexBuf.readUInt32LE(i * BUNDLE_ENTRY_SIZE));
    }
    return indices;
  } finally {
    fs.closeSync(fd);
  }
}

// ─── Legacy .zst/.gz reader ─────────────────────────────────────────────────

function readLegacyIndices(legacyDir: string): number[] {
  try {
    if (!fs.statSync(legacyDir).isDirectory()) return [];
  } catch {
    return [];
  }
  const indices: number[] = [];
  for (const file of fs.readdirSync(legacyDir)) {
    const match = file.match(/^(\d+)\.txt\.(zst|gz)$/);
    if (match) indices.push(parseInt(match[1], 10));
  }
  return indices;
}

// ─── Crawler .txt index reader ───────────────────────────────────────────────

function readCrawlerTxtIndices(bookId: string): Set<number> {
  const indices = new Set<number>();

  for (const crawlerDir of [CRAWLER_OUTPUT, TTV_CRAWLER_OUTPUT]) {
    const bookDir = path.join(crawlerDir, bookId);
    try {
      if (!fs.statSync(bookDir).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const file of fs.readdirSync(bookDir)) {
      const match = file.match(/^(\d{4})_.*\.txt$/);
      if (match) indices.add(parseInt(match[1], 10));
    }
  }

  return indices;
}

// ─── Main ────────────────────────────────────────────────────────────────────

function main() {
  const startedAt = Date.now();

  if (!fs.existsSync(CHAPTERS_DIR)) {
    console.log(`\n${c.yellow}No compressed directory found at ${CHAPTERS_DIR}${c.reset}\n`);
    process.exit(0);
  }

  console.log(`\n${c.bold}Audit: Safe to delete compressed files?${c.reset}`);
  console.log(`  Compressed: ${c.cyan}${CHAPTERS_DIR}${c.reset}`);
  console.log(`  MTC source: ${c.cyan}${CRAWLER_OUTPUT}${c.reset}`);
  console.log(`  TTV source: ${c.cyan}${TTV_CRAWLER_OUTPUT}${c.reset}`);
  console.log(`  Scanning...\n`);

  // Discover all book IDs that have compressed data (bundles or legacy dirs)
  const entries = fs.readdirSync(CHAPTERS_DIR);
  const bookIds = new Set<string>();
  for (const entry of entries) {
    const bundleMatch = entry.match(/^(\d+)\.bundle$/);
    if (bundleMatch) {
      bookIds.add(bundleMatch[1]);
      continue;
    }
    // Legacy directory
    if (/^\d+$/.test(entry)) {
      const full = path.join(CHAPTERS_DIR, entry);
      try {
        if (fs.statSync(full).isDirectory()) bookIds.add(entry);
      } catch { /* ignore */ }
    }
  }

  const sortedIds = [...bookIds].sort((a, b) => parseInt(a) - parseInt(b));

  // Stats
  let totalBooks = 0;
  let totalBundleChapters = 0;
  let totalLegacyChapters = 0;
  let totalCompressedChapters = 0; // deduplicated per book
  let totalCoveredByTxt = 0;
  let totalOrphaned = 0;

  let booksSafe = 0;
  let booksOrphaned = 0;
  let booksNoSource = 0; // no crawler dir at all

  let totalBundleBytes = 0;
  let totalLegacyBytes = 0;
  let safeBundleBytes = 0;
  let safeLegacyBytes = 0;

  const orphanedBooks: {
    bookId: string;
    orphanedIndices: number[];
    compressedCount: number;
    txtCount: number;
  }[] = [];

  let processed = 0;
  for (const bookId of sortedIds) {
    totalBooks++;
    processed++;
    if (processed % 50 === 0) {
      process.stdout.write(`\r  Checked ${formatNum(processed)} / ${formatNum(sortedIds.length)} books...`);
    }

    // Gather all compressed chapter indices for this book
    const compressedIndices = new Set<number>();

    // From bundle
    const bundlePath = path.join(CHAPTERS_DIR, `${bookId}.bundle`);
    let bundleSize = 0;
    const bundleIndices = readBundleIndices(bundlePath);
    totalBundleChapters += bundleIndices.length;
    for (const idx of bundleIndices) compressedIndices.add(idx);
    try {
      bundleSize = fs.statSync(bundlePath).size;
      totalBundleBytes += bundleSize;
    } catch { /* no bundle */ }

    // From legacy dir
    const legacyDir = path.join(CHAPTERS_DIR, bookId);
    let legacySize = 0;
    const legacyIndices = readLegacyIndices(legacyDir);
    totalLegacyChapters += legacyIndices.length;
    for (const idx of legacyIndices) compressedIndices.add(idx);
    if (legacyIndices.length > 0) {
      try {
        for (const file of fs.readdirSync(legacyDir)) {
          try {
            legacySize += fs.statSync(path.join(legacyDir, file)).size;
          } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
      totalLegacyBytes += legacySize;
    }

    totalCompressedChapters += compressedIndices.size;

    // Check against crawler .txt sources
    const txtIndices = readCrawlerTxtIndices(bookId);

    if (txtIndices.size === 0 && compressedIndices.size > 0) {
      // No crawler source at all for this book
      booksNoSource++;
      booksOrphaned++;
      const orphaned = [...compressedIndices].sort((a, b) => a - b);
      totalOrphaned += orphaned.length;
      orphanedBooks.push({
        bookId,
        orphanedIndices: orphaned,
        compressedCount: compressedIndices.size,
        txtCount: 0,
      });
      continue;
    }

    // Find orphaned chapters: in compressed but not in any crawler .txt
    const orphaned: number[] = [];
    for (const idx of compressedIndices) {
      if (txtIndices.has(idx)) {
        totalCoveredByTxt++;
      } else {
        orphaned.push(idx);
        totalOrphaned++;
      }
    }

    if (orphaned.length > 0) {
      booksOrphaned++;
      orphanedBooks.push({
        bookId,
        orphanedIndices: orphaned.sort((a, b) => a - b),
        compressedCount: compressedIndices.size,
        txtCount: txtIndices.size,
      });
    } else {
      booksSafe++;
      safeBundleBytes += bundleSize;
      safeLegacyBytes += legacySize;
    }
  }

  process.stdout.write(`\r  Checked ${formatNum(processed)} / ${formatNum(sortedIds.length)} books...done\n`);

  const duration = Date.now() - startedAt;
  const allSafe = totalOrphaned === 0;

  // ─── Report ────────────────────────────────────────────────────────────────

  const border = `${c.blue}┌${"─".repeat(60)}┐${c.reset}`;
  const bottom = `${c.blue}└${"─".repeat(60)}┘${c.reset}`;
  const sep    = `${c.blue}├${"─".repeat(60)}┤${c.reset}`;
  const row = (label: string, value: string, color = c.white) =>
    `${c.blue}│${c.reset}  ${label.padEnd(34)}${color}${value.padStart(22)}${c.reset}  ${c.blue}│${c.reset}`;
  const header = (text: string) =>
    `${c.blue}│${c.reset}${c.bold}${c.cyan}  ${text.padEnd(58)}${c.reset}${c.blue}│${c.reset}`;

  const lines = [
    "",
    border,
    `${c.blue}│${c.reset}${c.bold}          Safe Delete Audit                                ${c.reset}${c.blue}│${c.reset}`,
    sep,
    header("COMPRESSED DATA"),
    sep,
    row("Books with compressed data:", formatNum(totalBooks)),
    row("Chapters in bundles:", formatNum(totalBundleChapters)),
    row("Chapters in legacy .zst/.gz:", formatNum(totalLegacyChapters)),
    row("Total unique chapters:", formatNum(totalCompressedChapters)),
    row("Bundle files size:", formatBytes(totalBundleBytes)),
    row("Legacy files size:", formatBytes(totalLegacyBytes)),
    row("Total compressed size:", formatBytes(totalBundleBytes + totalLegacyBytes)),
    sep,
    header("COVERAGE CHECK"),
    sep,
    row("Covered by crawler .txt:", `${formatNum(totalCoveredByTxt)}  (${totalCompressedChapters > 0 ? ((totalCoveredByTxt / totalCompressedChapters) * 100).toFixed(1) + "%" : "N/A"})`, c.green),
    row(
      "Orphaned (no .txt source):",
      formatNum(totalOrphaned),
      totalOrphaned > 0 ? c.red : c.green,
    ),
    sep,
    row(
      "Books fully safe to delete:",
      `${formatNum(booksSafe)} / ${formatNum(totalBooks)}`,
      booksSafe === totalBooks ? c.green : c.yellow,
    ),
    row(
      "Books with orphaned chapters:",
      formatNum(booksOrphaned),
      booksOrphaned > 0 ? c.red : c.green,
    ),
    row(
      "  of which: no crawler dir:",
      formatNum(booksNoSource),
      booksNoSource > 0 ? c.red : c.green,
    ),
    sep,
    row("Safe to reclaim (bundles):", formatBytes(safeBundleBytes), c.green),
    row("Safe to reclaim (legacy):", formatBytes(safeLegacyBytes), c.green),
    row("Safe to reclaim (total):", formatBytes(safeBundleBytes + safeLegacyBytes), c.green),
    sep,
    row("Scan duration:", `${(duration / 1000).toFixed(1)}s`, c.dim),
    sep,
  ];

  if (allSafe) {
    lines.push(
      `${c.blue}│${c.reset}                                                            ${c.blue}│${c.reset}`,
      `${c.blue}│${c.reset}  ${c.green}${c.bold}✅ SAFE TO DELETE${c.reset} — every compressed chapter has a         ${c.blue}│${c.reset}`,
      `${c.blue}│${c.reset}  ${c.green}corresponding .txt in crawler output. You can re-compress${c.reset}  ${c.blue}│${c.reset}`,
      `${c.blue}│${c.reset}  ${c.green}at any time with: npm run pre-compress${c.reset}                     ${c.blue}│${c.reset}`,
      `${c.blue}│${c.reset}                                                            ${c.blue}│${c.reset}`,
    );
  } else {
    lines.push(
      `${c.blue}│${c.reset}                                                            ${c.blue}│${c.reset}`,
      `${c.blue}│${c.reset}  ${c.red}${c.bold}⛔ NOT SAFE${c.reset} — ${c.red}${formatNum(totalOrphaned)} chapter(s) across ${formatNum(booksOrphaned)} book(s)${c.reset}`.padEnd(79) + `${c.blue}│${c.reset}`,
      `${c.blue}│${c.reset}  ${c.red}exist only in compressed form with no .txt source.${c.reset}          ${c.blue}│${c.reset}`,
      `${c.blue}│${c.reset}  ${c.red}Deleting these would cause data loss.${c.reset}                       ${c.blue}│${c.reset}`,
      `${c.blue}│${c.reset}                                                            ${c.blue}│${c.reset}`,
    );
  }

  lines.push(bottom);
  for (const line of lines) process.stdout.write(line + "\n");

  // ─── Verbose: list orphaned books ──────────────────────────────────────────

  if (booksOrphaned > 0) {
    // Always show orphaned summary (not just verbose) since this is critical
    const show = VERBOSE ? orphanedBooks : orphanedBooks.slice(0, 20);
    process.stdout.write(
      `\n${c.red}${c.bold}Orphaned books (${formatNum(booksOrphaned)}):${c.reset}\n`,
    );
    process.stdout.write(
      `  ${"Book ID".padEnd(12)}${"Compressed".padStart(12)}${"Has .txt".padStart(12)}${"Orphaned".padStart(12)}  Orphaned indices\n`,
    );
    process.stdout.write(`  ${"─".repeat(70)}\n`);
    for (const ob of show) {
      const indicesStr = ob.orphanedIndices.length <= 10
        ? ob.orphanedIndices.join(", ")
        : ob.orphanedIndices.slice(0, 10).join(", ") + ` … +${ob.orphanedIndices.length - 10} more`;
      process.stdout.write(
        `  ${ob.bookId.padEnd(12)}${formatNum(ob.compressedCount).padStart(12)}${formatNum(ob.txtCount).padStart(12)}${c.red}${formatNum(ob.orphanedIndices.length).padStart(12)}${c.reset}  ${c.dim}${indicesStr}${c.reset}\n`,
      );
    }
    if (!VERBOSE && orphanedBooks.length > 20) {
      process.stdout.write(
        `  ${c.dim}... and ${formatNum(orphanedBooks.length - 20)} more (use --verbose to see all)${c.reset}\n`,
      );
    }
  }

  process.stdout.write("\n");
  process.exit(allSafe ? 0 : 1);
}

main();
