const Database = require("better-sqlite3");
const db = new Database("data/binslib.db", { readonly: true });
db.pragma("journal_mode = WAL");

console.log("Warming OS file cache for binslib.db...");
const t0 = Date.now();

const books = db.prepare("SELECT * FROM books").all();
console.log(`  books: ${books.length} rows`);
const authors = db.prepare("SELECT * FROM authors").all();
console.log(`  authors: ${authors.length} rows`);
const genres = db.prepare("SELECT * FROM genres").all();
console.log(`  genres: ${genres.length} rows`);

// Warm the books_fts shadow tables
try {
  db.prepare("SELECT count(*) FROM books_fts").get();
  console.log("  books_fts: warmed");
} catch {}

// Warm chapter index (titles only, no body)
const chapCount = db.prepare("SELECT count(*) as c FROM chapters").get();
console.log(`  chapters index: ${chapCount.c} rows`);

db.close();
console.log(`Cache warmed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
