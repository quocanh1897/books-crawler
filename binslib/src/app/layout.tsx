import type { Metadata } from "next";
import { cookies } from "next/headers";
import { Header } from "@/components/layout/Header";
import { Footer } from "@/components/layout/Footer";
import { SourceProvider } from "@/components/layout/SourceContext";
import type { BookSource } from "@/lib/queries";
import "./globals.css";

export const metadata: Metadata = {
  title: "Binslib — Thư viện truyện",
  description: "Personal book library & statistics dashboard",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const cookieStore = await cookies();
  const source: BookSource =
    cookieStore.get("book_source")?.value === "ttv" ? "ttv" : "mtc";

  return (
    <html lang="vi">
      <body className="antialiased min-h-screen flex flex-col">
        <SourceProvider initialSource={source}>
          <Header />
          <main className="flex-1">{children}</main>
          <Footer />
        </SourceProvider>
      </body>
    </html>
  );
}
