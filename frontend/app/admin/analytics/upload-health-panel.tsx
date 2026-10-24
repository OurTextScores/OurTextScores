"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Failure = {
  attemptId: string;
  at: string;
  operation: string;
  status: number;
  category: string;
  observation: string;
  resetAt?: string;
  userId?: string;
};
type Report = {
  generatedAt: string;
  startedAt: string;
  minutes: number;
  totals: {
    attempts: number;
    accepted: number;
    serverFailures: number;
    tooLarge: number;
    limited: number;
    unknown: number;
    clientObserved: number;
    averageDurationMs: number | null;
    lastEventAt: string | null;
  };
  health: { status: string; incidents: string[] };
  telemetry: { writeFailures: number; coverage: string; retentionDays: number };
  policy: { limit: number; disabled: boolean; scope: string };
  trend: { _id: string; attempts: number; rejected: number }[];
  categories: { _id: string; count: number }[];
  recentFailures: Failure[];
};
type Limits = {
  account: null | {
    userId: string;
    username?: string;
    email: string;
    count: number;
    resetAt: number | null;
    allowance: null | { limit: number; expiresAt: string };
  };
  audit: {
    actorId: string;
    userId: string;
    action: string;
    reason: string;
    at: string;
    limit?: number;
    expiresAt?: string;
  }[];
};
const inputClass =
  "rounded border border-slate-300 px-2 py-1.5 text-sm text-slate-900 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100";
const timestamp = (value: string | number | null | undefined) =>
  value
    ? new Date(value).toLocaleString(undefined, { timeZoneName: "short" })
    : "—";

async function api(path: string, body?: unknown) {
  const response = await fetch(`/api/proxy/operations/${path}`, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  const value = await response.json();
  if (!response.ok)
    throw new Error(
      value.message || value.error || `Request failed (${response.status})`,
    );
  return value;
}

export default function UploadHealthPanel() {
  const [minutes, setMinutes] = useState("60");
  const [operation, setOperation] = useState("");
  const [category, setCategory] = useState("");
  const [role, setRole] = useState("");
  const [report, setReport] = useState<Report | null>(null);
  const [limits, setLimits] = useState<Limits | null>(null);
  const [account, setAccount] = useState("");
  const [reason, setReason] = useState("");
  const [allowance, setAllowance] = useState("200");
  const [hours, setHours] = useState("2");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const load = useCallback(async () => {
    const current = ++generation.current;
    try {
      const query = new URLSearchParams({ minutes, operation, category, role });
      const result = await api(`uploads?${query}`);
      if (generation.current === current) {
        setReport(result);
        setError("");
      }
    } catch (e) {
      if (generation.current === current) {
        setReport(null);
        setError((e as Error).message);
      }
    }
  }, [minutes, operation, category, role]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 60000);
    return () => {
      clearInterval(timer);
      generation.current++;
    };
  }, [load]);
  const lookup = async () => {
    setLimits(await api("upload-limit-lookup", { account }));
  };
  const change = async (action: "reset" | "grant" | "revoke") => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api("upload-limits", {
        account,
        reason,
        action,
        limit: Number(allowance),
        expiresAt: new Date(Date.now() + Number(hours) * 3600000).toISOString(),
      });
      setNotice(
        action === "reset"
          ? "This account’s upload counter was reset on this backend process."
          : action === "grant"
            ? "The temporary hourly allowance is active."
            : "The temporary allowance was revoked.",
      );
      await lookup();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className="rounded-lg bg-white p-6 shadow-lg dark:bg-slate-800"
      aria-labelledby="upload-health-title"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="upload-health-title" className="text-xl font-semibold">
          Upload health
        </h2>
        <button className={inputClass} onClick={() => void load()}>
          Refresh upload health
        </button>
      </div>
      <p className="mt-2 text-sm text-slate-500">
        Operational traffic includes administrators. These windows are
        independent of the business analytics date range.
      </p>
      <div className="my-4 flex flex-wrap gap-3">
        <label className="text-sm">
          Window{" "}
          <select
            className={inputClass}
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
          >
            <option value="15">15 minutes</option>
            <option value="60">1 hour</option>
            <option value="1440">24 hours</option>
            <option value="10080">7 days</option>
          </select>
        </label>
        <label className="text-sm">
          Operation{" "}
          <select
            className={inputClass}
            value={operation}
            onChange={(e) => setOperation(e.target.value)}
          >
            <option value="">All operations</option>
            {["source", "revision", "project", "reference_pdf", "scanner"].map(
              (o) => (
                <option key={o}>{o}</option>
              ),
            )}
          </select>
        </label>
        <label className="text-sm">
          Outcome{" "}
          <select
            className={inputClass}
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          >
            <option value="">All outcomes</option>
            {[
              "accepted",
              "payload_too_large",
              "rate_limited",
              "authentication_or_permission",
              "server_failure",
              "invalid_request",
              "network_or_timeout",
            ].map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          Accounts{" "}
          <select
            className={inputClass}
            value={role}
            onChange={(e) => setRole(e.target.value)}
          >
            <option value="">All accounts</option>
            <option value="admin">Administrators</option>
            <option value="user">Users</option>
            <option value="anonymous">Anonymous</option>
          </select>
        </label>
      </div>
      {error && (
        <p role="alert" className="my-3 text-sm text-red-600">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="my-3 text-sm text-emerald-700">
          {notice}
        </p>
      )}
      {!report && !error && <p>Loading upload health…</p>}
      {report && (
        <>
          <p className="mb-3 text-sm">
            {report.health.status === "down"
              ? report.health.incidents.join(" · ")
              : report.totals.attempts
                ? "No upload incident thresholds exceeded."
                : "No upload outcomes recorded in this window; service availability is not inferred from inactivity."}
          </p>
          {report.policy.disabled && (
            <p role="alert" className="mb-3 text-amber-700">
              Upload rate limiting is disabled by a maintenance setting.
            </p>
          )}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {[
              ["Attempts", report.totals.attempts],
              ["Accepted requests", report.totals.accepted],
              ["HTTP 413", report.totals.tooLarge],
              ["HTTP 429", report.totals.limited],
              ["Server failures", report.totals.serverFailures],
              ["Unknown outcomes", report.totals.unknown],
              ["Client-only observations", report.totals.clientObserved],
              [
                "Average request time",
                report.totals.averageDurationMs === null
                  ? "—"
                  : `${Math.round(report.totals.averageDurationMs)} ms`,
              ],
            ].map(([label, value]) => (
              <div
                key={label}
                className="rounded border border-slate-200 p-3 dark:border-slate-700"
              >
                <div className="text-xs text-slate-500">{label}</div>
                <div className="text-xl font-semibold">{value}</div>
              </div>
            ))}
          </div>
          <p className="my-3 text-xs text-slate-500">
            As of {timestamp(report.generatedAt)} · Backend started {timestamp(report.startedAt)} · Last outcome{" "}
            {timestamp(report.totals.lastEventAt)} ·{" "}
            {report.telemetry.retentionDays}-day retention · Telemetry write
            failures since startup: {report.telemetry.writeFailures}
          </p>
          <p className="mb-4 text-xs text-slate-500">
            {report.telemetry.coverage}
          </p>
          <details className="mb-4">
            <summary className="cursor-pointer text-sm">
              Request trend (UTC buckets)
            </summary>
            <div className="mt-2 max-h-48 overflow-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr>
                    <th>UTC bucket</th>
                    <th>Attempts</th>
                    <th>HTTP errors</th>
                  </tr>
                </thead>
                <tbody>
                  {report.trend.map((t) => (
                    <tr key={t._id}>
                      <td>{t._id}</td>
                      <td>{t.attempts}</td>
                      <td>{t.rejected}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
          <h3 className="font-medium">Recent failures</h3>
          <div className="my-3 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Operation</th>
                  <th>Status / reason</th>
                  <th>Observed by</th>
                  <th>Retry/reset</th>
                </tr>
              </thead>
              <tbody>
                {report.recentFailures.map((f) => (
                  <tr
                    key={`${f.attemptId}:${f.userId}`}
                    className="border-t border-slate-200 dark:border-slate-700"
                  >
                    <td className="py-2">{timestamp(f.at)}</td>
                    <td>{f.operation}</td>
                    <td>
                      {f.status || "Unknown"} · {f.category}
                    </td>
                    <td>{f.observation}</td>
                    <td>{timestamp(f.resetAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!report.recentFailures.length && (
              <p className="my-3 text-sm text-slate-500">
                No failures recorded in this window.
              </p>
            )}
          </div>
          <p className="text-xs text-slate-500">
            Default allowance: {report.policy.limit} matched upload requests per
            hour. {report.policy.scope}
          </p>
        </>
      )}
      <details className="mt-6 border-t border-slate-200 pt-4 dark:border-slate-700">
        <summary className="cursor-pointer font-medium">
          Account upload limits and audit history
        </summary>
        <form
          className="mt-4 flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            setError("");
            void lookup().catch((e) => setError(e.message));
          }}
        >
          <label className="text-sm">
            Email or username{" "}
            <input
              className={`${inputClass} block`}
              required
              value={account}
              onChange={(e) => {
                setAccount(e.target.value);
                setLimits(null);
              }}
            />
          </label>
          <button className={inputClass}>Look up account</button>
        </form>
        {limits?.account && (
          <>
            <p className="my-3 text-sm">
              {limits.account.email}: {limits.account.count} requests this
              window. Reset: {timestamp(limits.account.resetAt)}.{" "}
              {limits.account.allowance
                ? `Allowance: ${limits.account.allowance.limit}/hour until ${timestamp(limits.account.allowance.expiresAt)}.`
                : "Default allowance applies."}
            </p>
            <label className="block text-sm">
              Reason for change{" "}
              <input
                className={`${inputClass} mt-1 block w-full`}
                minLength={5}
                maxLength={300}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
            <div className="mt-3 flex flex-wrap items-end gap-3">
              <label className="text-sm">
                Requests/hour{" "}
                <input
                  type="number"
                  min="60"
                  max="600"
                  className={`${inputClass} block w-28`}
                  value={allowance}
                  onChange={(e) => setAllowance(e.target.value)}
                />
              </label>
              <label className="text-sm">
                Hours{" "}
                <input
                  type="number"
                  min="1"
                  max="24"
                  className={`${inputClass} block w-20`}
                  value={hours}
                  onChange={(e) => setHours(e.target.value)}
                />
              </label>
              {(
                [
                  ["reset", "Reset this account"],
                  ["grant", "Grant temporary allowance"],
                  ["revoke", "Revoke allowance"],
                ] as const
              ).map(([action, label]) => (
                <button
                  key={action}
                  disabled={busy || reason.trim().length < 5}
                  className={`${inputClass} disabled:opacity-50`}
                  onClick={() => void change(action)}
                >
                  {label}
                </button>
              ))}
            </div>
            <p className="mt-2 text-xs text-slate-500">
              Reset changes only this account’s counter on the current backend.
              Granting an allowance does not reset its usage.
            </p>
          </>
        )}
        {limits && (
          <div className="mt-4 max-h-64 overflow-auto">
            <h3 className="mb-2 font-medium">Recent administrative changes</h3>
            {limits.audit.map((a, i) => (
              <p key={i} className="mb-2 text-xs">
                {timestamp(a.at)} · {a.action} · Account {a.userId} · Admin{" "}
                {a.actorId} · {a.reason}
                {a.limit
                  ? ` · ${a.limit}/hour until ${timestamp(a.expiresAt)}`
                  : ""}
              </p>
            ))}
            {!limits.audit.length && (
              <p className="text-sm">No administrative changes recorded.</p>
            )}
          </div>
        )}
      </details>
      <div className="mt-6 flex flex-wrap gap-4 text-sm">
        <a href="/admin/scanner" className="text-cyan-700 underline">
          Scanner operations
        </a>
        <a
          href="https://monitor.ourtextscores.com/dashboard"
          target="_blank"
          rel="noopener noreferrer"
          className="text-cyan-700 underline"
        >
          Uptime Kuma monitors
        </a>
      </div>
    </section>
  );
}
