import { BookCard } from "./BookCard";
import type { BookWithAuthor } from "@/types";

export function BookGrid({ books }: { books: BookWithAuthor[] }) {
  if (books.length === 0) {
    return (
      <p className="text-sm text-[var(--color-text-secondary)] py-8 text-center">
        Kh&ocirc;ng c&oacute; truy&#7879;n n&agrave;o.
      </p>
    );
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      {books.map((book) => (
        <BookCard key={book.id} book={book} />
      ))}
    </div>
  );
}
