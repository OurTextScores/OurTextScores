"use client";

import { useState, useTransition } from "react";
import { signIn } from "next-auth/react";

type ProviderId = "google" | "github";

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
  googleEnabled,
  githubEnabled,
  initialErrorCode = ""
}: {
  initialNext?: string;
  googleEnabled: boolean;
  githubEnabled: boolean;
  initialErrorCode?: string;
}) {
  const [error, setError] = useState<string | null>(messageFromErrorCode(initialErrorCode));
  const [pendingProvider, setPendingProvider] = useState<ProviderId | null>(null);
  const [isPending, startTransition] = useTransition();

  const callbackUrl =
    initialNext.startsWith("/") &&
    !initialNext.startsWith("//") &&
    !initialNext.startsWith("/signin")
      ? initialNext
      : "/catalogue";

  const onProviderSignIn = (provider: ProviderId) => {
    setError(null);
    setPendingProvider(provider);

    startTransition(async () => {
      try {
        await signIn(provider, { callbackUrl });
      } catch (err: any) {
        setError(String(err?.message || "Sign-in could not be started."));
        setPendingProvider(null);
      }
    });
  };

  const noProvidersEnabled = !googleEnabled && !githubEnabled;

  return (
    <div className="space-y-4">
      {noProvidersEnabled ? (
        <p className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-900/30 dark:text-amber-200">
          OAuth sign-in is not configured yet. Contact admin to enable Google or GitHub sign-in.
        </p>
      ) : null}
      {error ? (
        <p className="rounded border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-800 dark:bg-rose-900/30 dark:text-rose-200">
          {error}
        </p>
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
