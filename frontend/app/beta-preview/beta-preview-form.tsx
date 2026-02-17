"use client";

import Link from "next/link";
import { FormEvent, useState, useTransition } from "react";

type SubmitState = "idle" | "submitted";

export default function BetaPreviewForm() {
  const [email, setEmail] = useState("");
  const [description, setDescription] = useState("");
  const [tosAccepted, setTosAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<SubmitState>("idle");
  const [isPending, startTransition] = useTransition();

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);

    if (!email.trim()) {
      setError("Email is required.");
      return;
    }
    if (!description.trim()) {
      setError("Please complete the description field.");
      return;
    }
    if (!tosAccepted) {
      setError("You must acknowledge the Terms of Service to register.");
      return;
    }

    startTransition(async () => {
      const res = await fetch("/api/beta-interest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email.trim(),
          description: description.trim(),
          tosAccepted: true
        })
      });

      if (!res.ok) {
        const text = await res.text();
        setError(text || "Failed to submit beta preview request.");
        return;
      }

      setState("submitted");
    });
  };

  if (state === "submitted") {
    return (
      <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-4 text-sm text-emerald-800 dark:border-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-200">
        Thanks. Your beta preview request was sent to the admin team. We will follow up if approved.
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <label className="block text-sm">
        <span className="mb-1 block font-medium text-slate-700 dark:text-slate-200">Email *</span>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          className="w-full rounded border border-slate-300 px-3 py-2 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
        />
      </label>

      <label className="block text-sm">
        <span className="mb-1 block font-medium text-slate-700 dark:text-slate-200">
          Please describe yourself, your use case and potential contributions to OurTextScores. *
        </span>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          required
          rows={6}
          className="w-full rounded border border-slate-300 px-3 py-2 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
        />
      </label>

      <label className="flex items-start gap-2 text-sm text-slate-700 dark:text-slate-200">
        <input
          type="checkbox"
          checked={tosAccepted}
          onChange={(e) => setTosAccepted(e.target.checked)}
          className="mt-1"
        />
        <span>
          I acknowledge and agree to the OurTextScores{" "}
          <Link href="/tos" className="text-cyan-700 underline hover:text-cyan-800 dark:text-cyan-300">
            Terms of Service
          </Link>{" "}
          for beta access. *
        </span>
      </label>

      {error ? (
        <p className="rounded border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-800 dark:bg-rose-900/30 dark:text-rose-200">
          {error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={isPending}
        className="rounded border border-cyan-300 bg-cyan-50 px-4 py-2 text-sm font-semibold text-cyan-700 transition hover:bg-cyan-100 disabled:opacity-60 dark:border-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-200"
      >
        {isPending ? "Submitting..." : "Request Beta Access"}
      </button>
    </form>
  );
}
