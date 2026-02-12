"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getApiBase } from "../../lib/api";
import { getApiAuthHeaders } from "../../lib/authToken";
import { trackWatchToggleServer } from "../../lib/analytics";

export async function watchSourceAction(workId: string, sourceId: string) {
  const API_BASE = getApiBase();
  const headers = await getApiAuthHeaders();
  const res = await fetch(`${API_BASE}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(sourceId)}/watch`, {
    method: 'POST', headers
  });
  if (res.status === 401) {
    await trackWatchToggleServer({
      action: "watch",
      outcome: "unauthorized",
      workId,
      sourceId,
    });
    redirect('/api/auth/signin');
  }
  if (!res.ok) {
    const body = await res.text();
    await trackWatchToggleServer({
      action: "watch",
      outcome: "failure",
      workId,
      sourceId,
      error: body || `HTTP ${res.status}`,
    });
    throw new Error(body || 'Failed to watch source');
  }
  await trackWatchToggleServer({
    action: "watch",
    outcome: "success",
    workId,
    sourceId,
  });
  revalidatePath(`/works/${encodeURIComponent(workId)}`);
}

export async function unwatchSourceAction(workId: string, sourceId: string) {
  const API_BASE = getApiBase();
  const headers = await getApiAuthHeaders();
  const res = await fetch(`${API_BASE}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(sourceId)}/watch`, {
    method: 'DELETE', headers
  });
  if (res.status === 401) {
    await trackWatchToggleServer({
      action: "unwatch",
      outcome: "unauthorized",
      workId,
      sourceId,
    });
    redirect('/api/auth/signin');
  }
  if (!res.ok) {
    const body = await res.text();
    await trackWatchToggleServer({
      action: "unwatch",
      outcome: "failure",
      workId,
      sourceId,
      error: body || `HTTP ${res.status}`,
    });
    throw new Error(body || 'Failed to unwatch source');
  }
  await trackWatchToggleServer({
    action: "unwatch",
    outcome: "success",
    workId,
    sourceId,
  });
  revalidatePath(`/works/${encodeURIComponent(workId)}`);
}
