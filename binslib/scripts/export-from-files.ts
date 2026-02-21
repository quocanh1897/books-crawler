/**
 * Fast Chapter Export — from crawler output files directly (not from DB)
 *
 * Reads .txt chapter files from crawler/output and crawler-tangthuvien/output,
 * compresses them with gzip, and writes to data/compressed/{book_id}/{index}.txt.gz.
 *
 * This is much faster than reading from the 50 GB SQLite DB because the source
 * files are already individual files on disk.
 *
 * Usage:
 *   npx tsx scripts/export-from-files.ts
 *   npx tsx scripts/export-from-files.ts --dry-run
 *   npx tsx scripts/export-from-files.ts --quiet
 */

import fs from "fs";
import path from "path";
import { gzipSync } from "node:zlib";
import cliProgress from "cli-progress";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const QUIET = args.includes("--quiet");

const CRAWLER_OUTPUT =
    process.env.CRAWLER_OUTPUT_DIR ||
    path.resolve(__dirname, "../../crawler/output");
const TTV_CRAWLER_OUTPUT =
    process.env.TTV_CRAWLER_OUTPUT_DIR ||
    path.resolve(__dirname, "../../crawler-tangthuvien/output");
const CHAPTERS_DIR = path.resolve(
    process.env.CHAPTERS_DIR || "./data/compressed"
);
const LOG_FILE = path.resolve(__dirname, "../data/export-log.txt");

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
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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

function parseChapterFile(filePath: string): { indexNum: number; body: string } | null {
    const match = path.basename(filePath).match(/^(\d+)_(.+)\.txt$/);
    if (!match) return null;
    const indexNum = parseInt(match[1], 10);

    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n");
    const title = lines[0]?.trim() || "";
    let bodyStart = 1;
    while (bodyStart < lines.length && lines[bodyStart].trim() === "") bodyStart++;
    if (bodyStart < lines.length && lines[bodyStart].trim() === title) bodyStart++;
    const body = lines.slice(bodyStart).join("\n").trim();

    return { indexNum, body };
}

// ─── Main ────────────────────────────────────────────────────────────────────

const startedAt = Date.now();

const allBooks = [
    ...scanBookDirs(CRAWLER_OUTPUT),
    ...scanBookDirs(TTV_CRAWLER_OUTPUT),
];

log(`\n${c.bold}[${timestamp()}] Fast chapter export from crawler files${c.reset}`);
log(`  Sources: ${c.cyan}${CRAWLER_OUTPUT}${c.reset}`);
log(`           ${c.cyan}${TTV_CRAWLER_OUTPUT}${c.reset}`);
log(`  Target:  ${c.cyan}${CHAPTERS_DIR}${c.reset}`);
log(`  Books found: ${c.cyan}${formatNum(allBooks.length)}${c.reset}`);
log(`  Dry run: ${DRY_RUN ? "yes" : "no"}`);
log("");

// Count total chapter files first (fast — just readdirSync)
let totalChapters = 0;
for (const { bookDir } of allBooks) {
    const files = fs.readdirSync(bookDir).filter((f) => /^\d{4}_/.test(f) && f.endsWith(".txt"));
    totalChapters += files.length;
}
log(`  Total chapter files: ${c.cyan}${formatNum(totalChapters)}${c.reset}\n`);

const bar = QUIET
    ? null
    : new cliProgress.SingleBar({
          clearOnComplete: false,
          hideCursor: true,
          barsize: 25,
          format: `  Export  ${c.green}{bar}${c.reset} {value}/{total}  {percentage}%  ETA: {eta_formatted}  ${c.dim}{detail}${c.reset}`,
      });

bar?.start(totalChapters, 0, { detail: "" });

let exported = 0;
let skipped = 0;
let failed = 0;
let bytesWritten = 0;
let bytesRead = 0;
const failures: { bookId: string; file: string; error: string }[] = [];

for (const { bookId, bookDir } of allBooks) {
    const chapterFiles = fs
        .readdirSync(bookDir)
        .filter((f) => /^\d{4}_/.test(f) && f.endsWith(".txt"))
        .sort();

    for (const file of chapterFiles) {
        const outDir = path.join(CHAPTERS_DIR, bookId);
        const parsed = parseChapterFile(path.join(bookDir, file));
        if (!parsed) {
            skipped++;
            bar?.increment(1, { detail: `skip ${file}` });
            continue;
        }

        const outFile = path.join(outDir, `${parsed.indexNum}.txt.gz`);

        if (fs.existsSync(outFile)) {
            skipped++;
            bar?.increment(1, { detail: `exists ${bookId}/${parsed.indexNum}` });
            continue;
        }

        if (!DRY_RUN) {
            try {
                const srcSize = fs.statSync(path.join(bookDir, file)).size;
                bytesRead += srcSize;

                fs.mkdirSync(outDir, { recursive: true });
                const compressed = gzipSync(parsed.body);
                fs.writeFileSync(outFile, compressed);
                bytesWritten += compressed.length;
                exported++;
            } catch (err) {
                failed++;
                const msg = (err as Error).message?.slice(0, 120) || "Unknown error";
                failures.push({ bookId, file, error: msg });
                if (!QUIET) {
                    log(`  ${c.red}WARN:${c.reset} ${bookId}/${file}: ${msg}`);
                }
            }
        } else {
            exported++;
        }

        bar?.increment(1, { detail: `book ${bookId}` });
    }
}

bar?.stop();

const duration = Date.now() - startedAt;

// ─── Report ──────────────────────────────────────────────────────────────────

const border = `${c.blue}┌${"─".repeat(52)}┐${c.reset}`;
const bottom = `${c.blue}└${"─".repeat(52)}┘${c.reset}`;
const sep = `${c.blue}├${"─".repeat(52)}┤${c.reset}`;
const row = (label: string, value: string, color = c.white) =>
    `${c.blue}│${c.reset}  ${label.padEnd(24)}${color}${value.padStart(24)}${c.reset}  ${c.blue}│${c.reset}`;

const lines = [
    "",
    border,
    `${c.blue}│${c.reset}${c.bold}       Fast Chapter Export Report                    ${c.reset}${c.blue}│${c.reset}`,
    sep,
    row("Mode:", DRY_RUN ? "dry-run" : "export"),
    row("Started:", timestamp()),
    row("Duration:", formatDuration(duration)),
    sep,
    row("Books processed:", formatNum(allBooks.length)),
    row("Chapters exported:", formatNum(exported), c.green),
    row("Chapters skipped:", formatNum(skipped), c.yellow),
    row("Chapters failed:", formatNum(failed), failed > 0 ? c.red : c.white),
    sep,
    row("Source read:", formatBytes(bytesRead)),
    row("Compressed written:", formatBytes(bytesWritten), c.green),
    row("Compression ratio:", bytesRead > 0 ? `${((1 - bytesWritten / bytesRead) * 100).toFixed(1)}%` : "N/A"),
    bottom,
];

if (!QUIET) {
    for (const line of lines) process.stdout.write(line + "\n");
}

if (failures.length > 0) {
    log(`\n${c.red}${c.bold}Failed:${c.reset}`);
    for (const f of failures.slice(0, 20)) {
        log(`  ${c.red}•${c.reset} ${f.bookId}/${f.file}: ${f.error}`);
    }
    if (failures.length > 20) log(`  ${c.dim}... and ${failures.length - 20} more${c.reset}`);
}

// Log file
const entry = [
    `[${timestamp()}] fast-export duration=${formatDuration(duration)}`,
    `  books=${allBooks.length} exported=${exported} skipped=${skipped} failed=${failed}`,
    `  read=${formatBytes(bytesRead)} written=${formatBytes(bytesWritten)}`,
    "",
].join("\n");
fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
fs.appendFileSync(LOG_FILE, entry);

log(`\n  ${c.cyan}Next step:${c.reset} Run the DB migration and VACUUM.\n`);

if (failed > 0) process.exit(1);
