/**
 * Pull covers for all books with .bundle files in data/compressed/.
 *
 * Reads metadata.json from crawler output to find poster URLs, downloads
 * the best available size, and saves to public/covers/{book_id}.jpg.
 * Skips books that already have a cover.
 *
 * Usage:
 *   npx tsx scripts/pull-covers.ts                  # all missing covers
 *   npx tsx scripts/pull-covers.ts --force          # re-download all
 *   npx tsx scripts/pull-covers.ts --ids 100003 100004
 *   npx tsx scripts/pull-covers.ts --dry-run        # show what would download
 *   npx tsx scripts/pull-covers.ts --source mtc     # only MTC books
 *   npx tsx scripts/pull-covers.ts --source ttv     # only TTV books
 *   npx tsx scripts/pull-covers.ts --concurrency 10 # parallel downloads
 */

import fs from "fs";
import path from "path";
import https from "https";
import http from "http";
import cliProgress from "cli-progress";

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
const COVERS_DIR = path.resolve(__dirname, "../public/covers");

const API_BASE_URL = "https://android.lonoapp.net";
const API_HEADERS = {
  authorization:
    "Bearer 7050589|YnIYK76km8VCVjbiDFORxh1e8fbYPkXocCGpOefI",
  "x-app": "app.android",
  "user-agent": "Dart/3.5 (dart:io)",
  "content-type": "application/json",
};

// ─── CLI Args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const FORCE = args.includes("--force");
const DRY_RUN = args.includes("--dry-run");

const SOURCE_FILTER: "all" | "mtc" | "ttv" = (() => {
  const idx = args.indexOf("--source");
  if (idx === -1 || !args[idx + 1]) return "all";
  const v = args[idx + 1].toLowerCase();
  if (v === "mtc" || v === "ttv") return v;
  return "all";
})();

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

const CONCURRENCY = (() => {
  const idx = args.indexOf("--concurrency");
  if (idx !== -1 && args[idx + 1]) {
    const n = parseInt(args[idx + 1], 10);
    if (!isNaN(n) && n > 0) return n;
  }
  return 5;
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
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatNum(n: number): string {
  return n.toLocaleString("en-US");
}

function isTtvId(id: number): boolean {
  return id >= 10_000_000;
}

function getBookDir(bookId: number): string | null {
  if (isTtvId(bookId)) {
    const dir = path.join(TTV_CRAWLER_OUTPUT, String(bookId));
    return fs.existsSync(dir) ? dir : null;
  }
  const dir = path.join(CRAWLER_OUTPUT, String(bookId));
  return fs.existsSync(dir) ? dir : null;
}

interface CoverUrl {
  url: string;
  bookName: string;
}

function extractCoverUrl(meta: Record<string, unknown>, bookId: number): CoverUrl | null {
  const bookName = (meta.name as string) || `Book ${bookId}`;

  // MTC: poster is an object with size variants
  if (meta.poster && typeof meta.poster === "object") {
    const poster = meta.poster as Record<string, string>;
    for (const key of ["default", "600", "300", "150"]) {
      if (poster[key]) return { url: poster[key], bookName };
    }
  }
  // MTC: poster can also be a plain string
  if (meta.poster && typeof meta.poster === "string") {
    return { url: meta.poster, bookName };
  }
  // TTV: cover_url field
  if (meta.cover_url && typeof meta.cover_url === "string") {
    return { url: meta.cover_url, bookName };
  }
  return null;
}

function fetchJson(url: string, headers: Record<string, string>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers, timeout: 15_000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
        } catch (e) {
          reject(e);
        }
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
  });
}

async function fetchCoverUrlFromApi(bookId: number): Promise<CoverUrl | null> {
  try {
    const url = `${API_BASE_URL}/api/books/${bookId}?include=author,creator,genres`;
    const data = await fetchJson(url, API_HEADERS) as Record<string, unknown>;
    if (!data || !(data as any).success || !(data as any).data) return null;
    let book = (data as any).data;
    if (book.book && typeof book.book === "object") book = book.book;
    return extractCoverUrl(book, bookId);
  } catch {
    return null;
  }
}

function getCoverUrlFromDisk(bookId: number): CoverUrl | null {
  const bookDir = getBookDir(bookId);
  if (!bookDir) return null;

  const metaPath = path.join(bookDir, "metadata.json");
  if (!fs.existsSync(metaPath)) return null;

  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    return extractCoverUrl(meta, bookId);
  } catch {
    return null;
  }
}

async function getCoverUrl(bookId: number): Promise<CoverUrl | null> {
  const fromDisk = getCoverUrlFromDisk(bookId);
  if (fromDisk) return fromDisk;
  // No local metadata — fetch from API without saving
  return fetchCoverUrlFromApi(bookId);
}

function downloadFile(url: string, destPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const client = url.startsWith("https") ? https : http;
    const request = client.get(url, { timeout: 30_000 }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        downloadFile(res.headers.location, destPath).then(resolve);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        resolve(false);
        return;
      }

      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const data = Buffer.concat(chunks);
        if (data.length < 100) {
          resolve(false);
          return;
        }
        fs.writeFileSync(destPath, data);
        resolve(true);
      });
      res.on("error", () => resolve(false));
    });
    request.on("error", () => resolve(false));
    request.on("timeout", () => {
      request.destroy();
      resolve(false);
    });
  });
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(COVERS_DIR, { recursive: true });

  // Discover book IDs from .bundle files
  const bundleFiles = fs
    .readdirSync(CHAPTERS_DIR)
    .filter((f) => f.endsWith(".bundle"));

  let bookIds = bundleFiles
    .map((f) => parseInt(f.replace(".bundle", ""), 10))
    .filter((id) => !isNaN(id));

  // Apply source filter
  if (SOURCE_FILTER === "mtc") {
    bookIds = bookIds.filter((id) => !isTtvId(id));
  } else if (SOURCE_FILTER === "ttv") {
    bookIds = bookIds.filter((id) => isTtvId(id));
  }

  // Apply specific IDs filter
  if (SPECIFIC_IDS.length > 0) {
    const idSet = new Set(SPECIFIC_IDS);
    bookIds = bookIds.filter((id) => idSet.has(id));
  }

  bookIds.sort((a, b) => a - b);

  // Filter to books needing covers
  const pending: number[] = FORCE
    ? bookIds
    : bookIds.filter(
        (id) => !fs.existsSync(path.join(COVERS_DIR, `${id}.jpg`)),
      );

  const mtcCount = pending.filter((id) => !isTtvId(id)).length;
  const ttvCount = pending.filter((id) => isTtvId(id)).length;

  console.log(
    `\n${c.bold}Pull Covers${c.reset}\n` +
      `  Bundles found:   ${c.cyan}${formatNum(bookIds.length)}${c.reset}\n` +
      `  Already have:    ${c.dim}${formatNum(bookIds.length - pending.length)}${c.reset}\n` +
      `  Need download:   ${c.cyan}${formatNum(pending.length)}${c.reset}` +
      (SOURCE_FILTER === "all"
        ? ` (${formatNum(mtcCount)} MTC, ${formatNum(ttvCount)} TTV)`
        : "") +
      `\n` +
      `  Concurrency:     ${c.dim}${CONCURRENCY}${c.reset}\n`,
  );

  if (pending.length === 0) {
    console.log(`${c.green}All covers up to date.${c.reset}`);
    return;
  }

  if (DRY_RUN) {
    console.log(`${c.yellow}Dry run — would download ${formatNum(pending.length)} covers:${c.reset}`);
    for (const id of pending.slice(0, 20)) {
      const info = await getCoverUrl(id);
      const label = info ? info.bookName : "(no metadata)";
      const src = info && !getCoverUrlFromDisk(id) ? " (API)" : "";
      console.log(`  ${id}: ${label}${c.dim}${src}${c.reset}`);
    }
    if (pending.length > 20)
      console.log(`  ${c.dim}... and ${formatNum(pending.length - 20)} more${c.reset}`);
    return;
  }

  // Download with progress bar
  const bar = new cliProgress.SingleBar({
    format: `  ${c.cyan}Covers${c.reset}  {bar}  {value}/{total}  {percentage}%  ETA: {eta_formatted}  ${c.dim}{detail}${c.reset}`,
    barsize: 25,
    clearOnComplete: false,
    hideCursor: true,
  });

  let succeeded = 0;
  let failed = 0;
  let noUrl = 0;
  let apiHits = 0;

  bar.start(pending.length, 0, { detail: "starting..." });

  // Process in batches for concurrency
  for (let i = 0; i < pending.length; i += CONCURRENCY) {
    const batch = pending.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (bookId) => {
        const destPath = path.join(COVERS_DIR, `${bookId}.jpg`);
        const fromDisk = getCoverUrlFromDisk(bookId);
        const info = fromDisk || (await fetchCoverUrlFromApi(bookId));
        if (!fromDisk && info) apiHits++;
        if (!info) {
          if (!fromDisk) apiHits++;
          noUrl++;
          return;
        }

        const ok = await downloadFile(info.url, destPath);
        if (ok) {
          succeeded++;
        } else {
          failed++;
        }
      }),
    );

    bar.update(Math.min(i + batch.length, pending.length), {
      detail:
        succeeded > 0 || failed > 0
          ? `${c.green}${succeeded} ok${c.reset}, ${failed > 0 ? `${c.red}${failed} fail${c.reset}` : "0 fail"}`
          : "downloading...",
    });
  }

  bar.update(pending.length, {
    detail: `done — ${succeeded} ok, ${failed} fail, ${noUrl} no url`,
  });
  bar.stop();

  // Summary
  const border = "─".repeat(44);
  console.log(
    `\n  ${c.bold}Results${c.reset}\n` +
      `  ${border}\n` +
      `  Downloaded:    ${c.green}${formatNum(succeeded)}${c.reset}\n` +
      `  Failed:        ${failed > 0 ? c.red : c.dim}${formatNum(failed)}${c.reset}\n` +
      `  No cover URL:  ${c.dim}${formatNum(noUrl)}${c.reset}\n` +
      (apiHits > 0
        ? `  API lookups:   ${c.dim}${formatNum(apiHits)}${c.reset}\n`
        : "") +
      `  ${border}\n`,
  );
}

main().catch((err) => {
  console.error(`${c.red}Fatal: ${err.message}${c.reset}`);
  process.exit(1);
});
