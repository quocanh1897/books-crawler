"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

export default function RegisterPage() {
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, username, password }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Đăng ký thất bại.");
        setLoading(false);
        return;
      }

      router.push("/dang-nhap");
    } catch {
      setError("Lỗi kết nối.");
      setLoading(false);
    }
  }

  return (
    <div className="max-w-md mx-auto px-4 py-12">
      <div className="bg-white rounded-lg border border-[var(--color-border)] p-6">
        <h1 className="text-xl font-bold text-center mb-6">Đăng ký</h1>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="w-full h-10 px-3 text-sm border border-[var(--color-border)] rounded-md focus:outline-none focus:border-[var(--color-primary)] focus:ring-1 focus:ring-[var(--color-primary)]"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Tên hiển thị</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              className="w-full h-10 px-3 text-sm border border-[var(--color-border)] rounded-md focus:outline-none focus:border-[var(--color-primary)] focus:ring-1 focus:ring-[var(--color-primary)]"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Mật khẩu</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={6}
              className="w-full h-10 px-3 text-sm border border-[var(--color-border)] rounded-md focus:outline-none focus:border-[var(--color-primary)] focus:ring-1 focus:ring-[var(--color-primary)]"
            />
            <p className="text-xs text-[var(--color-text-secondary)] mt-1">Tối thiểu 6 ký tự</p>
          </div>

          {error && (
            <p className="text-sm text-[var(--color-accent)]">{error}</p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full h-10 text-sm font-medium rounded-md bg-[var(--color-primary)] text-white hover:bg-[var(--color-primary-dark)] transition-colors disabled:opacity-60"
          >
            {loading ? "Đang đăng ký..." : "Đăng ký"}
          </button>
        </form>

        <p className="text-sm text-center mt-4 text-[var(--color-text-secondary)]">
          Đã có tài khoản?{" "}
          <Link href="/dang-nhap" className="text-[var(--color-primary)] hover:underline">
            Đăng nhập
          </Link>
        </p>
      </div>
    </div>
  );
}
