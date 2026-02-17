import type { NextAuthOptions } from "next-auth";
import NextAuth from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import GitHubProvider from "next-auth/providers/github";
import { MongoDBAdapter } from "@next-auth/mongodb-adapter";
import { createHash } from "crypto";
import clientPromise from "./mongo";

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseEmailList(input: string | undefined): Set<string> {
  const text = String(input || "").trim();
  if (!text) return new Set();
  return new Set(
    text
      .split(/[,\s]+/)
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean)
  );
}

function hashForLog(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

const bootstrapEmails = parseEmailList(process.env.AUTH_BOOTSTRAP_EMAILS);
const bootstrapAdminEmails = parseEmailList(process.env.AUTH_BOOTSTRAP_ADMIN_EMAILS);
const bootstrapInProd = String(process.env.AUTH_BOOTSTRAP_ALLOW_IN_PROD || "").trim().toLowerCase() === "true";
const allowEmailAccountLinking =
  process.env.NODE_ENV !== "production" ||
  String(process.env.AUTH_ALLOW_EMAIL_ACCOUNT_LINKING || "").trim().toLowerCase() === "true";

function canBootstrapEmail(email: string): boolean {
  if (!bootstrapEmails.has(email)) return false;
  if (process.env.NODE_ENV === "production" && !bootstrapInProd) return false;
  return true;
}

export const authOptions: NextAuthOptions = {
  session: { strategy: "jwt" },
  pages: {
    signIn: "/signin",
    error: "/signin"
  },
  // We will sign API-bound tokens with HS256 ourselves; NextAuth secret is for its own JWT/cookies
  secret: process.env.NEXTAUTH_SECRET,
  // Adapter-backed users/accounts/sessions
  adapter: MongoDBAdapter(clientPromise),
  debug: !!process.env.NEXTAUTH_DEBUG,
  providers: [
    ...(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
      ? [
          GoogleProvider({
            clientId: process.env.GOOGLE_CLIENT_ID,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET,
            allowDangerousEmailAccountLinking: allowEmailAccountLinking
          })
        ]
      : []),
    ...(process.env.GITHUB_ID && process.env.GITHUB_SECRET
      ? [
          GitHubProvider({
            clientId: process.env.GITHUB_ID,
            clientSecret: process.env.GITHUB_SECRET,
            allowDangerousEmailAccountLinking: allowEmailAccountLinking
          })
        ]
      : [])
  ],
  callbacks: {
    async signIn({ user, email }) {
      const emailPayload = email as { email?: string } | undefined;
      const candidate = String(user?.email || emailPayload?.email || "").trim().toLowerCase();
      if (!candidate) return false;

      try {
        const client = await clientPromise;
        const db = client.db();

        // Existing users can sign in. Beta request records do not grant auth access.
        const existingUser = await db.collection("users").findOne(
          {
            email: {
              $regex: `^${escapeRegex(candidate)}$`,
              $options: "i"
            }
          },
          { projection: { _id: 1 } }
        );
        if (existingUser) return true;

        if (canBootstrapEmail(candidate)) {
          const now = new Date();
          const roles = bootstrapAdminEmails.has(candidate) ? ["user", "admin"] : ["user"];

          await db.collection("users").updateOne(
            { email: candidate },
            {
              $set: {
                email: candidate,
                roles,
                status: "active",
                enforcementStrikes: 0,
                updatedAt: now
              },
              $setOnInsert: {
                createdAt: now,
                notify: { watchPreference: "immediate" }
              }
            },
            { upsert: true }
          );

          console.warn(
            `[auth] bootstrap sign-in allowed emailHash=${hashForLog(candidate)} roles=${roles.join(",")}`
          );
          return true;
        }

        console.warn(`[auth] sign-in denied emailHash=${hashForLog(candidate)} reason=no_user`);
        return false;
      } catch (error) {
        console.error("signIn callback lookup failed:", error);
        return false;
      }
    },
    async jwt({ token, account, profile }) {
      if (account && profile) {
        // On sign in, enrich token
        token.email = token.email || (profile as any).email;
        token.name = token.name || (profile as any).name;
      }
      return token;
    },
    async session({ session, token }) {
      // Mirror token fields on session.user
      if (session.user) {
        session.user.email = (token as any).email as string | undefined;
        session.user.name = (token as any).name as string | undefined;
      }
      return session;
    }
  }
};

export const { auth: unstable_auth } = NextAuth(authOptions);
