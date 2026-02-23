/**
 * Binslib Import Script
 *
 * Reads crawler/output into SQLite database with progress bars and reports.
 *
 * Supports pre-compressed chapters:
 *   - If .zst files exist in compressed/ (e.g. rsynced from another machine),
 *     the script will skip compression and only update the database.
 *   - .zst-only chapters (no .txt) will have titles extracted from body content.
 *   - This saves significant time when importing from pre-compressed sources.
 *
 * Usage:
 *   npx tsx scripts/import.ts                    # incremental import
 *   npx tsx scripts/import.ts --full             # full re-import
 *   npx tsx scripts/import.ts --cron             # background polling daemon
 *   npx tsx scripts/import.ts --cron --interval 10
 *   npx tsx scripts/import.ts --ids 100267 102205
 *   npx tsx scripts/import.ts --dry-run
 *   npx tsx scripts/import.ts --quiet
 */

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { execSync } from "child_process";
import cliProgress from "cli-progress";
import {
  BundleWriter,
  readChapterBody,
  listCompressedChapters,
} from "../src/lib/chapter-storage";

// ─── CLI Args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const FULL_MODE = args.includes("--full");
const CRON_MODE = args.includes("--cron");
const DRY_RUN = args.includes("--dry-run");
const QUIET = args.includes("--quiet");

function getArgValue(flag: string, defaultVal: string): string {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : defaultVal;
}

const CRON_INTERVAL = parseInt(
  process.env.IMPORT_CRON_INTERVAL || getArgValue("--interval", "30"),
  10,
);

const SPECIFIC_IDS: number[] = (() => {
  const idx = args.indexOf("--ids");
  if (idx === -1) return [];
  const ids: number[] = [];
  for (let i = idx + 1; i < args.length; i++) {
    if (args[i].startsWith("--")) break;
    const n = parseInt(args[i], 10);
    if (!isNaN(n)) ids.push(n);
  }
  return ids;
})();

// ─── Config ──────────────────────────────────────────────────────────────────

const DB_PATH = path.resolve(
  process.env.DATABASE_URL?.replace("file:", "") || "./data/binslib.db",
);
const CRAWLER_OUTPUT =
  process.env.CRAWLER_OUTPUT_DIR ||
  path.resolve(__dirname, "../../crawler/output");
const TTV_CRAWLER_OUTPUT =
  process.env.TTV_CRAWLER_OUTPUT_DIR ||
  path.resolve(__dirname, "../../crawler-tangthuvien/output");
const META_PULLER_DIR =
  process.env.META_PULLER_DIR || path.resolve(__dirname, "../../meta-puller");
const COVERS_DIR = path.resolve(__dirname, "../public/covers");
const LOG_FILE = path.resolve(__dirname, "../data/import-log.txt");
const DETAIL_LOG_FILE = path.resolve(__dirname, "../data/import-detail.log");

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
  bgBlue: "\x1b[44m",
};

function log(msg: string) {
  if (!QUIET) process.stdout.write(msg + "\n");
}

// ─── DB Setup ────────────────────────────────────────────────────────────────

function openDb() {
  const sqlite = new Database(DB_PATH);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  // Migrate: add columns if missing
  try {
    sqlite.exec("ALTER TABLE books ADD COLUMN meta_hash TEXT");
  } catch {
    // column already exists
  }
  try {
    sqlite.exec("ALTER TABLE books ADD COLUMN source TEXT");
  } catch {
    // column already exists
  }
  return sqlite;
}

function computeMetaHash(content: string): string {
  return crypto.createHash("md5").update(content).digest("hex");
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function slugify(text: string): string {
  const from =
    "àáảãạăắằẳẵặâấầẩẫậèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵđ";
  const to =
    "aaaaaaaaaaaaaaaaaeeeeeeeeeeeiiiiiooooooooooooooooouuuuuuuuuuuyyyyyd";
  let slug = text.toLowerCase().trim();
  for (let i = 0; i < from.length; i++) {
    slug = slug.replace(new RegExp(from[i], "g"), to[i]);
  }
  return slug
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/[\s-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function parseAuthorId(raw: unknown): number | null {
  if (raw == null) return null;
  if (typeof raw === "number") return raw;
  const s = String(raw).replace(/^c/i, "");
  const n = parseInt(s, 10);
  return isNaN(n) ? null : n;
}

function tryRunMetaPuller(bookId: number): boolean {
  const script = path.join(META_PULLER_DIR, "pull_metadata.py");
  if (!fs.existsSync(script)) return false;
  try {
    execSync(`python3 "${script}" --ids ${bookId}`, {
      cwd: META_PULLER_DIR,
      stdio: "pipe",
      timeout: 30000,
    });
    return true;
  } catch {
    return false;
  }
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

function timestamp(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function logDetail(msg: string) {
  fs.mkdirSync(path.dirname(DETAIL_LOG_FILE), { recursive: true });
  fs.appendFileSync(DETAIL_LOG_FILE, `[${timestamp()}] ${msg}\n`);
}

// ─── Import Report ───────────────────────────────────────────────────────────

interface ImportReport {
  mode: string;
  startedAt: Date;
  finishedAt: Date;
  booksScanned: number;
  booksImported: number;
  booksSkipped: number;
  booksFailed: number;
  metaResynced: number;
  chaptersAdded: number;
  coversCopied: number;
  metaPullerRuns: number;
  failures: { bookId: number; error: string }[];
  mtcBooks: number;
  ttvBooks: number;
  totalChapterFiles: number;
}

function printReport(report: ImportReport) {
  const duration = report.finishedAt.getTime() - report.startedAt.getTime();
  const durationSec = duration / 1000;
  const dbSize = fs.existsSync(DB_PATH)
    ? formatBytes(fs.statSync(DB_PATH).size)
    : "N/A";

  const sqlite = openDb();
  const totals = sqlite
    .prepare(
      "SELECT COUNT(*) as books, SUM(chapters_saved) as chapters FROM books",
    )
    .get() as { books: number; chapters: number };
  sqlite.close();

  const booksPerMin =
    durationSec > 0
      ? (
          ((report.booksImported + report.booksSkipped) / durationSec) *
          60
        ).toFixed(0)
      : "0";
  const chapsPerSec =
    durationSec > 0 ? (report.chaptersAdded / durationSec).toFixed(1) : "0";

  const border = `${c.blue}┌${"─".repeat(52)}┐${c.reset}`;
  const bottom = `${c.blue}└${"─".repeat(52)}┘${c.reset}`;
  const sep = `${c.blue}├${"─".repeat(52)}┤${c.reset}`;
  const row = (label: string, value: string, color = c.white) =>
    `${c.blue}│${c.reset}  ${label.padEnd(22)}${color}${value.padStart(26)}${c.reset}  ${c.blue}│${c.reset}`;

  const lines = [
    "",
    border,
    `${c.blue}│${c.reset}${c.bold}          Binslib Import Report                     ${c.reset}${c.blue}│${c.reset}`,
    sep,
    row("Mode:", report.mode),
    row("Started:", timestamp()),
    row("Duration:", formatDuration(duration)),
    row("Speed:", `${booksPerMin} books/min, ${chapsPerSec} ch/s`),
    sep,
    row(
      "Books scanned:",
      `${formatNum(report.booksScanned)}  (${formatNum(report.mtcBooks)} mtc, ${formatNum(report.ttvBooks)} ttv)`,
    ),
    row(
      "Books imported:",
      `${formatNum(report.booksImported)}  (new/updated)`,
      c.green,
    ),
    row(
      "Books skipped:",
      `${formatNum(report.booksSkipped)}  (unchanged)`,
      c.yellow,
    ),
    row(
      "Books failed:",
      formatNum(report.booksFailed),
      report.booksFailed > 0 ? c.red : c.white,
    ),
    sep,
    row(
      "Meta resynced:",
      `${formatNum(report.metaResynced)}  (metadata changed)`,
      report.metaResynced > 0 ? c.cyan : c.white,
    ),
    row("Chapters added:", formatNum(report.chaptersAdded), c.green),
    row("Chapters scanned:", formatNum(report.totalChapterFiles)),
    row("Covers copied:", formatNum(report.coversCopied)),
    row("Meta-puller runs:", formatNum(report.metaPullerRuns)),
    sep,
    row("DB size:", dbSize),
    row("Total books:", formatNum(totals.books)),
    row("Total chapters:", formatNum(totals.chapters ?? 0)),
    bottom,
  ];

  for (const line of lines) {
    process.stdout.write(line + "\n");
  }

  if (report.failures.length > 0) {
    process.stdout.write(`\n${c.red}${c.bold}Failed books:${c.reset}\n`);
    for (const f of report.failures.slice(0, 30)) {
      process.stdout.write(
        `  ${c.red}•${c.reset} Book ${f.bookId}: ${f.error}\n`,
      );
    }
    if (report.failures.length > 30) {
      process.stdout.write(
        `  ${c.dim}... and ${report.failures.length - 30} more${c.reset}\n`,
      );
    }
  }

  log(`\n  ${c.dim}Detail log:${c.reset} ${DETAIL_LOG_FILE}`);
}

function appendLog(report: ImportReport) {
  const duration = report.finishedAt.getTime() - report.startedAt.getTime();
  const entry = [
    `[${timestamp()}] mode=${report.mode} duration=${formatDuration(duration)}`,
    `  scanned=${report.booksScanned} imported=${report.booksImported} skipped=${report.booksSkipped} failed=${report.booksFailed} meta_resynced=${report.metaResynced}`,
    `  chapters=${report.chaptersAdded} covers=${report.coversCopied} meta_pulls=${report.metaPullerRuns}`,
    ...(report.failures.length > 0
      ? report.failures.map((f) => `  FAIL book ${f.bookId}: ${f.error}`)
      : []),
    "",
  ].join("\n");

  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  fs.appendFileSync(LOG_FILE, entry);
}

// ─── Core Import ─────────────────────────────────────────────────────────────

function runImport(fullMode: boolean): ImportReport {
  const startedAt = new Date();
  const sqlite = openDb();

  // Prepared statements
  const insertAuthor = sqlite.prepare(
    "INSERT OR REPLACE INTO authors (id, name, local_name, avatar) VALUES (?, ?, ?, ?)",
  );
  const insertGenre = sqlite.prepare(
    "INSERT OR IGNORE INTO genres (id, name, slug) VALUES (?, ?, ?)",
  );
  const insertTag = sqlite.prepare(
    "INSERT OR REPLACE INTO tags (id, name, type_id) VALUES (?, ?, ?)",
  );
  const insertBook = sqlite.prepare(`
    INSERT OR REPLACE INTO books (
      id, name, slug, synopsis, status, status_name,
      view_count, comment_count, bookmark_count, vote_count,
      review_score, review_count, chapter_count, word_count,
      cover_url, author_id, created_at, updated_at,
      published_at, new_chap_at, chapters_saved, meta_hash, source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertBookGenre = sqlite.prepare(
    "INSERT OR IGNORE INTO book_genres (book_id, genre_id) VALUES (?, ?)",
  );
  const findGenreBySlug = sqlite.prepare(
    "SELECT id FROM genres WHERE slug = ? LIMIT 1",
  );
  const maxGenreId = sqlite.prepare(
    "SELECT COALESCE(MAX(id), 0) as max_id FROM genres",
  );
  let nextGenreId =
    ((maxGenreId.get() as { max_id: number })?.max_id ?? 100) + 1;

  function resolveGenreId(g: {
    id?: number;
    name: string;
    slug?: string;
  }): number {
    if (g.id != null) return g.id;
    const slug = g.slug || slugify(g.name);
    const existing = findGenreBySlug.get(slug) as { id: number } | undefined;
    if (existing) return existing.id;
    return nextGenreId++;
  }
  const insertBookTag = sqlite.prepare(
    "INSERT OR IGNORE INTO book_tags (book_id, tag_id) VALUES (?, ?)",
  );
  const insertChapter = sqlite.prepare(
    "INSERT OR REPLACE INTO chapters (book_id, index_num, title, slug, word_count) VALUES (?, ?, ?, ?, ?)",
  );
  const bookExistsStmt = sqlite.prepare(
    "SELECT id, updated_at, meta_hash FROM books WHERE id = ?",
  );
  const chapterExistsStmt = sqlite.prepare(
    "SELECT id FROM chapters WHERE book_id = ? AND index_num = ?",
  );

  fs.mkdirSync(COVERS_DIR, { recursive: true });

  if (fullMode) {
    log(`${c.yellow}Clearing existing data...${c.reset}`);
    sqlite.exec("DELETE FROM reading_history");
    sqlite.exec("DELETE FROM reading_progress");
    sqlite.exec("DELETE FROM user_bookmarks");
    sqlite.exec("DELETE FROM chapters");
    sqlite.exec("DELETE FROM book_tags");
    sqlite.exec("DELETE FROM book_genres");
    sqlite.exec("DELETE FROM books");
    sqlite.exec("DELETE FROM authors");
    sqlite.exec("DELETE FROM genres");
    sqlite.exec("DELETE FROM tags");
    sqlite.exec("DELETE FROM books_fts");
  }

  function scanNumericDirs(
    dir: string,
    source: "mtc" | "ttv",
  ): { id: string; sourceDir: string; source: "mtc" | "ttv" }[] {
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((e) => /^\d+$/.test(e))
      .map((e) => ({ id: e, sourceDir: path.join(dir, e), source }));
  }

  const mtcEntries = scanNumericDirs(CRAWLER_OUTPUT, "mtc");
  const ttvEntries = scanNumericDirs(TTV_CRAWLER_OUTPUT, "ttv");
  let allEntries = [...mtcEntries, ...ttvEntries];

  if (SPECIFIC_IDS.length > 0) {
    const idSet = new Set(SPECIFIC_IDS.map(String));
    allEntries = allEntries.filter((e) => idSet.has(e.id));
  }

  // Legacy compat: entries as string array, plus lookup maps
  const entrySourceMap = new Map<string, string>();
  const entryBookSource = new Map<string, "mtc" | "ttv">();
  for (const e of allEntries) {
    entrySourceMap.set(e.id, e.sourceDir);
    entryBookSource.set(e.id, e.source);
  }
  const entries = allEntries.map((e) => e.id);

  // Estimate total chapter counts from book.json (avoids expensive dir scans
  // that previously called readdirSync on every source dir — millions of stat calls)
  log(`  ${c.dim}Estimating chapter counts...${c.reset}`);
  let totalChapterFiles = 0;
  const bookChapterCounts = new Map<string, number>();
  for (const e of allEntries) {
    let count = 0;
    const bookJsonPath = path.join(e.sourceDir, "book.json");
    try {
      if (fs.existsSync(bookJsonPath)) {
        const bj = JSON.parse(fs.readFileSync(bookJsonPath, "utf-8"));
        count = bj.chapters_saved || 0;
      }
    } catch {
      /* use 0 */
    }
    bookChapterCounts.set(e.id, count);
    totalChapterFiles += count;
  }
  log(
    `  ${c.dim}Found ~${c.cyan}${formatNum(totalChapterFiles)}${c.reset}${c.dim} chapters across ${c.cyan}${formatNum(entries.length)}${c.reset}${c.dim} books${c.reset}\n`,
  );

  const report: ImportReport = {
    mode: fullMode ? "full" : "incremental",
    startedAt,
    finishedAt: new Date(),
    booksScanned: entries.length,
    booksImported: 0,
    booksSkipped: 0,
    booksFailed: 0,
    metaResynced: 0,
    chaptersAdded: 0,
    coversCopied: 0,
    metaPullerRuns: 0,
    failures: [],
    mtcBooks:
      SPECIFIC_IDS.length > 0
        ? allEntries.filter((e) => e.source === "mtc").length
        : mtcEntries.length,
    ttvBooks:
      SPECIFIC_IDS.length > 0
        ? allEntries.filter((e) => e.source === "ttv").length
        : ttvEntries.length,
    totalChapterFiles,
  };

  // Initialize detail log for this run
  logDetail(`${"=".repeat(60)}`);
  logDetail(
    `Import started — ${report.mode} mode, ${formatNum(entries.length)} books, ${formatNum(totalChapterFiles)} chapter files`,
  );
  logDetail(`${"=".repeat(60)}`);

  // Progress bars (MultiBar with books + chapters, matching export style)
  const multiBar = QUIET
    ? null
    : new cliProgress.MultiBar({
        clearOnComplete: false,
        hideCursor: true,
        barsize: 20,
        noTTYOutput: true,
      });

  const barFormat = (label: string, color: string) =>
    `  ${color}${label}${c.reset} {bar} {value}/{total}  {percentage}%  ETA: {eta_formatted}  ${c.dim}{detail}${c.reset}`;

  const bookBar = multiBar?.create(
    entries.length,
    0,
    { detail: "starting..." },
    {
      format: barFormat("Books   ", c.cyan),
    },
  );
  const chapterBar = multiBar?.create(
    totalChapterFiles || 1,
    0,
    { detail: "" },
    {
      format: barFormat("Chapters", c.green),
    },
  );
  // Ensure total is set correctly (workaround for cli-progress MultiBar)
  if (chapterBar && totalChapterFiles > 0)
    chapterBar.setTotal(totalChapterFiles);
  let chaptersProcessed = 0;

  for (const bookIdStr of entries) {
    const bookId = parseInt(bookIdStr, 10);
    const bookDir =
      entrySourceMap.get(bookIdStr) || path.join(CRAWLER_OUTPUT, bookIdStr);

    try {
      // Read metadata.json
      const metaPath = path.join(bookDir, "metadata.json");
      if (!fs.existsSync(metaPath)) {
        report.metaPullerRuns++;
        tryRunMetaPuller(bookId);
      }
      if (!fs.existsSync(metaPath)) {
        report.booksSkipped++;
        const skipChaps = bookChapterCounts.get(bookIdStr) || 0;
        chaptersProcessed += skipChaps;
        bookBar?.increment(1, { detail: `skip ${bookId} (no metadata)` });
        chapterBar?.update(chaptersProcessed, { detail: `skip ${bookId}` });
        logDetail(`SKIP ${bookId}: no metadata.json`);
        continue;
      }

      const metaRaw = fs.readFileSync(metaPath, "utf-8");
      const metaHash = computeMetaHash(metaRaw);
      const meta = JSON.parse(metaRaw);
      // Use directory name as canonical ID (meta.id can differ after meta-puller updates)
      meta.id = bookId;

      // Skip unchanged in incremental mode
      if (!fullMode) {
        const existing = bookExistsStmt.get(bookId) as
          | { id: number; updated_at: string; meta_hash: string | null }
          | undefined;

        const metaUnchanged = existing?.meta_hash === metaHash;
        const updatedAtUnchanged = existing?.updated_at === meta.updated_at;

        if (existing && metaUnchanged && updatedAtUnchanged) {
          const bookJsonPath = path.join(bookDir, "book.json");
          let shouldSkip = false;
          if (fs.existsSync(bookJsonPath)) {
            const bookJson = JSON.parse(fs.readFileSync(bookJsonPath, "utf-8"));
            const savedInDb = sqlite
              .prepare("SELECT COUNT(*) as cnt FROM chapters WHERE book_id = ?")
              .get(bookId) as { cnt: number };
            if (savedInDb.cnt >= (bookJson.chapters_saved || 0)) {
              shouldSkip = true;
            }
          } else {
            shouldSkip = true;
          }

          if (shouldSkip) {
            // Even for skipped books, sync cover if missing
            const coverSrc = path.join(bookDir, "cover.jpg");
            const coverDest = path.join(COVERS_DIR, `${bookId}.jpg`);
            if (fs.existsSync(coverSrc) && !fs.existsSync(coverDest)) {
              fs.copyFileSync(coverSrc, coverDest);
              sqlite
                .prepare("UPDATE books SET cover_url = ? WHERE id = ?")
                .run(`/covers/${bookId}.jpg`, bookId);
              report.coversCopied++;
            }

            report.booksSkipped++;
            const skipChaps = bookChapterCounts.get(bookIdStr) || 0;
            chaptersProcessed += skipChaps;
            bookBar?.increment(1, { detail: `skip ${meta.name}` });
            chapterBar?.update(chaptersProcessed, { detail: `skip ${bookId}` });
            continue;
          }
        }

        // If only metadata changed (hash differs) but updated_at is the same,
        // count it and log it so it's visible in the report
        if (existing && !metaUnchanged) {
          report.metaResynced++;
          bookBar?.update({ detail: `resync ${meta.name} (meta changed)` });
        }
      }

      if (DRY_RUN) {
        report.booksImported++;
        const dryChaps = bookChapterCounts.get(bookIdStr) || 0;
        chaptersProcessed += dryChaps;
        bookBar?.increment(1, { detail: `[dry] ${meta.name}` });
        chapterBar?.update(chaptersProcessed, { detail: `[dry] ${bookId}` });
        continue;
      }

      bookBar?.update({ detail: meta.name });

      // Cover (run meta-puller before transaction if needed)
      const coverSrc = path.join(bookDir, "cover.jpg");
      const coverDest = path.join(COVERS_DIR, `${bookId}.jpg`);
      let coverUrl: string | null = null;
      if (!fs.existsSync(coverSrc)) {
        report.metaPullerRuns++;
        tryRunMetaPuller(bookId);
      }
      if (fs.existsSync(coverSrc)) {
        fs.copyFileSync(coverSrc, coverDest);
        coverUrl = `/covers/${bookId}.jpg`;
        report.coversCopied++;
      }

      // book.json
      let chaptersSaved = 0;
      const bookJsonPath = path.join(bookDir, "book.json");
      if (fs.existsSync(bookJsonPath)) {
        try {
          const bookJson = JSON.parse(fs.readFileSync(bookJsonPath, "utf-8"));
          chaptersSaved = bookJson.chapters_saved || 0;
        } catch {
          /* ignore */
        }
      }

      // Pre-read chapter files list
      const chapterFiles = fs
        .readdirSync(bookDir)
        .filter((f) => f.endsWith(".txt") && /^\d{4}_/.test(f))
        .sort();

      // Normalize author ID (can be string like "c1000024" from converters)
      const authorId = parseAuthorId(meta.author?.id);

      // Prepare bundle writer — loads existing bundle data so we can
      // append new chapters without losing old ones, then flush after commit
      const bundleWriter = new BundleWriter(bookId, { loadExisting: true });

      // Import everything in a single transaction for atomicity
      let chaptersThisBook = 0;
      const importBook = sqlite.transaction(() => {
        // Author
        if (meta.author && authorId !== null) {
          insertAuthor.run(
            authorId,
            meta.author.name,
            meta.author.local_name || null,
            meta.author.avatar || null,
          );
        }

        // Genres
        if (meta.genres && Array.isArray(meta.genres)) {
          for (const g of meta.genres) {
            const genreId = resolveGenreId(g);
            g._resolvedId = genreId;
            insertGenre.run(genreId, g.name, g.slug || slugify(g.name));
          }
        }

        // Tags
        if (meta.tags && Array.isArray(meta.tags)) {
          for (const t of meta.tags) {
            insertTag.run(
              t.id,
              t.name,
              t.type_id ? parseInt(t.type_id, 10) : null,
            );
          }
        }

        // Delete conflicting slug book before INSERT OR REPLACE to avoid cascade issues
        const existingBySlug = sqlite
          .prepare("SELECT id FROM books WHERE slug = ? AND id != ?")
          .get(meta.slug, meta.id) as { id: number } | undefined;
        if (existingBySlug) {
          sqlite
            .prepare("DELETE FROM chapters WHERE book_id = ?")
            .run(existingBySlug.id);
          sqlite
            .prepare("DELETE FROM book_genres WHERE book_id = ?")
            .run(existingBySlug.id);
          sqlite
            .prepare("DELETE FROM book_tags WHERE book_id = ?")
            .run(existingBySlug.id);
          sqlite
            .prepare("DELETE FROM books WHERE id = ?")
            .run(existingBySlug.id);
        }

        // Insert book
        const bookSource = entryBookSource.get(bookIdStr) ?? "mtc";
        insertBook.run(
          meta.id,
          meta.name,
          meta.slug,
          meta.synopsis || null,
          meta.status || 1,
          meta.status_name || null,
          meta.view_count || 0,
          meta.comment_count || 0,
          meta.bookmark_count || 0,
          meta.vote_count || 0,
          meta.review_score ? parseFloat(meta.review_score) : 0,
          meta.review_count || 0,
          meta.chapter_count || 0,
          meta.word_count || 0,
          coverUrl,
          authorId,
          meta.created_at || null,
          meta.updated_at || null,
          meta.published_at || null,
          meta.new_chap_at || null,
          chaptersSaved,
          metaHash,
          bookSource,
        );

        // Junctions
        if (meta.genres && Array.isArray(meta.genres)) {
          for (const g of meta.genres) {
            const genreId = g._resolvedId ?? g.id;
            if (genreId != null) insertBookGenre.run(meta.id, genreId);
          }
        }
        if (meta.tags && Array.isArray(meta.tags)) {
          for (const t of meta.tags) insertBookTag.run(meta.id, t.id);
        }

        // Chapters - Phase 1: Import pre-compressed chapters (bundle + legacy .zst, no .txt needed)
        // This allows rsync of compressed files from another machine
        const preCompressedIndices = listCompressedChapters(bookId);
        const txtIndicesMap = new Map<number, string>(); // indexNum -> slug
        for (const filename of chapterFiles) {
          const match = filename.match(/^(\d+)_(.+)\.txt$/);
          if (match) txtIndicesMap.set(parseInt(match[1], 10), match[2]);
        }

        for (const indexNum of preCompressedIndices) {
          if (txtIndicesMap.has(indexNum)) continue; // Will process in Phase 2

          if (!fullMode) {
            const existing = chapterExistsStmt.get(bookId, indexNum);
            if (existing) continue;
          }

          const body = readChapterBody(bookId, indexNum);
          if (!body) continue;

          // Extract title from body (first non-empty line) or default
          const bodyLines = body.split("\n");
          let title = `Chương ${indexNum}`;
          for (const line of bodyLines) {
            if (line.trim()) {
              title = line.trim();
              break;
            }
          }
          const wordCount = body.split(/\s+/).filter(Boolean).length;
          const chapterSlug = `chuong-${indexNum}`;

          // Ensure chapter is in the bundle (migrates legacy .zst into bundle)
          if (!bundleWriter.has(indexNum)) {
            bundleWriter.addChapter(indexNum, body);
          }

          insertChapter.run(bookId, indexNum, title, chapterSlug, wordCount);
          chaptersThisBook++;
        }

        // Chapters - Phase 2: Process .txt files
        for (const filename of chapterFiles) {
          const match = filename.match(/^(\d+)_(.+)\.txt$/);
          if (!match) continue;
          const indexNum = parseInt(match[1], 10);
          const chapterSlug = match[2];

          if (!fullMode) {
            const existing = chapterExistsStmt.get(bookId, indexNum);
            if (existing) continue;
          }

          const filePath = path.join(bookDir, filename);
          const content = fs.readFileSync(filePath, "utf-8");
          const lines = content.split("\n");
          const title = lines[0]?.trim() || `Chương ${indexNum}`;
          let bodyStart = 1;
          while (bodyStart < lines.length && lines[bodyStart].trim() === "")
            bodyStart++;
          if (bodyStart < lines.length && lines[bodyStart].trim() === title)
            bodyStart++;
          const body = lines.slice(bodyStart).join("\n").trim();
          const wordCount = body.split(/\s+/).filter(Boolean).length;

          // Add to bundle — bundleWriter.has() is an O(1) Map lookup,
          // replacing the old 2× fs.existsSync per chapter that caused hangs
          if (!bundleWriter.has(indexNum)) {
            bundleWriter.addChapter(indexNum, body);
          }
          insertChapter.run(bookId, indexNum, title, chapterSlug, wordCount);
          chaptersThisBook++;
        }
      });
      importBook();

      // Flush chapter bundle to disk after DB transaction committed.
      // BundleWriter batches all chapters in memory, writing a single
      // file instead of thousands of individual .zst files.
      if (chaptersThisBook > 0) {
        bundleWriter.flush();
      }
      report.chaptersAdded += chaptersThisBook;
      const bookChapTotal = bookChapterCounts.get(bookIdStr) || 0;
      chaptersProcessed += bookChapTotal;
      chapterBar?.update(chaptersProcessed, {
        detail:
          chaptersThisBook > 0
            ? `+${chaptersThisBook} new from ${bookId}`
            : `${bookId} (0 new)`,
      });

      report.booksImported++;
      bookBar?.increment(1, {
        detail:
          chaptersThisBook > 0
            ? `${meta.name} (+${chaptersThisBook} ch)`
            : meta.name,
      });

      // Detail log for books with new chapters
      if (chaptersThisBook > 0) {
        logDetail(
          `IMPORT ${bookId} "${meta.name}": +${chaptersThisBook} chapters (${bookChapTotal} total files)`,
        );
      }
    } catch (err) {
      const msg = (err as Error).message?.slice(0, 120) || "Unknown error";
      report.booksFailed++;
      report.failures.push({ bookId, error: msg });
      const failChaps = bookChapterCounts.get(bookIdStr) || 0;
      chaptersProcessed += failChaps;
      bookBar?.increment(1, { detail: `FAIL ${bookId}` });
      chapterBar?.update(chaptersProcessed, { detail: `FAIL ${bookId}` });
      logDetail(`FAIL ${bookId}: ${msg}`);
    }
  }

  // Finalize progress bars
  bookBar?.update(entries.length, { detail: "done" });
  chapterBar?.update(totalChapterFiles, { detail: "done" });
  multiBar?.stop();

  // Write summary to detail log
  logDetail(`${"─".repeat(40)}`);
  logDetail(
    `Imported: ${report.booksImported}, Skipped: ${report.booksSkipped}, Failed: ${report.booksFailed}, Chapters: +${report.chaptersAdded}`,
  );

  report.finishedAt = new Date();
  const totalDuration =
    report.finishedAt.getTime() - report.startedAt.getTime();
  logDetail(`${"=".repeat(60)}`);
  logDetail(
    `COMPLETED in ${formatDuration(totalDuration)}: ${report.booksImported} imported, ${report.booksSkipped} skipped, ${report.booksFailed} failed, +${report.chaptersAdded} chapters`,
  );
  logDetail(`${"=".repeat(60)}\n`);
  sqlite.close();
  return report;
}

// ─── Cron Mode ───────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function cronLoop() {
  process.stdout.write(
    [
      "",
      `${c.bgBlue}${c.white}${c.bold} Binslib Import Daemon ${c.reset}`,
      `  ${c.dim}MTC src:${c.reset}   ${CRAWLER_OUTPUT}`,
      `  ${c.dim}TTV src:${c.reset}   ${TTV_CRAWLER_OUTPUT}`,
      `  ${c.dim}Interval:${c.reset}  every ${CRON_INTERVAL} minutes`,
      `  ${c.dim}Database:${c.reset}  ${DB_PATH}`,
      `  ${c.dim}Log:${c.reset}       ${LOG_FILE}`,
      `  ${c.dim}Detail:${c.reset}    ${DETAIL_LOG_FILE}`,
      `  ${c.dim}Press Ctrl+C to stop${c.reset}`,
      "",
    ].join("\n"),
  );

  // Handle graceful shutdown
  let running = true;
  process.on("SIGINT", () => {
    process.stdout.write(
      `\n${c.yellow}Shutting down import daemon...${c.reset}\n`,
    );
    running = false;
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    running = false;
    process.exit(0);
  });

  while (running) {
    process.stdout.write(
      `${c.cyan}[${timestamp()}]${c.reset} Starting import cycle...\n`,
    );

    const report = runImport(false);
    printReport(report);
    appendLog(report);

    if (!running) break;

    // Countdown to next run
    const intervalMs = CRON_INTERVAL * 60 * 1000;
    const nextRun = new Date(Date.now() + intervalMs);
    process.stdout.write(
      `\n${c.dim}Next import at ${nextRun.toLocaleTimeString()}${c.reset}\n`,
    );

    const sleepStep = 30_000; // update countdown every 30s
    let remaining = intervalMs;
    while (remaining > 0 && running) {
      const mins = Math.floor(remaining / 60000);
      const secs = Math.floor((remaining % 60000) / 1000);
      process.stdout.write(
        `\r${c.dim}Next import in ${mins}m ${secs}s...${c.reset}   `,
      );
      const step = Math.min(sleepStep, remaining);
      await sleep(step);
      remaining -= step;
    }
    process.stdout.write("\r" + " ".repeat(50) + "\r");
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

const FULL_MODE_SIZE_LIMIT = 100 * 1024 * 1024; // 100 MB

function main() {
  const mode = FULL_MODE ? "full" : "incremental";

  // Guard: block --full when the DB is large to prevent accidental data loss
  if (FULL_MODE && fs.existsSync(DB_PATH)) {
    const dbSize = fs.statSync(DB_PATH).size;
    if (dbSize > FULL_MODE_SIZE_LIMIT) {
      process.stdout.write(
        `\n${c.red}${c.bold}ABORT:${c.reset} --full mode is disabled when the database exceeds ${formatBytes(FULL_MODE_SIZE_LIMIT)}.\n` +
          `  Current DB size: ${c.yellow}${formatBytes(dbSize)}${c.reset}\n` +
          `  Path: ${DB_PATH}\n` +
          `  ${c.dim}This safeguard prevents accidental deletion of a large dataset.${c.reset}\n` +
          `  ${c.dim}Use incremental mode (no --full flag) or delete the DB manually first.${c.reset}\n\n`,
      );
      process.exit(1);
    }
  }

  if (CRON_MODE) {
    cronLoop().catch((err) => {
      console.error("Cron loop error:", err);
      process.exit(1);
    });
    return;
  }

  // One-shot import
  process.stdout.write(
    [
      "",
      `${c.bold}Binslib Import${c.reset} — ${mode} mode${DRY_RUN ? " (dry run)" : ""}`,
      `  ${c.dim}Database:${c.reset}  ${DB_PATH}`,
      `  ${c.dim}MTC src:${c.reset}   ${CRAWLER_OUTPUT}`,
      `  ${c.dim}TTV src:${c.reset}   ${TTV_CRAWLER_OUTPUT}`,
      `  ${c.dim}Log:${c.reset}       ${DETAIL_LOG_FILE}`,
      "",
    ].join("\n"),
  );

  const report = runImport(FULL_MODE);
  printReport(report);
  appendLog(report);

  if (report.booksFailed > 0) {
    process.exit(1);
  }
}

main();
