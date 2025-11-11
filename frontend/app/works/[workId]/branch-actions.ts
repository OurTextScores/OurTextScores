"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getApiBase } from "../../lib/api";
import { getApiAuthHeaders } from "../../lib/authToken";

export async function createBranchAction(workId: string, sourceId: string, name: string, policy: 'public' | 'owner_approval', baseRevisionId?: string) {
  const API_BASE = getApiBase();
  const headers = await getApiAuthHeaders();
  const res = await fetch(`${API_BASE}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(sourceId)}/branches`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ name, policy, baseRevisionId })
  });
  if (res.status === 401) {
    redirect('/api/auth/signin');
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || 'Failed to create branch');
  }
  revalidatePath(`/works/${encodeURIComponent(workId)}`);
}
