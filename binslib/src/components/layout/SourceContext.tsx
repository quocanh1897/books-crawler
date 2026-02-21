"use client";

import {
  createContext,
  useContext,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";

export type BookSource = "mtc" | "ttv";

const SOURCE_COOKIE = "book_source";

interface SourceContextValue {
  source: BookSource;
  setSource: (s: BookSource) => void;
  toggle: () => void;
}

const SourceContext = createContext<SourceContextValue>({
  source: "mtc",
  setSource: () => {},
  toggle: () => {},
});

export function SourceProvider({
  children,
  initialSource = "mtc",
}: {
  children: ReactNode;
  initialSource?: BookSource;
}) {
  const [source, setSourceState] = useState<BookSource>(initialSource);
  const router = useRouter();

  const setSource = useCallback(
    (s: BookSource) => {
      setSourceState(s);
      document.cookie = `${SOURCE_COOKIE}=${s};path=/;max-age=${60 * 60 * 24 * 365};samesite=lax`;
      router.refresh();
    },
    [router]
  );

  const toggle = useCallback(() => {
    setSource(source === "mtc" ? "ttv" : "mtc");
  }, [source, setSource]);

  return (
    <SourceContext.Provider value={{ source, setSource, toggle }}>
      {children}
    </SourceContext.Provider>
  );
}

export function useSource() {
  return useContext(SourceContext);
}
