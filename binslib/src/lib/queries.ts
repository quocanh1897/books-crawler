import { db, sqlite } from "@/db";
import { books, authors, chapters } from "@/db/schema";
import { eq, asc, and } from "drizzle-orm";
import { readChapterBody } from "./chapter-storage";
import type {
  BookWithAuthor,
  BookWithDetails,
  GenreWithCount,
  RankingMetric,
  LibraryStats,
  PaginatedResponse,
} from "@/types";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function rowToBookWithAuthor(r: Record<string, unknown>): BookWithAuthor {
  return {
    id: r.id as number,
    name: r.name as string,
    slug: r.slug as string,
    synopsis: r.synopsis as string | null,
    status: r.status as number,
    statusName: r.status_name as string | null,
    viewCount: r.view_count as number,
    commentCount: r.comment_count as number,
    bookmarkCount: r.bookmark_count as number,
    voteCount: r.vote_count as number,
    reviewScore: r.review_score as number | null,
    reviewCount: r.review_count as number,
    chapterCount: r.chapter_count as number,
    wordCount: r.word_count as number,
    coverUrl: r.cover_url as string | null,
    authorId: r.author_id as number | null,
    createdAt: r.created_at as string | null,
    updatedAt: r.updated_at as string | null,
    publishedAt: r.published_at as string | null,
    newChapAt: r.new_chap_at as string | null,
    chaptersSaved: r.chapters_saved as number | null,
    metaHash: r.meta_hash as string | null,
    source: (r.source as string) || "mtc",
    author: r.author_name
      ? {
          id: r.author_id as number,
          name: r.author_name as string,
          localName: r.author_local_name as string | null,
          avatar: r.author_avatar as string | null,
        }
      : null,
  };
}

// ─── Books ───────────────────────────────────────────────────────────────────

const VALID_SORT = new Set([
  "view_count",
  "comment_count",
  "bookmark_count",
  "vote_count",
  "review_score",
  "chapter_count",
  "updated_at",
  "created_at",
  "word_count",
]);

export type BookSource = "mtc" | "ttv" | "tf";

export async function getBooks(params: {
  sort?: string;
  order?: "asc" | "desc";
  genre?: string;
  status?: number;
  minChapters?: number;
  maxChapters?: number;
  page?: number;
  limit?: number;
  source?: BookSource;
}): Promise<PaginatedResponse<BookWithAuthor>> {
  const {
    sort = "updated_at",
    order = "desc",
    genre,
    status,
    minChapters,
    maxChapters,
    page = 1,
    limit = 20,
    source,
  } = params;

  const safeLimit = Math.min(Math.max(1, limit), 50);
  const offset = (Math.max(1, page) - 1) * safeLimit;
  const safeSort = VALID_SORT.has(sort) ? sort : "updated_at";
  const safeOrder = order === "asc" ? "ASC" : "DESC";

  const conditions: string[] = [];
  const condParams: unknown[] = [];

  if (genre) {
    conditions.push("genres.slug = ?");
    condParams.push(genre);
  }
  if (status) {
    conditions.push("books.status = ?");
    condParams.push(status);
  }
  if (minChapters) {
    conditions.push("books.chapter_count >= ?");
    condParams.push(minChapters);
  }
  if (maxChapters) {
    conditions.push("books.chapter_count <= ?");
    condParams.push(maxChapters);
  }
  if (source) {
    conditions.push("books.source = ?");
    condParams.push(source);
  }

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const joinClause = genre
    ? `INNER JOIN book_genres ON books.id = book_genres.book_id
       INNER JOIN genres ON book_genres.genre_id = genres.id`
    : "";

  const dataSql = `
    SELECT books.*,
           authors.name as author_name,
           authors.local_name as author_local_name,
           authors.avatar as author_avatar
    FROM books
    LEFT JOIN authors ON books.author_id = authors.id
    ${joinClause}
    ${whereClause}
    ORDER BY books.${safeSort} ${safeOrder}
    LIMIT ? OFFSET ?
  `;

  const countSql = `
    SELECT COUNT(*) as cnt
    FROM books
    ${joinClause}
    ${whereClause}
  `;

  const rows = sqlite
    .prepare(dataSql)
    .all(...condParams, safeLimit, offset) as Record<string, unknown>[];
  const countRow = sqlite.prepare(countSql).get(...condParams) as {
    cnt: number;
  };
  const total = countRow?.cnt ?? 0;

  return {
    data: rows.map(rowToBookWithAuthor),
    total,
    page,
    limit: safeLimit,
    totalPages: Math.ceil(total / safeLimit),
  };
}

// Single-query book detail: fetches book + author + genres + tags in one round-trip
// using json_group_array/json_object subqueries instead of N+1 queries.
const bookDetailSql = `
  SELECT b.*,
    a.name   AS author_name,
    a.local_name AS author_local_name,
    a.avatar AS author_avatar,
    (SELECT json_group_array(json_object('id', g.id, 'name', g.name, 'slug', g.slug))
     FROM book_genres bg JOIN genres g ON bg.genre_id = g.id
     WHERE bg.book_id = b.id) AS genres_json,
    (SELECT json_group_array(json_object('id', t.id, 'name', t.name, 'typeId', t.type_id))
     FROM book_tags bt JOIN tags t ON bt.tag_id = t.id
     WHERE bt.book_id = b.id) AS tags_json
  FROM books b
  LEFT JOIN authors a ON b.author_id = a.id
`;

function rowToBookWithDetails(r: Record<string, unknown>): BookWithDetails {
  const base = rowToBookWithAuthor(r);

  let parsedGenres: { id: number; name: string; slug: string }[] = [];
  if (r.genres_json && r.genres_json !== "[null]") {
    try {
      parsedGenres = JSON.parse(r.genres_json as string);
    } catch {
      /* empty */
    }
  }

  let parsedTags: { id: number; name: string; typeId: number | null }[] = [];
  if (r.tags_json && r.tags_json !== "[null]") {
    try {
      parsedTags = JSON.parse(r.tags_json as string);
    } catch {
      /* empty */
    }
  }

  return { ...base, genres: parsedGenres, tags: parsedTags };
}

export async function getBookBySlug(
  slug: string,
): Promise<BookWithDetails | null> {
  const row = sqlite
    .prepare(`${bookDetailSql} WHERE b.slug = ? LIMIT 1`)
    .get(slug) as Record<string, unknown> | undefined;

  return row ? rowToBookWithDetails(row) : null;
}

export async function getBookById(id: number): Promise<BookWithDetails | null> {
  const row = sqlite
    .prepare(`${bookDetailSql} WHERE b.id = ? LIMIT 1`)
    .get(id) as Record<string, unknown> | undefined;

  return row ? rowToBookWithDetails(row) : null;
}

// ─── Rankings ────────────────────────────────────────────────────────────────

export async function getRankedBooks(
  metric: RankingMetric,
  limit: number = 10,
  genreSlug?: string,
  status?: number,
  includeVietnamese: boolean = true,
  source?: BookSource,
): Promise<BookWithAuthor[]> {
  const result = await getRankedBooksPaginated(
    metric,
    1,
    limit,
    genreSlug,
    status,
    includeVietnamese,
    source,
  );
  return result.data;
}

export async function getRankedBooksPaginated(
  metric: RankingMetric,
  page: number = 1,
  limit: number = 50,
  genreSlug?: string,
  status?: number,
  vietnameseOnly?: boolean,
  source?: BookSource,
): Promise<PaginatedResponse<BookWithAuthor>> {
  const safeMetric = VALID_SORT.has(metric) ? metric : "view_count";
  const safePage = Math.max(1, page);
  const offset = (safePage - 1) * limit;

  const conditions: string[] = [];
  const condParams: unknown[] = [];

  if (genreSlug) {
    conditions.push("genres.slug = ?");
    condParams.push(genreSlug);
  }
  if (status) {
    conditions.push("books.status = ?");
    condParams.push(status);
  }
  if (!vietnameseOnly) {
    conditions.push("CAST(books.author_id AS TEXT) NOT LIKE '999%'");
  }
  if (source) {
    conditions.push("books.source = ?");
    condParams.push(source);
  }

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const joinClause = genreSlug
    ? `INNER JOIN book_genres ON books.id = book_genres.book_id
       INNER JOIN genres ON book_genres.genre_id = genres.id`
    : "";

  const countSql = `
    SELECT COUNT(*) as cnt
    FROM books
    LEFT JOIN authors ON books.author_id = authors.id
    ${joinClause}
    ${whereClause}
  `;
  const countRow = sqlite.prepare(countSql).get(...condParams) as {
    cnt: number;
  };
  const total = countRow?.cnt ?? 0;

  const dataSql = `
    SELECT books.*,
           authors.name as author_name,
           authors.local_name as author_local_name,
           authors.avatar as author_avatar
    FROM books
    LEFT JOIN authors ON books.author_id = authors.id
    ${joinClause}
    ${whereClause}
    ORDER BY books.${safeMetric} DESC${safeMetric === "review_score" ? ", books.review_count DESC" : ""}
    LIMIT ? OFFSET ?
  `;

  const rows = sqlite
    .prepare(dataSql)
    .all(...condParams, limit, offset) as Record<string, unknown>[];
  return {
    data: rows.map(rowToBookWithAuthor),
    total,
    page: safePage,
    limit,
    totalPages: Math.ceil(total / limit),
  };
}

// ─── Genres ──────────────────────────────────────────────────────────────────

export async function getGenresWithCounts(
  source?: BookSource,
): Promise<GenreWithCount[]> {
  const sourceJoin = source ? "AND b.source = ?" : "";
  const params = source ? [source] : [];

  const rows = sqlite
    .prepare(
      `SELECT g.id, g.name, g.slug, COUNT(b.id) as book_count
       FROM genres g
       LEFT JOIN book_genres bg ON g.id = bg.genre_id
       LEFT JOIN books b ON bg.book_id = b.id ${sourceJoin}
       GROUP BY g.id
       HAVING book_count > 0
       ORDER BY book_count DESC`,
    )
    .all(...params) as {
    id: number;
    name: string;
    slug: string;
    book_count: number;
  }[];

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    slug: r.slug,
    bookCount: r.book_count,
  }));
}

// ─── Chapters ────────────────────────────────────────────────────────────────

export function getAllChapterTitles(
  bookId: number,
): { indexNum: number; title: string }[] {
  return sqlite
    .prepare(
      "SELECT index_num AS indexNum, title FROM chapters WHERE book_id = ? ORDER BY index_num ASC",
    )
    .all(bookId) as { indexNum: number; title: string }[];
}

export async function getChaptersByBookId(
  bookId: number,
  page: number = 1,
  limit: number = 50,
): Promise<
  PaginatedResponse<{
    id: number;
    indexNum: number;
    title: string;
    slug: string | null;
  }>
> {
  const offset = (Math.max(1, page) - 1) * limit;

  const rows = await db
    .select({
      id: chapters.id,
      indexNum: chapters.indexNum,
      title: chapters.title,
      slug: chapters.slug,
    })
    .from(chapters)
    .where(eq(chapters.bookId, bookId))
    .orderBy(asc(chapters.indexNum))
    .limit(limit)
    .offset(offset);

  const countResult = sqlite
    .prepare("SELECT COUNT(*) as cnt FROM chapters WHERE book_id = ?")
    .get(bookId) as { cnt: number } | undefined;
  const total = countResult?.cnt ?? 0;

  return {
    data: rows,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };
}

export async function getChapter(bookId: number, indexNum: number) {
  const row = await db
    .select()
    .from(chapters)
    .where(and(eq(chapters.bookId, bookId), eq(chapters.indexNum, indexNum)))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  if (!row) return null;
  return {
    ...row,
    body: readChapterBody(bookId, indexNum),
  };
}

// ─── Search ──────────────────────────────────────────────────────────────────

export function searchBooks(
  query: string,
  limit: number = 20,
  offset: number = 0,
  source?: BookSource,
) {
  const sourceCond = source ? "AND books.source = ?" : "";
  const params: unknown[] = [query];
  if (source) params.push(source);
  params.push(limit, offset);

  const stmt = sqlite.prepare(`
    SELECT books.*, highlight(books_fts, 0, '<mark>', '</mark>') as hl_name
    FROM books_fts
    JOIN books ON books.id = books_fts.rowid
    WHERE books_fts MATCH ? ${sourceCond}
    ORDER BY rank
    LIMIT ? OFFSET ?
  `);
  return stmt.all(...params) as (Record<string, unknown> & {
    hl_name: string;
  })[];
}

// ─── Library Stats ───────────────────────────────────────────────────────────

export async function getLibraryStats(
  source?: BookSource,
): Promise<LibraryStats> {
  const sourceWhere = source ? "WHERE source = ?" : "";
  const sourceParams = source ? [source] : [];

  const stats = sqlite
    .prepare(
      `SELECT
        COUNT(*) as total_books,
        SUM(chapters_saved) as total_chapters,
        SUM(CASE WHEN status = 2 THEN 1 ELSE 0 END) as completed_books,
        SUM(word_count) as total_words
      FROM books ${sourceWhere}`,
    )
    .get(...sourceParams) as {
    total_books: number;
    total_chapters: number;
    completed_books: number;
    total_words: number;
  };

  let genreCountSql: string;
  let genreCountParams: unknown[] = [];
  if (source) {
    genreCountSql = `SELECT COUNT(DISTINCT bg.genre_id) as cnt FROM book_genres bg JOIN books b ON bg.book_id = b.id WHERE b.source = ?`;
    genreCountParams = [source];
  } else {
    genreCountSql = "SELECT COUNT(*) as cnt FROM genres";
  }
  const genreCount = sqlite.prepare(genreCountSql).get(...genreCountParams) as {
    cnt: number;
  };

  return {
    totalBooks: stats.total_books ?? 0,
    totalChapters: stats.total_chapters ?? 0,
    completedBooks: stats.completed_books ?? 0,
    totalWords: stats.total_words ?? 0,
    totalGenres: genreCount.cnt ?? 0,
  };
}

// ─── Book Primary Genre ─────────────────────────────────────────────────────

export function getBookPrimaryGenres(
  bookIds: number[],
): Record<number, { id: number; name: string; slug: string }> {
  if (bookIds.length === 0) return {};
  const placeholders = bookIds.map(() => "?").join(",");
  const rows = sqlite
    .prepare(
      `SELECT bg.book_id, g.id, g.name, g.slug
       FROM book_genres bg
       JOIN genres g ON bg.genre_id = g.id
       WHERE bg.book_id IN (${placeholders})
       GROUP BY bg.book_id`,
    )
    .all(...bookIds) as {
    book_id: number;
    id: number;
    name: string;
    slug: string;
  }[];

  const map: Record<number, { id: number; name: string; slug: string }> = {};
  for (const r of rows) {
    if (!map[r.book_id]) {
      map[r.book_id] = { id: r.id, name: r.name, slug: r.slug };
    }
  }
  return map;
}

// ─── Author ─────────────────────────────────────────────────────────────────

export async function getAuthorById(id: number) {
  return db
    .select()
    .from(authors)
    .where(eq(authors.id, id))
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

export interface AuthorStats {
  totalBooks: number;
  totalWords: number;
  totalChapters: number;
}

export function getAuthorStats(
  authorId: number,
  source?: BookSource,
): AuthorStats {
  const sourceCond = source ? "AND source = ?" : "";
  const params: unknown[] = [authorId];
  if (source) params.push(source);

  const row = sqlite
    .prepare(
      `SELECT COUNT(*) as total_books,
              COALESCE(SUM(word_count), 0) as total_words,
              COALESCE(SUM(chapter_count), 0) as total_chapters
       FROM books WHERE author_id = ? ${sourceCond}`,
    )
    .get(...params) as
    | { total_books: number; total_words: number; total_chapters: number }
    | undefined;

  return {
    totalBooks: row?.total_books ?? 0,
    totalWords: row?.total_words ?? 0,
    totalChapters: row?.total_chapters ?? 0,
  };
}

export function getLatestChaptersByAuthor(
  authorId: number,
  bookLimit: number = 5,
  chaptersPerBook: number = 3,
  source?: BookSource,
): Array<{
  bookId: number;
  bookName: string;
  bookSlug: string;
  bookCoverUrl: string | null;
  chapterCount: number;
  status: number;
  synopsis: string | null;
  chapters: Array<{ indexNum: number; title: string }>;
}> {
  const sourceCond = source ? "AND source = ?" : "";
  const params: unknown[] = [authorId];
  if (source) params.push(source);
  params.push(bookLimit);

  const booksRows = sqlite
    .prepare(
      `SELECT id, name, slug, cover_url, chapter_count, status, synopsis
       FROM books WHERE author_id = ? ${sourceCond}
       ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(...params) as Array<{
    id: number;
    name: string;
    slug: string;
    cover_url: string | null;
    chapter_count: number;
    status: number;
    synopsis: string | null;
  }>;

  return booksRows.map((b) => {
    const chaps = sqlite
      .prepare(
        `SELECT index_num, title FROM chapters
         WHERE book_id = ? ORDER BY index_num DESC LIMIT ?`,
      )
      .all(b.id, chaptersPerBook) as Array<{
      index_num: number;
      title: string;
    }>;

    return {
      bookId: b.id,
      bookName: b.name,
      bookSlug: b.slug,
      bookCoverUrl: b.cover_url,
      chapterCount: b.chapter_count,
      status: b.status,
      synopsis: b.synopsis,
      chapters: chaps.map((c) => ({
        indexNum: c.index_num,
        title: c.title,
      })),
    };
  });
}

export async function getBooksByAuthorId(
  authorId: number,
  page: number = 1,
  limit: number = 20,
  source?: BookSource,
): Promise<PaginatedResponse<BookWithAuthor>> {
  const offset = (Math.max(1, page) - 1) * limit;

  const sourceCond = source ? "AND books.source = ?" : "";

  const dataSql = `
    SELECT books.*,
           authors.name as author_name,
           authors.local_name as author_local_name,
           authors.avatar as author_avatar
    FROM books
    LEFT JOIN authors ON books.author_id = authors.id
    WHERE books.author_id = ? ${sourceCond}
    ORDER BY books.updated_at DESC
    LIMIT ? OFFSET ?
  `;

  const countSql = `SELECT COUNT(*) as cnt FROM books WHERE author_id = ? ${source ? "AND source = ?" : ""}`;

  const dataParams: unknown[] = [authorId];
  if (source) dataParams.push(source);
  dataParams.push(limit, offset);

  const countParams: unknown[] = [authorId];
  if (source) countParams.push(source);

  const rows = sqlite.prepare(dataSql).all(...dataParams) as Record<
    string,
    unknown
  >[];
  const countRow = sqlite.prepare(countSql).get(...countParams) as {
    cnt: number;
  };
  const total = countRow?.cnt ?? 0;

  return {
    data: rows.map(rowToBookWithAuthor),
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };
}

// ─── Author Listing ─────────────────────────────────────────────────────────

export interface AuthorWithBookCount {
  id: number;
  name: string;
  localName: string | null;
  avatar: string | null;
  bookCount: number;
  totalWordCount: number;
}

export type AuthorSortField = "book_count" | "word_count";

export function getAuthorsWithBookCounts(
  page: number = 1,
  limit: number = 60,
  search?: string,
  sort: AuthorSortField = "book_count",
  source?: BookSource,
): PaginatedResponse<AuthorWithBookCount> {
  const offset = (Math.max(1, page) - 1) * limit;

  const sourceCond = source ? "AND b.source = ?" : "";

  const searchCond = search
    ? "WHERE (a.name LIKE ? OR a.local_name LIKE ?)"
    : "";
  const searchParams = search ? [`%${search}%`, `%${search}%`] : [];

  const orderBy =
    sort === "word_count"
      ? "totalWordCount DESC, a.name ASC"
      : "bookCount DESC, a.name ASC";

  const dataSql = `
    SELECT a.id, a.name, a.local_name AS localName, a.avatar,
           COUNT(b.id) as bookCount,
           COALESCE(SUM(b.word_count), 0) as totalWordCount
    FROM authors a
    LEFT JOIN books b ON a.id = b.author_id ${sourceCond}
    ${searchCond}
    GROUP BY a.id
    HAVING bookCount > 0
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `;

  const sourceParams: unknown[] = source ? [source] : [];

  const rows = sqlite
    .prepare(dataSql)
    .all(
      ...sourceParams,
      ...searchParams,
      limit,
      offset,
    ) as (AuthorWithBookCount & { totalWordCount: number })[];

  const countSql = `
    SELECT COUNT(*) as cnt FROM (
      SELECT a.id
      FROM authors a
      LEFT JOIN books b ON a.id = b.author_id ${sourceCond}
      ${searchCond}
      GROUP BY a.id
      HAVING COUNT(b.id) > 0
    )
  `;
  const countRow = sqlite
    .prepare(countSql)
    .get(...sourceParams, ...searchParams) as { cnt: number };
  const total = countRow?.cnt ?? 0;

  return {
    data: rows,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };
}

// ─── Author Search ──────────────────────────────────────────────────────────

export function searchAuthors(query: string, limit: number = 20) {
  return sqlite
    .prepare(
      `SELECT a.*, COUNT(b.id) as book_count
       FROM authors a
       LEFT JOIN books b ON a.id = b.author_id
       WHERE a.name LIKE ? OR a.local_name LIKE ?
       GROUP BY a.id
       ORDER BY book_count DESC
       LIMIT ?`,
    )
    .all(`%${query}%`, `%${query}%`, limit) as {
    id: number;
    name: string;
    local_name: string | null;
    avatar: string | null;
    book_count: number;
  }[];
}
