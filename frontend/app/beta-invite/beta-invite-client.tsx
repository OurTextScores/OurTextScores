"use client";

import Link from "next/link";
import { useState, useTransition } from "react";

type State = "idle" | "accepted";

export default function BetaInviteClient({ token }: { token: string }) {
  const [state, setState] = useState<State>("idle");
  const [acceptedEmail, setAcceptedEmail] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const hasToken = Boolean(token && token.trim());

  const onAccept = () => {
    if (!hasToken) return;
    setError(null);

    startTransition(async () => {
      try {
        const res = await fetch("/api/beta-invite/accept", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setError(String(data?.error || "Invite activation failed"));
          return;
        }

        setAcceptedEmail(String(data?.email || ""));
        setState("accepted");
      } catch (err: any) {
        setError(String(err?.message || "Invite activation failed"));
      }
    });
  };

  if (!hasToken) {
    return (
      <p className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-900/30 dark:text-amber-200">
        Missing invite token. Open the full invite link from your email.
      </p>
    );
  }

  if (state === "accepted") {
    return (
      <div className="space-y-4">
        <p className="rounded border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-200">
          Invite accepted{acceptedEmail ? ` for ${acceptedEmail}` : ""}. You can now sign in.
        </p>
        <Link
          href="/signin"
          className="inline-block rounded border border-cyan-300 bg-cyan-50 px-4 py-2 text-sm font-semibold text-cyan-700 hover:bg-cyan-100 dark:border-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-200"
        >
          Continue to Sign In
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-600 dark:text-slate-300">
        Click below to activate your invite. This link can only be used once.
      </p>

      {error ? (
        <p className="rounded border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-800 dark:bg-rose-900/30 dark:text-rose-200">
          {error}
        </p>
      ) : null}

      <button
        type="button"
        onClick={onAccept}
        disabled={isPending}
        className="rounded border border-cyan-300 bg-cyan-50 px-4 py-2 text-sm font-semibold text-cyan-700 hover:bg-cyan-100 disabled:opacity-60 dark:border-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-200"
      >
        {isPending ? "Activating..." : "Activate Invite"}
      </button>
    </div>
  );
}
