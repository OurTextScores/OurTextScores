"use client";

import { useRouter } from "next/navigation";
import { createBranchAction } from "./branch-actions";
import { useState } from "react";

export default function CreateBranchClient({ workId, sourceId, latestRevisionId }: { workId: string; sourceId: string; latestRevisionId?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <form
      action={async (formData: FormData) => {
        setBusy(true);
        try {
          const name = String(formData.get('name') || '').trim();
          const policy = String(formData.get('policy') || 'public') as any;
          if (name) await createBranchAction(workId, sourceId, name, policy, latestRevisionId);
        } finally {
          setBusy(false);
          router.refresh();
          // Notify other components in-page to refresh branch lists
          try { window.dispatchEvent(new CustomEvent('ots:branch-created')); } catch {}
        }
      }}
      className="flex flex-col gap-2 md:flex-row md:items-center md:gap-3"
    >
      <input name="name" type="text" placeholder="new-branch" className="rounded border border-slate-300 bg-white px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-950" />
      <select name="policy" defaultValue="public" className="rounded border border-slate-300 bg-white px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-950">
        <option value="public">Open</option>
        <option value="owner_approval">Owner approval required</option>
      </select>
      <button type="submit" className="rounded bg-cyan-600 px-3 py-1 text-sm font-semibold text-white hover:bg-cyan-700 disabled:opacity-50" disabled={busy}>
        {busy ? 'Creating…' : 'Create'}
      </button>
    </form>
  );
}

