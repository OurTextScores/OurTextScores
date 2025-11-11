import { getApiBase } from "../../lib/api";
import { getApiAuthHeaders } from "../../lib/authToken";
import { watchSourceAction, unwatchSourceAction } from "./watch-actions";

export default async function WatchControls({ workId, sourceId }: { workId: string; sourceId: string }) {
  const API_BASE = getApiBase();
  const headers = await getApiAuthHeaders();
  const authed = !!(headers && (headers as any).Authorization);
  const res = await fetch(`${API_BASE}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(sourceId)}/watchers/count`, { headers, cache: 'no-store' });
  let count = 0;
  let subscribed = false;
  if (res.ok) {
    const j = await res.json();
    count = j?.count || 0;
    subscribed = !!j?.subscribed;
  }
  if (!authed) {
    return (
      <a
        href="/api/auth/signin"
        className="rounded px-3 py-1 text-xs font-semibold ring-1 bg-slate-100 text-slate-700 ring-slate-300 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:ring-slate-700"
        title="Sign in to watch this source"
      >
        Sign in to watch ({count})
      </a>
    );
  }

  return (
    <form action={subscribed ? async () => { 'use server'; await unwatchSourceAction(workId, sourceId); } : async () => { 'use server'; await watchSourceAction(workId, sourceId); }}>
      <button type="submit" className={`rounded px-3 py-1 text-xs font-semibold ring-1 ${subscribed ? 'bg-slate-200 text-slate-700 ring-slate-300 dark:bg-slate-800 dark:text-slate-200 dark:ring-slate-700' : 'bg-cyan-600 text-white ring-cyan-700 hover:bg-cyan-700'}`}>
        {subscribed ? `Watching (${count})` : `Watch (${count})`}
      </button>
    </form>
  );
}
