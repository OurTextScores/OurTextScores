"use client";

import React, { useEffect, useState } from "react";
import { getPublicApiBase } from "../../lib/api";
const PUBLIC_API_BASE = getPublicApiBase();

type ViewerState = "idle" | "loading" | "ready" | "error";

export default function PdfViewer({
  workId,
  sourceId,
  revisionId
}: {
  workId: string;
  sourceId: string;
  revisionId?: string;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [state, setState] = useState<ViewerState>("idle");
  const [message, setMessage] = useState<string>("");

  useEffect(() => {
    let revoked: string | null = null;
    let aborted = false;
    const controller = new AbortController();
    async function run() {
      try {
        setState("loading");
        setMessage("");
        const q = revisionId ? `?r=${encodeURIComponent(revisionId)}` : "";
        const res = await fetch(
          `${PUBLIC_API_BASE}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(
            sourceId
          )}/score.pdf${q}`,
          { cache: "no-store", signal: controller.signal }
        );
        if (!res.ok) throw new Error(`Unable to fetch PDF (status ${res.status})`);
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        revoked = url;
        if (!aborted) {
          setUrl(url);
          setState("ready");
        }
      } catch (err) {
        if (aborted) return;
        setState("error");
        setMessage(err instanceof Error ? err.message : String(err));
      }
    }
    run();
    return () => {
      aborted = true;
      controller.abort();
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [workId, sourceId, revisionId]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3 text-xs text-slate-300">
        {state === "loading" && <span className="text-slate-400">Loading PDF…</span>}
        {state === "error" && <span className="text-rose-300">{message}</span>}
      </div>
      <div className="overflow-auto rounded border border-slate-300 bg-white">
        {url ? (
          <object data={url} type="application/pdf" className="h-[70vh] w-full" data-testid="pdf-object">
            <p className="p-4 text-sm text-slate-600">
              PDF preview is not supported in this browser.{' '}
              <a href={url} target="_blank" className="text-cyan-700 underline">Open PDF</a>
            </p>
          </object>
        ) : (
          <div className="p-4 text-sm text-slate-600">No PDF available.</div>
        )}
      </div>
    </div>
  );
}
