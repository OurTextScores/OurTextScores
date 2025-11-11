"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
// no API base import; uploads go through /api/proxy which attaches auth

const LICENSE_OPTIONS = [
  { value: '', label: '(No license specified)' },
  { value: 'CC0', label: 'CC0 - Public Domain Dedication' },
  { value: 'CC-BY-4.0', label: 'CC-BY 4.0 - Attribution' },
  { value: 'CC-BY-SA-4.0', label: 'CC-BY-SA 4.0 - Attribution-ShareAlike' },
  { value: 'CC-BY-NC-4.0', label: 'CC-BY-NC 4.0 - Attribution-NonCommercial' },
  { value: 'CC-BY-NC-SA-4.0', label: 'CC-BY-NC-SA 4.0 - Attribution-NonCommercial-ShareAlike' },
  { value: 'CC-BY-ND-4.0', label: 'CC-BY-ND 4.0 - Attribution-NoDerivatives' },
  { value: 'Public Domain', label: 'Public Domain' },
  { value: 'All Rights Reserved', label: 'All Rights Reserved (Copyright)' },
  { value: 'Other', label: 'Other (specify URL)' }
];

export default function UploadNewSourceForm({ workId }: { workId: string }) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [label, setLabel] = useState("");
  const [commitMessage, setCommitMessage] = useState("");
  const [description, setDescription] = useState("");
  const [license, setLicense] = useState("");
  const [licenseUrl, setLicenseUrl] = useState("");
  const [licenseAttribution, setLicenseAttribution] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) {
      setMsg("Choose a file first.");
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const form = new FormData();
      form.append("file", file);
      if (label.trim()) form.append("label", label.trim());
      if (commitMessage.trim()) form.append("commitMessage", commitMessage.trim());
      if (description.trim()) form.append("description", description.trim());
      if (license) form.append("license", license);
      if (licenseUrl.trim()) form.append("licenseUrl", licenseUrl.trim());
      if (licenseAttribution.trim()) form.append("licenseAttribution", licenseAttribution.trim());
      const res = await fetch(`/api/proxy/works/${encodeURIComponent(workId)}/sources`, {
        method: "POST",
        body: form
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `Upload failed (${res.status})`);
      }
      setMsg("Source uploaded.");
      setFile(null);
      setLabel("");
      setCommitMessage("");
      setDescription("");
      setLicense("");
      setLicenseUrl("");
      setLicenseAttribution("");
      router.refresh();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="file"
          accept=".mscz,.mxl,.xml"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="text-slate-700 file:mr-2 file:cursor-pointer file:rounded file:border-0 file:bg-cyan-600 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-white hover:file:bg-cyan-700 dark:text-slate-300"
        />
        <input
          type="text"
          placeholder="source title (optional)"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          className="rounded border border-slate-300 bg-white px-2 py-1 text-slate-900 placeholder-slate-500 focus:border-cyan-400 focus:outline-none focus:ring-1 focus:ring-cyan-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 dark:placeholder-slate-500"
        />
        <input
          type="text"
          placeholder="description (optional)"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="rounded border border-slate-300 bg-white px-2 py-1 text-slate-900 placeholder-slate-500 focus:border-cyan-400 focus:outline-none focus:ring-1 focus:ring-cyan-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 dark:placeholder-slate-500"
        />
        <input
          type="text"
          placeholder="commit message (optional)"
          value={commitMessage}
          onChange={(e) => setCommitMessage(e.target.value)}
          className="rounded border border-slate-300 bg-white px-2 py-1 text-slate-900 placeholder-slate-500 focus:border-cyan-400 focus:outline-none focus:ring-1 focus:ring-cyan-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 dark:placeholder-slate-500"
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={license}
          onChange={(e) => setLicense(e.target.value)}
          className="rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-900 focus:border-cyan-400 focus:outline-none focus:ring-1 focus:ring-cyan-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
        >
          {LICENSE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        {license === 'Other' && (
          <input
            type="url"
            placeholder="License URL (required for Other)"
            value={licenseUrl}
            onChange={(e) => setLicenseUrl(e.target.value)}
            className="flex-1 rounded border border-slate-300 bg-white px-2 py-1 text-slate-900 placeholder-slate-500 focus:border-cyan-400 focus:outline-none focus:ring-1 focus:ring-cyan-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 dark:placeholder-slate-500"
          />
        )}
        {(license.startsWith('CC-BY') || license === 'Public Domain') && license !== '' && (
          <input
            type="text"
            placeholder="Attribution (e.g., Your Name)"
            value={licenseAttribution}
            onChange={(e) => setLicenseAttribution(e.target.value)}
            className="flex-1 rounded border border-slate-300 bg-white px-2 py-1 text-slate-900 placeholder-slate-500 focus:border-cyan-400 focus:outline-none focus:ring-1 focus:ring-cyan-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 dark:placeholder-slate-500"
          />
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="submit"
          disabled={busy || !file}
          className="rounded bg-cyan-600 px-4 py-2 text-sm font-semibold text-white hover:bg-cyan-700 disabled:opacity-50"
        >
          {busy ? "Uploading…" : "Upload new source"}
        </button>
      </div>
      {msg && <div className="text-slate-400">{msg}</div>}
    </form>
  );
}
