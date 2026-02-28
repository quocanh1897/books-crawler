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
export type ChapterWithBody = Chapter & { body: string | null };
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

export type RankingMetric =
  | "vote_count"
  | "view_count"
  | "comment_count"
  | "bookmark_count"
  | "review_score"
  | "review_count";

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
  review_count: "Lượt đánh giá",
};

/**
 * Source-specific ranking tabs.
 *
 * Each source shows a different set of metrics in the "Bảng xếp hạng" page.
 * - MTC/TTV: standard metrics (vote_count, view_count, comment_count, bookmark_count, review_score)
 * - TF: "Top đánh giá" (review_score), "Top đề cử" (review_count), "Top hot" (vote_count)
 */
export type BookSourceType = "mtc" | "ttv" | "tf";

export interface RankingTab {
  metric: RankingMetric;
  label: string;
  /** For review_score, sort ties by review_count DESC */
  tiebreaker?: string;
}

export const SOURCE_RANKING_TABS: Record<BookSourceType, RankingTab[]> = {
  mtc: [
    { metric: "vote_count", label: "Đề cử" },
    { metric: "view_count", label: "Lượt đọc" },
    { metric: "comment_count", label: "Bình luận" },
    { metric: "bookmark_count", label: "Yêu thích" },
    { metric: "review_score", label: "Đánh giá", tiebreaker: "review_count" },
  ],
  ttv: [
    { metric: "vote_count", label: "Đề cử" },
    { metric: "view_count", label: "Lượt đọc" },
    { metric: "comment_count", label: "Bình luận" },
    { metric: "bookmark_count", label: "Yêu thích" },
    { metric: "review_score", label: "Đánh giá", tiebreaker: "review_count" },
  ],
  tf: [
    {
      metric: "review_score",
      label: "Top đánh giá",
      tiebreaker: "review_count",
    },
    { metric: "review_count", label: "Top đề cử" },
    { metric: "vote_count", label: "Top hot" },
  ],
};

export interface SearchResult {
  books: BookWithAuthor[];
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
