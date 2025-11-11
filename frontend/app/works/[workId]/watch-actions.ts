"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getApiBase } from "../../lib/api";
import { getApiAuthHeaders } from "../../lib/authToken";

export async function watchSourceAction(workId: string, sourceId: string) {
  const API_BASE = getApiBase();
  const headers = await getApiAuthHeaders();
  const res = await fetch(`${API_BASE}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(sourceId)}/watch`, {
    method: 'POST', headers
  });
  if (res.status === 401) {
    redirect('/api/auth/signin');
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(body || 'Failed to watch source');
  }
  revalidatePath(`/works/${encodeURIComponent(workId)}`);
}

export async function unwatchSourceAction(workId: string, sourceId: string) {
  const API_BASE = getApiBase();
  const headers = await getApiAuthHeaders();
  const res = await fetch(`${API_BASE}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(sourceId)}/watch`, {
    method: 'DELETE', headers
  });
  if (res.status === 401) {
    redirect('/api/auth/signin');
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(body || 'Failed to unwatch source');
  }
  revalidatePath(`/works/${encodeURIComponent(workId)}`);
}
