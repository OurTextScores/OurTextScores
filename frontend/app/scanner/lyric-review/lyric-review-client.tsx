"use client";

import { useEffect, useMemo, useState } from "react";
import {
  applyChange,
  blankDecision,
  buildExport,
  isReady,
  printedLines,
  type Decision,
  type InventoryRow,
} from "./lyric-review-model";

const STORAGE_PREFIX = "ots-lyric-review-";

async function inventoryKey(inventory: InventoryRow[]) {
  const bytes = new TextEncoder().encode(JSON.stringify(inventory));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return (
    STORAGE_PREFIX +
    Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  );
}

function readStored(key: string): Record<string, Decision> {
  try {
    return JSON.parse(window.localStorage.getItem(key) ?? "{}");
  } catch {
    return {};
  }
}

export default function LyricReviewClient({ baseUrl }: { baseUrl: string }) {
  const [inventory, setInventory] = useState<InventoryRow[] | null>(null);
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [key, setKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${baseUrl}/inventory.json`);
        if (!res.ok) throw new Error(`Inventory unavailable (${res.status})`);
        const rows = (await res.json()) as InventoryRow[];
        const k = await inventoryKey(rows);
        if (cancelled) return;
        setInventory(rows);
        setKey(k);
        setDecisions(readStored(k));
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [baseUrl]);

  const confirmed = useMemo(
    () =>
      inventory?.filter((r) => decisions[r.id] && isReady(r, decisions[r.id]))
        .length ?? 0,
    [inventory, decisions],
  );

  if (error) return <p role="alert">{error}</p>;
  if (!inventory) return <p>Loading proposals…</p>;

  const update = (row: InventoryRow, change: Parameters<typeof applyChange>[2]) =>
    setDecisions((prev) => {
      const next = {
        ...prev,
        [row.id]: applyChange(row, prev[row.id] ?? blankDecision(row), change),
      };
      try {
        if (key) window.localStorage.setItem(key, JSON.stringify(next));
      } catch {
        /* storage is a convenience only */
      }
      return next;
    });

  const download = () => {
    const blob = new Blob(
      [JSON.stringify(buildExport(inventory, decisions), null, 2)],
      { type: "application/json" },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "lyric-placement-decisions.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div>
      <p className="text-sm text-slate-600 dark:text-slate-400">
        Blue circles mark proposed noteheads; orange circles mark syllable
        positions. Lyric lines are numbered from top to bottom within a system.
        Exports create a review plan and never change a score.
      </p>
      <div className="my-4 flex items-center gap-4">
        <button
          type="button"
          onClick={download}
          className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white"
        >
          Export decisions
        </button>
        <span data-testid="confirmed-count">
          {confirmed} fully confirmed; no score changes
        </span>
      </div>
      {inventory.map((row) => {
        const d = decisions[row.id] ?? blankDecision(row);
        const n = row.generatedNote;
        return (
          <article
            key={row.id}
            className="border-t border-slate-300 py-4 dark:border-slate-700"
          >
            <h2 className="font-semibold">
              {row.score} — {row.text}
            </h2>
            <p className="text-sm">
              Generated measure {n.physical_measure}, +{n.onset_quarters} quarter
              notes, {n.pitch}
            </p>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`${baseUrl}/${row.image}`}
              alt="Blue proposed notehead; orange syllable"
              className="max-h-[420px] max-w-full"
            />
            <div className="mt-2 flex flex-wrap items-center gap-4 text-sm">
              <label>
                Text{" "}
                <input
                  type="text"
                  value={d.text}
                  onChange={(e) => update(row, { text: e.target.value })}
                  className="w-40 rounded border px-1"
                />
              </label>
              <label>
                Printed lyric line{" "}
                <select
                  value={d.printedLine === null ? "" : String(d.printedLine)}
                  onChange={(e) =>
                    update(row, {
                      printedLine:
                        e.target.value === "" ? null : Number(e.target.value),
                    })
                  }
                >
                  <option value="">Choose a line</option>
                  {printedLines(inventory, row.score).map((line) => (
                    <option key={line} value={line}>
                      {line === 1
                        ? "Line 1 (top)"
                        : `Line ${line} (below line ${line - 1})`}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={d.textConfirmed}
                  onChange={(e) =>
                    update(row, { textConfirmed: e.target.checked })
                  }
                />{" "}
                Text correct
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={d.verseConfirmed}
                  onChange={(e) =>
                    update(row, { verseConfirmed: e.target.checked })
                  }
                />{" "}
                Selected line correct
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={d.noteConfirmed}
                  disabled={d.text !== row.text}
                  onChange={(e) =>
                    update(row, { noteConfirmed: e.target.checked })
                  }
                />{" "}
                Blue note correct
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={d.excluded}
                  onChange={(e) => update(row, { excluded: e.target.checked })}
                />{" "}
                Exclude
              </label>
              <button
                type="button"
                onClick={() =>
                  setDecisions((prev) => {
                    const next = { ...prev, [row.id]: blankDecision(row) };
                    try {
                      if (key)
                        window.localStorage.setItem(key, JSON.stringify(next));
                    } catch {
                      /* ignore */
                    }
                    return next;
                  })
                }
              >
                Reset
              </button>
            </div>
          </article>
        );
      })}
    </div>
  );
}
