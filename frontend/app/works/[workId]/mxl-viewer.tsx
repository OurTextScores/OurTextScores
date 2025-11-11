"use client";

import React, { useEffect, useRef, useState } from "react";
import { getPublicApiBase } from "../../lib/api";
const PUBLIC_API_BASE = getPublicApiBase();

type ViewerState = "idle" | "loading" | "ready" | "error";

export default function MxlViewer({
  workId,
  sourceId,
  revisionId
}: {
  workId: string;
  sourceId: string;
  revisionId?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const osmdRef = useRef<any>(null);
  const [state, setState] = useState<ViewerState>("idle");
  const [message, setMessage] = useState<string>("");
  const [zoom, setZoom] = useState<number>(100);

  useEffect(() => {
    let aborted = false;
    const controller = new AbortController();
    const run = async () => {
      try {
        setState("loading");
        setMessage("");

        const q = revisionId ? `?r=${encodeURIComponent(revisionId)}` : "";
        const [{ OpenSheetMusicDisplay }, resXml] = await Promise.all([
          import("opensheetmusicdisplay"),
          fetch(
            `${PUBLIC_API_BASE}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(
              sourceId
            )}/canonical.xml${q}`,
            { cache: "no-store", signal: controller.signal }
          )
        ]);

        const osmd = new OpenSheetMusicDisplay(containerRef.current!, {
          backend: "svg",
          autoResize: true,
          drawTitle: false,
          pageFormat: 'Endless' as any
        });
        osmdRef.current = osmd;

        if (resXml.ok) {
          const xmlText = await resXml.text();
          try {
            await osmd.load(xmlText as any);
          } catch {
            // fallback to normalized MXL
            const resMxl2 = await fetch(
              `${PUBLIC_API_BASE}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(
                sourceId
              )}/normalized.mxl${q}`,
              { cache: "no-store", signal: controller.signal }
            );
            if (!resMxl2.ok) throw new Error("Unable to load canonical or MXL");
            const buffer2 = new Uint8Array(await resMxl2.arrayBuffer());
            await osmd.load(buffer2 as any);
          }
        } else {
          const resMxl = await fetch(
            `${PUBLIC_API_BASE}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(
              sourceId
            )}/normalized.mxl${q}`,
            { cache: "no-store", signal: controller.signal }
          );
          if (!resMxl.ok) {
            throw new Error(`Unable to fetch score (status ${resXml.status}/${resMxl.status})`);
          }
          const buffer = new Uint8Array(await resMxl.arrayBuffer());
          await osmd.load(buffer as any);
        }

        osmd.Zoom = zoom / 100;
        await osmd.render();
        if (!aborted) setState("ready");
      } catch (err) {
        if (aborted) return;
        setState("error");
        setMessage(err instanceof Error ? err.message : String(err));
      }
    };
    run();
    return () => {
      aborted = true;
      controller.abort();
      const el = containerRef.current; // copy ref into local for cleanup
      if (el) el.innerHTML = "";
      osmdRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workId, sourceId, revisionId]);

  const handleZoom = async (next: number) => {
    setZoom(next);
    const osmd = osmdRef.current;
    if (osmd) {
      osmd.Zoom = next / 100;
      try {
        await osmd.render();
      } catch {
        // ignore
      }
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3 text-xs text-slate-300">
        <div className="flex items-center gap-2">
          <label htmlFor="zoom">Zoom</label>
          <input
            id="zoom"
            type="range"
            min={10}
            max={200}
            step={5}
            value={zoom}
            onChange={(e) => handleZoom(Number(e.target.value))}
          />
          <span className="tabular-nums">{zoom}%</span>
        </div>
        {state === "loading" && <span className="text-slate-400">Loading score…</span>}
        {state === "error" && <span className="text-rose-300">{message}</span>}
      </div>
      <div
        ref={containerRef}
        className="overflow-auto rounded border border-slate-300 bg-white p-3"
        style={{ minHeight: 120 }}
      />
    </div>
  );
}
