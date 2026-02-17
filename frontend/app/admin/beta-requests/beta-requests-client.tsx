"use client";

import { useMemo, useState } from "react";

export interface BetaRequestRow {
  email: string;
  description: string;
  tosAcceptedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  accountExists: boolean;
  inviteStatus: "none" | "pending" | "used" | "revoked" | "expired";
  inviteStatusLabel: string;
  inviteSentAt: string | null;
  inviteExpiresAt: string | null;
  inviteUsedAt: string | null;
}

interface Props {
  initialRows: BetaRequestRow[];
}

function formatDateTime(value: string | null): string {
  if (!value) return "N/A";
  return new Date(value).toLocaleString();
}

export default function BetaRequestsClient({ initialRows }: Props) {
  const [rows, setRows] = useState<BetaRequestRow[]>(initialRows);
  const [loadingEmail, setLoadingEmail] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sortedRows = useMemo(
    () =>
      [...rows].sort((a, b) => {
        const at = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
        const bt = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
        return bt - at;
      }),
    [rows]
  );

  const handleSendInvite = async (email: string) => {
    setLoadingEmail(email);
    setMessage(null);
    setError(null);

    try {
      const res = await fetch("/api/admin/beta-invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email })
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(String(data?.error || "Failed to send invite"));
        return;
      }

      const nowIso = new Date().toISOString();
      setRows((prev) =>
        prev.map((row) =>
          row.email === email
            ? {
                ...row,
                inviteStatus: "pending",
                inviteStatusLabel: "Invite pending",
                inviteSentAt: nowIso,
                inviteExpiresAt: typeof data?.expiresAt === "string" ? data.expiresAt : row.inviteExpiresAt,
                inviteUsedAt: null,
                updatedAt: nowIso
              }
            : row
        )
      );
      setMessage(`Invite sent to ${email}`);
    } catch (err: any) {
      setError(String(err?.message || "Failed to send invite"));
    } finally {
      setLoadingEmail(null);
    }
  };

  const handleRevokeInvite = async (email: string) => {
    setLoadingEmail(email);
    setMessage(null);
    setError(null);

    try {
      const res = await fetch("/api/admin/beta-invites", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email })
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(String(data?.error || "Failed to revoke invite"));
        return;
      }

      const nowIso = new Date().toISOString();
      setRows((prev) =>
        prev.map((row) =>
          row.email === email
            ? {
                ...row,
                inviteStatus: "revoked",
                inviteStatusLabel: "Invite revoked",
                inviteUsedAt: null,
                updatedAt: nowIso
              }
            : row
        )
      );
      setMessage(`Invite revoked for ${email}`);
    } catch (err: any) {
      setError(String(err?.message || "Failed to revoke invite"));
    } finally {
      setLoadingEmail(null);
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

      {sortedRows.length === 0 ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">No beta requests yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 dark:divide-slate-700">
            <thead className="bg-slate-50 dark:bg-slate-900">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  Email
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  Request
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  Request Time
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  Invite Status
                </th>
                <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  Action
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 bg-white dark:divide-slate-700 dark:bg-slate-800">
              {sortedRows.map((row) => (
                <tr key={row.email} className="hover:bg-slate-50 dark:hover:bg-slate-700/50">
                  <td className="px-4 py-3 text-sm text-slate-900 dark:text-slate-100">
                    <div className="font-medium">{row.email}</div>
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                      TOS accepted: {formatDateTime(row.tosAcceptedAt)}
                    </div>
                    {row.accountExists ? (
                      <span className="mt-1 inline-flex rounded bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-200">
                        Account exists
                      </span>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-sm text-slate-700 dark:text-slate-300">
                    <div className="max-w-md whitespace-pre-wrap">{row.description || "N/A"}</div>
                  </td>
                  <td className="px-4 py-3 text-sm text-slate-500 dark:text-slate-400">
                    <div>Created: {formatDateTime(row.createdAt)}</div>
                    <div>Updated: {formatDateTime(row.updatedAt)}</div>
                  </td>
                  <td className="px-4 py-3 text-sm text-slate-700 dark:text-slate-300">
                    <div className="font-medium">{row.inviteStatusLabel}</div>
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                      Sent: {formatDateTime(row.inviteSentAt)}
                    </div>
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                      Expires: {formatDateTime(row.inviteExpiresAt)}
                    </div>
                    {row.inviteUsedAt ? (
                      <div className="text-xs text-slate-500 dark:text-slate-400">
                        Accepted: {formatDateTime(row.inviteUsedAt)}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => handleSendInvite(row.email)}
                        disabled={loadingEmail === row.email}
                        className="rounded border border-cyan-300 bg-cyan-50 px-3 py-1 text-xs font-semibold text-cyan-700 hover:bg-cyan-100 disabled:opacity-60 dark:border-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-200"
                      >
                        {loadingEmail === row.email ? "Working..." : row.accountExists ? "Resend Invite" : "Send Invite"}
                      </button>
                      {row.inviteStatus === "pending" ? (
                        <button
                          type="button"
                          onClick={() => handleRevokeInvite(row.email)}
                          disabled={loadingEmail === row.email}
                          className="rounded border border-rose-300 bg-rose-50 px-3 py-1 text-xs font-semibold text-rose-700 hover:bg-rose-100 disabled:opacity-60 dark:border-rose-700 dark:bg-rose-900/30 dark:text-rose-200"
                        >
                          {loadingEmail === row.email ? "Working..." : "Revoke"}
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
