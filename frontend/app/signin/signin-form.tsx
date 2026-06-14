"use client";

import { FormEvent, useState } from "react";
import { signIn } from "next-auth/react";

type ProviderId = "email" | "google" | "github";

function messageFromErrorCode(code: string): string | null {
  if (!code) return null;
  if (code === "AccessDenied") {
    return "This account is not enabled yet. Request access or accept your invite first.";
  }
  if (code === "OAuthSignin") return "Could not start OAuth sign-in. Check provider configuration.";
  if (code === "OAuthCallback") return "OAuth callback failed. The provider may have rejected the request.";
  if (code === "Configuration") return "Authentication is misconfigured on the server.";
  if (code === "Callback") return "Authentication callback failed.";
  if (code === "Signin") return "Sign-in failed.";
  return `Sign-in failed (${code}).`;
}

export default function SignInForm({
  initialNext = "",
  emailEnabled,
  googleEnabled,
  githubEnabled,
  initialErrorCode = ""
}: {
  initialNext?: string;
  emailEnabled: boolean;
  googleEnabled: boolean;
  githubEnabled: boolean;
  initialErrorCode?: string;
}) {
  const [error, setError] = useState<string | null>(messageFromErrorCode(initialErrorCode));
  const [email, setEmail] = useState("");
  const [pendingProvider, setPendingProvider] = useState<ProviderId | null>(null);

  const callbackUrl =
    initialNext.startsWith("/") &&
    !initialNext.startsWith("//") &&
    !initialNext.startsWith("/signin")
      ? initialNext
      : "/catalogue";

  const startSignIn = async (provider: ProviderId, options: { callbackUrl: string; email?: string }) => {
    setError(null);
    setPendingProvider(provider);
    try {
      await signIn(provider, options);
    } catch (err: any) {
      setError(String(err?.message || "Sign-in could not be started."));
      setPendingProvider(null);
    }
  };

  const onProviderSignIn = (provider: "google" | "github") => {
    void startSignIn(provider, { callbackUrl });
  };

  const onEmailSignIn = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void startSignIn("email", { email, callbackUrl });
  };

  const noProvidersEnabled = !emailEnabled && !googleEnabled && !githubEnabled;
  const isPending = pendingProvider !== null;

  return (
    <div className="space-y-4">
      {noProvidersEnabled ? (
        <p className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-900/30 dark:text-amber-200">
          Sign-in is not configured yet. Contact an administrator.
        </p>
      ) : null}
      {error ? (
        <p className="rounded border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-800 dark:bg-rose-900/30 dark:text-rose-200">
          {error}
        </p>
      ) : null}

      {emailEnabled ? (
        <form onSubmit={onEmailSignIn} className="space-y-3">
          <label htmlFor="signin-email" className="block text-sm font-medium text-slate-700 dark:text-slate-200">
            Email
          </label>
          <input
            id="signin-email"
            name="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
          />
          <button
            type="submit"
            disabled={isPending}
            className="w-full rounded bg-cyan-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-cyan-700 disabled:opacity-60"
          >
            {isPending && pendingProvider === "email" ? "Sending magic link..." : "Send magic link"}
          </button>
        </form>
      ) : null}

      {emailEnabled && (googleEnabled || githubEnabled) ? (
        <div className="flex items-center gap-3 text-xs uppercase tracking-wide text-slate-400">
          <span className="h-px flex-1 bg-slate-200 dark:bg-slate-800" />
          or
          <span className="h-px flex-1 bg-slate-200 dark:bg-slate-800" />
        </div>
      ) : null}

      {googleEnabled ? (
        <button
          type="button"
          disabled={isPending}
          onClick={() => onProviderSignIn("google")}
          className="w-full rounded border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-800 transition hover:bg-slate-50 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800"
        >
          {isPending && pendingProvider === "google" ? "Signing in..." : "Continue with Google"}
        </button>
      ) : null}

      {githubEnabled ? (
        <button
          type="button"
          disabled={isPending}
          onClick={() => onProviderSignIn("github")}
          className="w-full rounded border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-800 transition hover:bg-slate-50 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800"
        >
          {isPending && pendingProvider === "github" ? "Signing in..." : "Continue with GitHub"}
        </button>
      ) : null}
    </div>
  );
}
