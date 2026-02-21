/**
 * Chapter Export Script
 *
 * Exports chapter bodies from SQLite to gzip-compressed files on disk.
 * Part of the incremental storage migration (see PLAN-OPTIMIZE-STORAGE.md Phase 2).
 *
 * Usage:
 *   npx tsx scripts/export-chapters.ts              # export all, batch NULLing DB body
 *   npx tsx scripts/export-chapters.ts --dry-run    # report what would be exported
 *   npx tsx scripts/export-chapters.ts --keep-db    # write to disk but don't NULL db body
 *   npx tsx scripts/export-chapters.ts --batch 5000 # custom batch size (default 1000)
 *   npx tsx scripts/export-chapters.ts --quiet      # minimal output
 */

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import cliProgress from "cli-progress";
import { writeChapterBody, chapterFileExists } from "../src/lib/chapter-storage";

// ─── CLI Args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const KEEP_DB = args.includes("--keep-db");
const QUIET = args.includes("--quiet");

function getArgValue(flag: string, defaultVal: string): string {
    const idx = args.indexOf(flag);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : defaultVal;
}

const BATCH_SIZE = parseInt(getArgValue("--batch", "1000"), 10);

// ─── Config ──────────────────────────────────────────────────────────────────

const DB_PATH = path.resolve(
    process.env.DATABASE_URL?.replace("file:", "") || "./data/binslib.db"
);
const CHAPTERS_DIR = path.resolve(
    process.env.CHAPTERS_DIR || "./data/compressed"
);
const LOG_FILE = path.resolve(__dirname, "../data/export-log.txt");

// ─── Colors (ANSI) ──────────────────────────────────────────────────────────

const c = {
    reset: "\x1b[0m",
    bold: "\x1b[1m",
    dim: "\x1b[2m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    red: "\x1b[31m",
    cyan: "\x1b[36m",
    blue: "\x1b[34m",
    gray: "\x1b[90m",
    white: "\x1b[37m",
};

function log(msg: string) {
    if (!QUIET) process.stdout.write(msg + "\n");
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

function getDirSize(dir: string): number {
    if (!fs.existsSync(dir)) return 0;
    let total = 0;
    const walk = (d: string) => {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
            const fp = path.join(d, entry.name);
            if (entry.isDirectory()) walk(fp);
            else total += fs.statSync(fp).size;
        }
    };
    walk(dir);
    return total;
}

// ─── Export Report ───────────────────────────────────────────────────────────

interface ExportReport {
    startedAt: Date;
    finishedAt: Date;
    totalInDb: number;
    exported: number;
    skipped: number;
    failed: number;
    bytesWritten: number;
    bodyNulled: number;
    failures: { bookId: number; indexNum: number; error: string }[];
    dbSizeBefore: number;
    dbSizeAfter: number;
}

function printReport(report: ExportReport) {
    const duration = report.finishedAt.getTime() - report.startedAt.getTime();
    const diskUsage = getDirSize(CHAPTERS_DIR);

    const border = `${c.blue}┌${"─".repeat(52)}┐${c.reset}`;
    const bottom = `${c.blue}└${"─".repeat(52)}┘${c.reset}`;
    const sep = `${c.blue}├${"─".repeat(52)}┤${c.reset}`;
    const row = (label: string, value: string, color = c.white) =>
        `${c.blue}│${c.reset}  ${label.padEnd(24)}${color}${value.padStart(24)}${c.reset}  ${c.blue}│${c.reset}`;

    const lines = [
        "",
        border,
        `${c.blue}│${c.reset}${c.bold}         Chapter Export Report                      ${c.reset}${c.blue}│${c.reset}`,
        sep,
        row("Mode:", DRY_RUN ? "dry-run" : KEEP_DB ? "export (keep-db)" : "export"),
        row("Started:", timestamp()),
        row("Duration:", formatDuration(duration)),
        sep,
        row("Chapters in DB:", formatNum(report.totalInDb)),
        row("Exported:", formatNum(report.exported), c.green),
        row("Skipped (on disk):", formatNum(report.skipped), c.yellow),
        row("Failed:", formatNum(report.failed), report.failed > 0 ? c.red : c.white),
        sep,
        row("Bytes written:", formatBytes(report.bytesWritten), c.green),
        row("DB body NULLed:", formatNum(report.bodyNulled), KEEP_DB ? c.yellow : c.green),
        sep,
        row("DB size (before):", formatBytes(report.dbSizeBefore)),
        row("DB size (after):", formatBytes(report.dbSizeAfter)),
        row("Disk (compressed/):", formatBytes(diskUsage)),
        bottom,
    ];

    for (const line of lines) {
        process.stdout.write(line + "\n");
    }

    if (report.failed > 0) {
        process.stdout.write(`\n${c.red}${c.bold}Failed chapters:${c.reset}\n`);
        for (const f of report.failures.slice(0, 20)) {
            process.stdout.write(
                `  ${c.red}•${c.reset} book_id=${f.bookId} index=${f.indexNum}: ${f.error}\n`
            );
        }
        if (report.failures.length > 20) {
            process.stdout.write(
                `  ${c.dim}... and ${report.failures.length - 20} more${c.reset}\n`
            );
        }
    }

    if (!DRY_RUN && !KEEP_DB && report.exported > 0) {
        log(`\n  ${c.cyan}Next step:${c.reset} run  ${c.bold}sqlite3 data/binslib.db "VACUUM;"${c.reset}  to reclaim DB space.\n`);
    }
}

function appendLog(report: ExportReport) {
    const duration = report.finishedAt.getTime() - report.startedAt.getTime();
    const mode = DRY_RUN ? "dry-run" : KEEP_DB ? "keep-db" : "export";
    const entry = [
        `[${timestamp()}] mode=${mode} duration=${formatDuration(duration)}`,
        `  exported=${report.exported} skipped=${report.skipped} failed=${report.failed}`,
        `  written=${formatBytes(report.bytesWritten)} nulled=${report.bodyNulled}`,
        ...(report.failures.length > 0
            ? report.failures.map((f) => `  FAIL book ${f.bookId} ch ${f.indexNum}: ${f.error}`)
            : []),
        "",
    ].join("\n");

    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, entry);
}

// ─── Main Export ─────────────────────────────────────────────────────────────

function runExport(): ExportReport {
    const startedAt = new Date();
    const dbSizeBefore = fs.existsSync(DB_PATH) ? fs.statSync(DB_PATH).size : 0;

    const sqlite = new Database(DB_PATH);
    sqlite.pragma("journal_mode = WAL");

    const totalRow = sqlite
        .prepare("SELECT COUNT(*) as cnt FROM chapters WHERE body IS NOT NULL")
        .get() as { cnt: number };
    const totalInDb = totalRow.cnt;

    log(`\n${c.bold}[${timestamp()}] Chapter export starting...${c.reset}`);
    log(`  Total chapters with body in DB: ${c.cyan}${formatNum(totalInDb)}${c.reset}`);
    log(`  Target directory: ${c.cyan}${CHAPTERS_DIR}${c.reset}`);
    log(`  Batch size: ${formatNum(BATCH_SIZE)} | Keep DB body: ${KEEP_DB ? "yes" : "no"} | Dry run: ${DRY_RUN ? "yes" : "no"}`);
    log("");

    if (totalInDb === 0) {
        log(`  ${c.yellow}No chapters with body in DB. Nothing to export.${c.reset}\n`);
        const now = new Date();
        sqlite.close();
        return {
            startedAt, finishedAt: now, totalInDb: 0,
            exported: 0, skipped: 0, failed: 0,
            bytesWritten: 0, bodyNulled: 0, failures: [],
            dbSizeBefore, dbSizeAfter: dbSizeBefore,
        };
    }

    if (DRY_RUN) {
        log(`  ${c.yellow}Dry run mode — no files will be written, no DB changes.${c.reset}\n`);
    }

    const bar = QUIET
        ? null
        : new cliProgress.SingleBar({
              clearOnComplete: false,
              hideCursor: true,
              barsize: 25,
              format: `  Export  ${c.green}{bar}${c.reset} {value}/{total}  {percentage}%  ETA: {eta_formatted}  ${c.dim}{detail}${c.reset}`,
          });

    bar?.start(totalInDb, 0, { detail: "" });

    const nullStmt = sqlite.prepare(
        "UPDATE chapters SET body = NULL WHERE id = ?"
    );
    const nullBatch = sqlite.transaction((ids: number[]) => {
        for (const id of ids) nullStmt.run(id);
    });

    const iter = sqlite
        .prepare(
            "SELECT id, book_id, index_num, body FROM chapters WHERE body IS NOT NULL ORDER BY book_id, index_num"
        )
        .iterate() as IterableIterator<{
        id: number;
        book_id: number;
        index_num: number;
        body: string;
    }>;

    let exported = 0;
    let skipped = 0;
    let failed = 0;
    let bytesWritten = 0;
    let bodyNulled = 0;
    const failures: { bookId: number; indexNum: number; error: string }[] = [];
    const batchIds: number[] = [];
    let batchNum = 0;
    const batchStartTime = Date.now();

    for (const row of iter) {
        if (chapterFileExists(row.book_id, row.index_num)) {
            skipped++;
            if (!KEEP_DB && !DRY_RUN) {
                batchIds.push(row.id);
            }
        } else if (!DRY_RUN) {
            try {
                writeChapterBody(row.book_id, row.index_num, row.body);
                const fp = path.join(
                    CHAPTERS_DIR,
                    String(row.book_id),
                    `${row.index_num}.txt.gz`
                );
                bytesWritten += fs.statSync(fp).size;
                exported++;
                if (!KEEP_DB) {
                    batchIds.push(row.id);
                }
            } catch (err) {
                failed++;
                const msg = (err as Error).message?.slice(0, 120) || "Unknown error";
                failures.push({
                    bookId: row.book_id,
                    indexNum: row.index_num,
                    error: msg,
                });
                if (!QUIET) {
                    log(`  ${c.red}WARN:${c.reset} Failed book_id=${row.book_id} index=${row.index_num}: ${msg}`);
                }
            }
        } else {
            exported++;
        }

        if (!DRY_RUN && !KEEP_DB && batchIds.length >= BATCH_SIZE) {
            nullBatch(batchIds);
            bodyNulled += batchIds.length;
            batchNum++;
            const elapsed = Date.now() - batchStartTime;
            if (!QUIET) {
                bar?.update(exported + skipped + failed, {
                    detail: `batch ${batchNum} | ${formatBytes(bytesWritten)} written | ${formatDuration(elapsed)}`,
                });
            }
            batchIds.length = 0;
        } else {
            bar?.update(exported + skipped + failed, {
                detail: `book ${row.book_id}`,
            });
        }
    }

    if (!DRY_RUN && !KEEP_DB && batchIds.length > 0) {
        nullBatch(batchIds);
        bodyNulled += batchIds.length;
    }

    bar?.update(totalInDb, { detail: "done" });
    bar?.stop();

    if (skipped > 0) {
        log(`\n  ${c.yellow}Skipped ${formatNum(skipped)} chapters (already exported to disk)${c.reset}`);
    }

    const dbSizeAfter = fs.existsSync(DB_PATH) ? fs.statSync(DB_PATH).size : 0;
    sqlite.close();

    return {
        startedAt,
        finishedAt: new Date(),
        totalInDb,
        exported,
        skipped,
        failed,
        bytesWritten,
        bodyNulled,
        failures,
        dbSizeBefore,
        dbSizeAfter,
    };
}

// ─── Run ─────────────────────────────────────────────────────────────────────

const report = runExport();
if (!QUIET) printReport(report);
appendLog(report);

if (report.failed > 0) {
    process.exit(1);
}
