"use client";

import React from "react";

export default function CopyDownload({ text, filename, className }: { text: string; filename: string; className?: string }) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {}
  };
  const download = () => {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className={className ?? "flex gap-2"}>
      <button type="button" onClick={copy} className="rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800">
        Copy
      </button>
      <button type="button" onClick={download} className="rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800">
        Download
      </button>
    </div>
  );
}

