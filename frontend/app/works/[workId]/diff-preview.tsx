"use client";

import React, { useEffect, useMemo, useState } from "react";
import CopyDownload from "../../components/copy-download";
import { html as diff2html } from "diff2html";
import "diff2html/bundles/css/diff2html.min.css";
import { getPublicApiBase } from "../../lib/api";
const PUBLIC_API_BASE = getPublicApiBase();

type DiffKind = "musicdiff" | "musicdiff_visual" | "lmx" | "xml" | "manifest";
type ViewMode = "side-by-side" | "line-by-line";

export default function DiffPreview({
  workId,
  sourceId,
  revisions
}: {
  workId: string;
  sourceId: string;
  revisions: Array<{ revisionId: string; sequenceNumber: number; createdAt: string; fossilBranch?: string }>;
}) {
  const allBranches = useMemo(() => {
    const set = new Set<string>();
    set.add('All');
    for (const r of revisions) set.add((r.fossilBranch || 'trunk').trim());
    return Array.from(set);
  }, [revisions]);

  const latestBranch = useMemo(() => (revisions[0]?.fossilBranch || 'trunk'), [revisions]);
  const [branch, setBranch] = useState<string>(latestBranch);

  const filtered = useMemo(
    () => (branch === 'All' ? revisions : revisions.filter(r => (r.fossilBranch || 'trunk') === branch)).slice().sort((a,b)=>b.sequenceNumber-a.sequenceNumber),
    [revisions, branch]
  );
  const options = useMemo(() => filtered.map(r => ({ value: r.revisionId, label: `#${r.sequenceNumber} • ${new Date(r.createdAt).toLocaleString()}` })), [filtered]);

  const [revA, setRevA] = useState(options[1]?.value ?? options[0]?.value ?? "");
  const [revB, setRevB] = useState(options[0]?.value ?? "");
  const [kind, setKind] = useState<DiffKind>("lmx");
  const [view, setView] = useState<ViewMode>("side-by-side");
  const [state, setState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [error, setError] = useState<string>("");
  const [html, setHtml] = useState<string>("");
  const [rawText, setRawText] = useState<string>("");
  const [isDark, setIsDark] = useState<boolean>(false);

  // Find sequence numbers for labels
  const revASeq = revisions.find(r => r.revisionId === revA)?.sequenceNumber;
  const revBSeq = revisions.find(r => r.revisionId === revB)?.sequenceNumber;

  const pdfUrl = revA && revB
    ? `${PUBLIC_API_BASE}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(sourceId)}/musicdiff?revA=${encodeURIComponent(revA)}&revB=${encodeURIComponent(revB)}&format=pdf`
    : undefined;

  const canVisualize = kind !== "musicdiff";

  // Track theme to toggle diff2html theme class
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    const update = () => setIsDark(root.classList.contains('dark'));
    update();
    const observer = new MutationObserver(update);
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let aborted = false;
    async function load() {
      if (!revA || !revB) return;
      setState("loading");
      setError("");
      setHtml("");
      setRawText("");
      try {
        if (kind === "musicdiff_visual") {
          // Ensure we have an absolute API base URL
          const absoluteApiBase = PUBLIC_API_BASE.startsWith('http')
            ? PUBLIC_API_BASE
            : `${window.location.protocol}//${window.location.hostname}:4000${PUBLIC_API_BASE}`;

          // Construct URLs for canonical XML files
          const leftXmlUrl = `${absoluteApiBase}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(sourceId)}/canonical.xml?r=${encodeURIComponent(revA)}`;
          const rightXmlUrl = `${absoluteApiBase}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(sourceId)}/canonical.xml?r=${encodeURIComponent(revB)}`;

          // Construct labels
          const leftLabel = `Rev #${revASeq || '?'}`;
          const rightLabel = `Rev #${revBSeq || '?'}`;

          // Construct the embed URL
          const embedUrl = `/score-editor/index.html?compareLeft=${encodeURIComponent(leftXmlUrl)}&compareRight=${encodeURIComponent(rightXmlUrl)}&leftLabel=${encodeURIComponent(leftLabel)}&rightLabel=${encodeURIComponent(rightLabel)}`;

          // Create iframe HTML
          const wrapper = `<iframe src="${embedUrl}" style="width:100%;height:800px;border:1px solid #e2e8f0;border-radius:0.5rem;" title="Score Editor Visual Diff"></iframe>`;
          setHtml(wrapper);
          setRawText(`Visual diff (Score Editor): ${embedUrl}\n`);
          setState("ready");
          return;
        }

        const url =
          kind === "musicdiff"
            ? `${PUBLIC_API_BASE}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(sourceId)}/musicdiff?revA=${encodeURIComponent(revA)}&revB=${encodeURIComponent(revB)}`
            : `${PUBLIC_API_BASE}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(sourceId)}/textdiff?revA=${encodeURIComponent(revA)}&revB=${encodeURIComponent(revB)}&file=${encodeURIComponent(
                kind === "lmx" ? "linearized" : kind === "xml" ? "canonical" : "manifest"
              )}`;
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) throw new Error(`Diff fetch failed (${res.status})`);
        const text = await res.text();
        if (aborted) return;
        if (canVisualize) {
          const content = diff2html(text, {
            drawFileList: false,
            outputFormat: view,
          } as any);
          setHtml(content);
        }
        setRawText(text || "(no differences)\n");
        setState("ready");
      } catch (err) {
        if (aborted) return;
        setState("error");
        setError(err instanceof Error ? err.message : String(err));
      }
    }
    load();
    return () => {
      aborted = true;
    };
  }, [revA, revB, kind, view, workId, sourceId, canVisualize, pdfUrl, revASeq, revBSeq]);

  return (
    <div className="mt-3 flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-2 text-xs text-slate-700 dark:text-slate-300">
        <label className="flex items-center gap-1">
          <span className="text-slate-400">Branch</span>
          <select value={branch} onChange={(e) => {
            const next = e.target.value; setBranch(next);
            const list = (next === 'All' ? revisions : revisions.filter(r => (r.fossilBranch || 'trunk') === next)).slice().sort((a,b)=>b.sequenceNumber-a.sequenceNumber);
            const a = list[1]?.revisionId ?? list[0]?.revisionId ?? '';
            const b = list[0]?.revisionId ?? '';
            setRevA(a); setRevB(b);
          }} className="rounded border border-slate-300 bg-white px-2 py-1 text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100">
            {allBranches.map(b => (<option key={b} value={b}>{b}</option>))}
          </select>
        </label>
        <span className="text-slate-400">Compare revisions:</span>
        <label className="flex items-center gap-1">
          <span className="text-slate-400">From</span>
          <select value={revA} onChange={(e) => setRevA(e.target.value)} className="rounded border border-slate-300 bg-white px-2 py-1 text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100">
            {options.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1">
          <span className="text-slate-400">To</span>
          <select value={revB} onChange={(e) => setRevB(e.target.value)} className="rounded border border-slate-300 bg-white px-2 py-1 text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100">
            {options.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1">
          <span className="text-slate-400">Type</span>
          <select value={kind} onChange={(e) => setKind(e.target.value as DiffKind)} className="rounded border border-slate-300 bg-white px-2 py-1 text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100">
            <option value="lmx">LMX (text)</option>
            <option value="xml">XML (text)</option>
            <option value="manifest">Manifest (text)</option>
            <option value="musicdiff">Musicdiff (semantic text)</option>
            <option value="musicdiff_visual">Visual Diff (Score Editor)</option>
          </select>
        </label>
        <label className={`ml-auto flex items-center gap-1 ${canVisualize ? '' : 'opacity-50'}`} title={canVisualize ? 'Visual view' : 'Visual view not available for musicdiff'}>
          <span className="text-slate-400">View</span>
          <select
            value={view}
            onChange={(e) => setView(e.target.value as ViewMode)}
            className="rounded border border-slate-300 bg-white px-2 py-1 text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
            disabled={!canVisualize}
          >
            <option value="side-by-side">Side-by-side</option>
            <option value="line-by-line">Inline</option>
          </select>
        </label>
        {kind === 'musicdiff_visual' && revA && revB && (
          <button
            onClick={() => {
              const absoluteApiBase = PUBLIC_API_BASE.startsWith('http')
                ? PUBLIC_API_BASE
                : `${window.location.protocol}//${window.location.hostname}:4000${PUBLIC_API_BASE}`;
              const leftXmlUrl = `${absoluteApiBase}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(sourceId)}/canonical.xml?r=${encodeURIComponent(revA)}`;
              const rightXmlUrl = `${absoluteApiBase}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(sourceId)}/canonical.xml?r=${encodeURIComponent(revB)}`;
              const editorUrl = `/score-editor/index.html?compareLeft=${encodeURIComponent(leftXmlUrl)}&compareRight=${encodeURIComponent(rightXmlUrl)}&leftLabel=${encodeURIComponent(`Rev #${revASeq || '?'}`)}&rightLabel=${encodeURIComponent(`Rev #${revBSeq || '?'}`)}`;
              window.open(editorUrl, '_blank');
            }}
            className="ml-auto rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700 transition hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
            title="Open in Score Editor in a new tab"
          >
            Open in Score Editor
          </button>
        )}
        {state === "loading" && <span className="text-slate-400">Loading diff…</span>}
        {state === "error" && <span className="text-rose-300">{error}</span>}
      </div>
      <div className="overflow-auto rounded border border-slate-200 bg-white p-2 dark:border-slate-800 dark:bg-slate-950">
        {state === "ready" && (
          <div className="mb-2 flex items-center justify-end">
            <CopyDownload text={rawText} filename={`diff-${kind}-${revA}-${revB}.txt`} />
          </div>
        )}
        {state === "ready" && kind === 'musicdiff_visual' && (
          <div className="rounded border border-slate-200 p-2 dark:border-slate-800" dangerouslySetInnerHTML={{ __html: html }} />
        )}
        {state === "ready" && canVisualize && kind !== 'musicdiff_visual' && (
          <div className={isDark ? "diff2html--theme-dark" : undefined} dangerouslySetInnerHTML={{ __html: html }} />
        )}
        {state === "ready" && !canVisualize && (
          <pre className="whitespace-pre-wrap p-3 text-xs text-slate-800 dark:text-slate-200">
            {rawText}
          </pre>
        )}
        {state !== "ready" && state !== "error" && (
          <div className="p-3 text-xs text-slate-400">Select revisions to view a diff.</div>
        )}
      </div>
    </div>
  );
}
