/**
 * Parallel Chapter Export — from crawler output files directly (not from DB)
 *
 * Reads .txt chapter files from crawler/output and crawler-tangthuvien/output,
 * compresses them with gzip in parallel using worker threads, and writes to
 * data/compressed/{book_id}/{index}.txt.gz.
 *
 * Usage:
 *   npx tsx scripts/export-from-files.ts
 *   npx tsx scripts/export-from-files.ts --workers 6    # default: CPU count
 *   npx tsx scripts/export-from-files.ts --dry-run
 *   npx tsx scripts/export-from-files.ts --quiet
 */

import fs from "fs";
import path from "path";
import os from "os";
import { Worker, isMainThread, parentPort, workerData } from "worker_threads";
import { gzipSync } from "node:zlib";

// ─── Worker Thread ───────────────────────────────────────────────────────────

if (!isMainThread) {
    const { books, chaptersDir, dryRun } = workerData as {
        books: { bookId: string; bookDir: string }[];
        chaptersDir: string;
        dryRun: boolean;
    };

    let exported = 0;
    let skipped = 0;
    let failed = 0;
    let bytesWritten = 0;
    let bytesRead = 0;
    const failures: { bookId: string; file: string; error: string }[] = [];

    for (const { bookId, bookDir } of books) {
        const chapterFiles = fs
            .readdirSync(bookDir)
            .filter((f: string) => /^\d{4}_/.test(f) && f.endsWith(".txt"))
            .sort();

        const outDir = path.join(chaptersDir, bookId);
        let dirCreated = false;

        for (const file of chapterFiles) {
            const match = file.match(/^(\d+)_(.+)\.txt$/);
            if (!match) { skipped++; continue; }
            const indexNum = parseInt(match[1], 10);
            const outFile = path.join(outDir, `${indexNum}.txt.gz`);

            if (fs.existsSync(outFile)) {
                skipped++;
                continue;
            }

            if (dryRun) { exported++; continue; }

            try {
                const srcPath = path.join(bookDir, file);
                const content = fs.readFileSync(srcPath, "utf-8");
                const srcSize = Buffer.byteLength(content, "utf-8");
                bytesRead += srcSize;

                const lines = content.split("\n");
                const title = lines[0]?.trim() || "";
                let bodyStart = 1;
                while (bodyStart < lines.length && lines[bodyStart].trim() === "") bodyStart++;
                if (bodyStart < lines.length && lines[bodyStart].trim() === title) bodyStart++;
                const body = lines.slice(bodyStart).join("\n").trim();

                if (!dirCreated) {
                    fs.mkdirSync(outDir, { recursive: true });
                    dirCreated = true;
                }
                const compressed = gzipSync(body);
                fs.writeFileSync(outFile, compressed);
                bytesWritten += compressed.length;
                exported++;
            } catch (err) {
                failed++;
                failures.push({
                    bookId, file,
                    error: (err as Error).message?.slice(0, 120) || "Unknown",
                });
            }
        }

        parentPort!.postMessage({
            type: "book_done",
            bookId,
            chapters: chapterFiles.length,
        });
    }

    parentPort!.postMessage({
        type: "done",
        exported, skipped, failed, bytesWritten, bytesRead, failures,
    });

    process.exit(0);
}

// ─── Main Thread ─────────────────────────────────────────────────────────────

import cliProgress from "cli-progress";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const QUIET = args.includes("--quiet");

function getArgValue(flag: string, defaultVal: string): string {
    const idx = args.indexOf(flag);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : defaultVal;
}

const NUM_WORKERS = Math.max(1, parseInt(getArgValue("--workers", String(os.cpus().length)), 10));

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

// ─── Scan ────────────────────────────────────────────────────────────────────

const startedAt = Date.now();

const allBooks = [
    ...scanBookDirs(CRAWLER_OUTPUT),
    ...scanBookDirs(TTV_CRAWLER_OUTPUT),
];

log(`\n${c.bold}[${timestamp()}] Parallel chapter export from crawler files${c.reset}`);
log(`  Sources: ${c.cyan}${CRAWLER_OUTPUT}${c.reset}`);
log(`           ${c.cyan}${TTV_CRAWLER_OUTPUT}${c.reset}`);
log(`  Target:  ${c.cyan}${CHAPTERS_DIR}${c.reset}`);
log(`  Books:   ${c.cyan}${formatNum(allBooks.length)}${c.reset}`);
log(`  Workers: ${c.cyan}${NUM_WORKERS}${c.reset}`);
log(`  Dry run: ${DRY_RUN ? "yes" : "no"}`);
log("");

// Count chapters (fast readdirSync scan)
let totalChapters = 0;
for (const { bookDir } of allBooks) {
    totalChapters += fs.readdirSync(bookDir).filter((f) => /^\d{4}_/.test(f) && f.endsWith(".txt")).length;
}
log(`  Total chapter files: ${c.cyan}${formatNum(totalChapters)}${c.reset}\n`);

// ─── Split work across workers ───────────────────────────────────────────────

const chunks: { bookId: string; bookDir: string }[][] = Array.from(
    { length: NUM_WORKERS },
    () => []
);
for (let i = 0; i < allBooks.length; i++) {
    chunks[i % NUM_WORKERS].push(allBooks[i]);
}

// ─── Launch workers ──────────────────────────────────────────────────────────

const bar = QUIET
    ? null
    : new cliProgress.SingleBar({
          clearOnComplete: false,
          hideCursor: true,
          barsize: 25,
          format: `  Export  ${c.green}{bar}${c.reset} {value}/{total}  {percentage}%  ETA: {eta_formatted}  ${c.dim}{detail}${c.reset}`,
      });

bar?.start(allBooks.length, 0, { detail: "starting workers..." });

let booksProcessed = 0;
let totalExported = 0;
let totalSkipped = 0;
let totalFailed = 0;
let totalBytesWritten = 0;
let totalBytesRead = 0;
const allFailures: { bookId: string; file: string; error: string }[] = [];
let workersFinished = 0;

const workerPromises = chunks.map((chunk, idx) => {
    if (chunk.length === 0) return Promise.resolve();

    return new Promise<void>((resolve, reject) => {
        const worker = new Worker(__filename, {
            workerData: {
                books: chunk,
                chaptersDir: CHAPTERS_DIR,
                dryRun: DRY_RUN,
            },
        });

        worker.on("message", (msg) => {
            if (msg.type === "book_done") {
                booksProcessed++;
                bar?.update(booksProcessed, {
                    detail: `w${idx} book ${msg.bookId} (${msg.chapters} ch)`,
                });
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
            if (code !== 0) reject(new Error(`Worker ${idx} exited with code ${code}`));
            else resolve();
        });
    });
});

Promise.all(workerPromises)
    .then(() => {
        bar?.update(allBooks.length, { detail: "done" });
        bar?.stop();

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
            `${c.blue}│${c.reset}${c.bold}     Parallel Chapter Export Report                  ${c.reset}${c.blue}│${c.reset}`,
            sep,
            row("Mode:", DRY_RUN ? "dry-run" : "export"),
            row("Workers:", String(NUM_WORKERS)),
            row("Started:", timestamp()),
            row("Duration:", formatDuration(duration)),
            sep,
            row("Books processed:", formatNum(allBooks.length)),
            row("Chapters exported:", formatNum(totalExported), c.green),
            row("Chapters skipped:", formatNum(totalSkipped), c.yellow),
            row("Chapters failed:", formatNum(totalFailed), totalFailed > 0 ? c.red : c.white),
            sep,
            row("Source read:", formatBytes(totalBytesRead)),
            row("Compressed written:", formatBytes(totalBytesWritten), c.green),
            row("Compression ratio:", totalBytesRead > 0
                ? `${((1 - totalBytesWritten / totalBytesRead) * 100).toFixed(1)}%`
                : "N/A"),
            row("Throughput:", `${formatBytes(totalBytesRead / (duration / 1000))}/s`),
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
            if (allFailures.length > 20) log(`  ${c.dim}... and ${allFailures.length - 20} more${c.reset}`);
        }

        const entry = [
            `[${timestamp()}] parallel-export workers=${NUM_WORKERS} duration=${formatDuration(duration)}`,
            `  books=${allBooks.length} exported=${totalExported} skipped=${totalSkipped} failed=${totalFailed}`,
            `  read=${formatBytes(totalBytesRead)} written=${formatBytes(totalBytesWritten)}`,
            "",
        ].join("\n");
        fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
        fs.appendFileSync(LOG_FILE, entry);

        log(`\n  ${c.cyan}Next step:${c.reset} Run the DB migration and VACUUM.\n`);

        if (totalFailed > 0) process.exit(1);
    })
    .catch((err) => {
        bar?.stop();
        log(`\n${c.red}${c.bold}Fatal error:${c.reset} ${err.message}`);
        process.exit(1);
    });
