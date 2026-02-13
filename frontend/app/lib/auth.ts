import type { NextAuthOptions, Session } from "next-auth";
import NextAuth from "next-auth";
import EmailProvider from "next-auth/providers/email";
import GoogleProvider from "next-auth/providers/google";
import GitHubProvider from "next-auth/providers/github";
import { MongoDBAdapter } from "@next-auth/mongodb-adapter";
import clientPromise from "./mongo";
import * as nodemailer from "nodemailer";

export const authOptions: NextAuthOptions = {
  session: { strategy: "jwt" },
  pages: {
    signIn: "/beta-preview"
  },
  // We will sign API-bound tokens with HS256 ourselves; NextAuth secret is for its own JWT/cookies
  secret: process.env.NEXTAUTH_SECRET,
  // Required for Email provider to store verification tokens
  adapter: MongoDBAdapter(clientPromise),
  debug: !!process.env.NEXTAUTH_DEBUG,
  providers: [
    ...(process.env.EMAIL_SERVER && process.env.EMAIL_FROM
      ? [EmailProvider({
          server: process.env.EMAIL_SERVER,
          from: process.env.EMAIL_FROM,
          async sendVerificationRequest({ identifier, url, provider, theme }) {
            const transport = nodemailer.createTransport(provider.server as any);
            const result = await transport
              .sendMail({
                to: identifier,
                from: provider.from as string,
                subject: `Sign in to OurTextScores`,
                text: `Sign in by clicking this link: ${url}`,
                html: `<p>Sign in by clicking this link:</p><p><a href="${url}">${url}</a></p>`
              })
              .catch((err) => {
                console.error("Email send failed:", err);
                throw err;
              });
            const failed = [...(result?.rejected || []), ...(result?.pending || [])];
            if (failed.length) {
              console.error("Email send rejected/pending:", failed);
              throw new Error(`Email(s) ${failed.join(", ")} could not be sent`);
            }
          }
        })]
      : []),
    ...(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
      ? [GoogleProvider({ clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET })]
      : []),
    ...(process.env.GITHUB_ID && process.env.GITHUB_SECRET
      ? [GitHubProvider({ clientId: process.env.GITHUB_ID, clientSecret: process.env.GITHUB_SECRET })]
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

        // Existing users can continue to sign in. Enforce TOS acknowledgement only for new signups.
        const existingUser = await db.collection("users").findOne(
          { email: candidate },
          { projection: { _id: 1 } }
        );
        if (existingUser) return true;

        const signupRecord = await db.collection("beta_interest_signups").findOne(
          { email: candidate, tosAcceptedAt: { $exists: true } },
          { projection: { _id: 1 } }
        );
        return Boolean(signupRecord);
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
