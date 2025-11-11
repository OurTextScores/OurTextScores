"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getApiBase } from "../lib/api";
import { getApiAuthHeaders } from "../lib/authToken";

export async function approveRevisionAction(workId: string, sourceId: string, revisionId: string) {
  const API_BASE = getApiBase();
  const headers = await getApiAuthHeaders();
  const res = await fetch(`${API_BASE}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(sourceId)}/revisions/${encodeURIComponent(revisionId)}/approve`, {
    method: 'POST',
    headers
  });
  if (res.status === 401) {
    redirect('/api/auth/signin');
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || 'Failed to approve revision');
  }
  revalidatePath('/approvals');
}

export async function rejectRevisionAction(workId: string, sourceId: string, revisionId: string) {
  const API_BASE = getApiBase();
  const headers = await getApiAuthHeaders();
  const res = await fetch(`${API_BASE}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(sourceId)}/revisions/${encodeURIComponent(revisionId)}/reject`, {
    method: 'POST',
    headers
  });
  if (res.status === 401) {
    redirect('/api/auth/signin');
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || 'Failed to reject revision');
  }
  revalidatePath('/approvals');
}
