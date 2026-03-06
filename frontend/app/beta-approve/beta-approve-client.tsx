"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

interface ApprovalPreview {
  email: string;
  description: string;
  createdAt: string | null;
  expiresAt: string | null;
}

function formatDateTime(value: string | null): string {
  if (!value) return "N/A";
  return new Date(value).toLocaleString();
}

export default function BetaApproveClient({ token }: { token: string }) {
  const [preview, setPreview] = useState<ApprovalPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const disabled = useMemo(() => loading || submitting || !preview, [loading, submitting, preview]);

  useEffect(() => {
    let cancelled = false;

    async function loadPreview() {
      if (!token) {
        setError("Approval token is missing.");
        setLoading(false);
        return;
      }

      setLoading(true);
      setError(null);
      setMessage(null);

      try {
        const res = await fetch(`/api/beta-interest/approve?token=${encodeURIComponent(token)}`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          if (!cancelled) {
            setError(String(data?.error || "Failed to load approval request."));
          }
          return;
        }
        if (!cancelled) {
          setPreview({
            email: String(data.email || ""),
            description: String(data.description || ""),
            createdAt: typeof data.createdAt === "string" ? data.createdAt : null,
            expiresAt: typeof data.expiresAt === "string" ? data.expiresAt : null,
          });
        }
      } catch (err: any) {
        if (!cancelled) {
          setError(String(err?.message || "Failed to load approval request."));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void loadPreview();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const handleApprove = async () => {
    if (!token) return;

    setSubmitting(true);
    setError(null);
    setMessage(null);

    try {
      const res = await fetch("/api/beta-interest/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(String(data?.error || "Failed to send invite."));
        return;
      }
      setMessage(`Invite sent to ${String(data?.email || preview?.email || "the requester")}.`);
    } catch (err: any) {
      setError(String(err?.message || "Failed to send invite."));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-4">
      {message ? (
        <p className="rounded border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-200">
          {message}
        </p>
      ) : null}
      {error ? (
        <p className="rounded border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-800 dark:bg-rose-900/30 dark:text-rose-200">
          {error}
        </p>
      ) : null}

      {preview ? (
        <div className="space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm dark:border-slate-700 dark:bg-slate-950/40">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Requester</div>
            <div className="mt-1 font-medium text-slate-900 dark:text-slate-100">{preview.email}</div>
          </div>
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Request</div>
            <div className="mt-1 whitespace-pre-wrap text-slate-700 dark:text-slate-300">{preview.description || "N/A"}</div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Submitted</div>
              <div className="mt-1 text-slate-700 dark:text-slate-300">{formatDateTime(preview.createdAt)}</div>
            </div>
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Approval Link Expires</div>
              <div className="mt-1 text-slate-700 dark:text-slate-300">{formatDateTime(preview.expiresAt)}</div>
            </div>
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={disabled || !!message}
          onClick={handleApprove}
          className="rounded border border-cyan-300 bg-cyan-50 px-4 py-2 text-sm font-semibold text-cyan-700 transition hover:bg-cyan-100 disabled:opacity-60 dark:border-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-200"
        >
          {submitting ? "Sending Invite..." : "Approve and Send Invite"}
        </button>
        <Link href="/admin/beta-requests" className="text-sm text-cyan-700 underline hover:text-cyan-800 dark:text-cyan-300">
          Open Beta Inbox
        </Link>
      </div>
    </div>
  );
}
