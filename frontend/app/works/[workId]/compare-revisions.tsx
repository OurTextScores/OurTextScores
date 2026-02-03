"use client";

import React, { useMemo, useState } from "react";
import { getPublicApiBase } from "../../lib/api";
const PUBLIC_API_BASE = getPublicApiBase();

export default function CompareRevisions({
  workId,
  sourceId,
  revisions
}: {
  workId: string;
  sourceId: string;
  revisions: Array<{ revisionId: string; sequenceNumber: number; createdAt: string }>;
}) {
  const options = useMemo(
    () =>
      revisions
        .slice()
        .sort((a, b) => b.sequenceNumber - a.sequenceNumber)
        .map((r) => ({ value: r.revisionId, label: `#${r.sequenceNumber} • ${new Date(r.createdAt).toLocaleString()}` })),
    [revisions]
  );
  const [a, setA] = useState(options[1]?.value ?? options[0]?.value ?? "");
  const [b, setB] = useState(options[0]?.value ?? "");
  const [kind, setKind] = useState<'xml' | 'manifest'>("xml");

  const href = (() => {
    if (!a || !b) return undefined;
    const fileParam = kind === 'xml' ? 'canonical' : 'manifest';
    return `${PUBLIC_API_BASE}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(sourceId)}/textdiff?revA=${encodeURIComponent(a)}&revB=${encodeURIComponent(b)}&file=${encodeURIComponent(fileParam)}`;
  })();

  return (
    <div className="mt-3 flex flex-wrap items-end gap-2 text-xs text-slate-300">
      <span className="text-slate-400">Compare revisions (text diff):</span>
      <label className="flex items-center gap-1">
        <span className="text-slate-400">From</span>
        <select value={a} onChange={(e) => setA(e.target.value)} className="rounded border border-slate-700 bg-slate-900 px-2 py-1">
          {options.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-1">
        <span className="text-slate-400">To</span>
        <select value={b} onChange={(e) => setB(e.target.value)} className="rounded border border-slate-700 bg-slate-900 px-2 py-1">
          {options.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-1">
        <span className="text-slate-400">Type</span>
        <select value={kind} onChange={(e) => setKind(e.target.value as any)} className="rounded border border-slate-700 bg-slate-900 px-2 py-1">
          <option value="xml">XML (text)</option>
          <option value="manifest">Manifest (text)</option>
        </select>
      </label>
      <a
        href={href}
        target="_blank"
        className={`rounded px-3 py-1 font-semibold ring-1 ${href ? 'bg-slate-800 text-slate-200 ring-slate-700 hover:bg-slate-700' : 'bg-slate-800/40 text-slate-500 ring-slate-800 cursor-not-allowed'}`}
      >
        Open diff
      </a>
    </div>
  );
}
