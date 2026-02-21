import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { compareSync } from "bcryptjs";
import { sqlite } from "@/db";

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [
    Credentials({
      name: "credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const email = credentials?.email as string;
        const password = credentials?.password as string;
        if (!email || !password) return null;

        const user = sqlite
          .prepare("SELECT id, email, username, password_hash, avatar FROM users WHERE email = ?")
          .get(email) as
          | { id: number; email: string; username: string; password_hash: string; avatar: string | null }
          | undefined;

        if (!user) return null;
        if (!compareSync(password, user.password_hash)) return null;

        return {
          id: String(user.id),
          email: user.email,
          name: user.username,
          image: user.avatar,
        };
      },
    }),
  ],
  session: { strategy: "jwt" },
  pages: {
    signIn: "/dang-nhap",
  },
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user && token.id) {
        session.user.id = token.id as string;
      }
      return session;
    },
  },
});
