import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "path";
import fs from "fs";

const DB_PATH = process.env.DATABASE_URL?.replace("file:", "") || "./data/binslib.db";
const resolvedPath = path.resolve(DB_PATH);

// Ensure data directory exists
fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });

const sqlite = new Database(resolvedPath);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

const db = drizzle(sqlite);

console.log("Running migrations...");
migrate(db, { migrationsFolder: "./src/db/migrations" });

// Create FTS5 virtual tables (not handled by Drizzle)
sqlite.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS books_fts USING fts5(
    name,
    synopsis,
    content='books',
    content_rowid='id',
    tokenize='unicode61'
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS chapters_fts USING fts5(
    title,
    body,
    content='chapters',
    content_rowid='id',
    tokenize='unicode61'
  );

  -- Triggers to keep FTS in sync
  CREATE TRIGGER IF NOT EXISTS books_ai AFTER INSERT ON books BEGIN
    INSERT INTO books_fts(rowid, name, synopsis) VALUES (new.id, new.name, new.synopsis);
  END;
  CREATE TRIGGER IF NOT EXISTS books_ad AFTER DELETE ON books BEGIN
    INSERT INTO books_fts(books_fts, rowid, name, synopsis) VALUES('delete', old.id, old.name, old.synopsis);
  END;
  CREATE TRIGGER IF NOT EXISTS books_au AFTER UPDATE ON books BEGIN
    INSERT INTO books_fts(books_fts, rowid, name, synopsis) VALUES('delete', old.id, old.name, old.synopsis);
    INSERT INTO books_fts(rowid, name, synopsis) VALUES (new.id, new.name, new.synopsis);
  END;

  CREATE TRIGGER IF NOT EXISTS chapters_ai AFTER INSERT ON chapters BEGIN
    INSERT INTO chapters_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
  END;
  CREATE TRIGGER IF NOT EXISTS chapters_ad AFTER DELETE ON chapters BEGIN
    INSERT INTO chapters_fts(chapters_fts, rowid, title, body) VALUES('delete', old.id, old.title, old.body);
  END;
  CREATE TRIGGER IF NOT EXISTS chapters_au AFTER UPDATE ON chapters BEGIN
    INSERT INTO chapters_fts(chapters_fts, rowid, title, body) VALUES('delete', old.id, old.title, old.body);
    INSERT INTO chapters_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
  END;
`);

console.log("Migrations complete.");
sqlite.close();
