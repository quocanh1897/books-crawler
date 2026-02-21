import type { InferSelectModel } from "drizzle-orm";
import type {
  books,
  authors,
  genres,
  tags,
  chapters,
  users,
} from "@/db/schema";

export type Book = InferSelectModel<typeof books>;
export type Author = InferSelectModel<typeof authors>;
export type Genre = InferSelectModel<typeof genres>;
export type Tag = InferSelectModel<typeof tags>;
export type Chapter = InferSelectModel<typeof chapters>;
export type User = InferSelectModel<typeof users>;

export type BookWithAuthor = Book & {
  author: Author | null;
};

export type BookWithDetails = BookWithAuthor & {
  genres: Genre[];
  tags: Tag[];
};

export type GenreWithCount = Genre & {
  bookCount: number;
};

export type RankingMetric = "vote_count" | "view_count" | "comment_count" | "bookmark_count" | "review_score";

export type BookStatus = 1 | 2 | 3; // 1=ongoing, 2=completed, 3=paused

export const STATUS_LABELS: Record<number, string> = {
  1: "Còn tiếp",
  2: "Hoàn thành",
  3: "Tạm dừng",
};

export const STATUS_COLORS: Record<number, string> = {
  1: "text-green-600 bg-green-50 border-green-200",
  2: "text-blue-600 bg-blue-50 border-blue-200",
  3: "text-yellow-600 bg-yellow-50 border-yellow-200",
};

export const METRIC_LABELS: Record<RankingMetric, string> = {
  vote_count: "Đề cử",
  view_count: "Lượt đọc",
  comment_count: "Bình luận",
  bookmark_count: "Yêu thích",
  review_score: "Đánh giá",
};

export interface SearchResult {
  books: BookWithAuthor[];
  chapters: {
    id: number;
    bookId: number;
    bookName: string;
    bookSlug: string;
    indexNum: number;
    title: string;
    snippet: string;
  }[];
  authors: (Author & { bookCount: number })[];
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface LibraryStats {
  totalBooks: number;
  totalChapters: number;
  completedBooks: number;
  totalWords: number;
  totalGenres: number;
}
