"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";

interface AuthorLinkProps {
  href: string;
  children: React.ReactNode;
  className?: string;
}

export function AuthorLink({ href, children, className }: AuthorLinkProps) {
  return (
    <Link
      href={href}
      className={className}
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </Link>
  );
}

interface ClickableRowProps {
  href: string;
  children: React.ReactNode;
  className?: string;
}

export function ClickableRow({ href, children, className }: ClickableRowProps) {
  const router = useRouter();
  return (
    <div
      role="link"
      tabIndex={0}
      onClick={() => router.push(href)}
      onKeyDown={(e) => { if (e.key === "Enter") router.push(href); }}
      className={className}
    >
      {children}
    </div>
  );
}
