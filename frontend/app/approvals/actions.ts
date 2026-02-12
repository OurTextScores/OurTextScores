"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getApiBase } from "../lib/api";
import { getApiAuthHeaders } from "../lib/authToken";
import { trackApprovalOutcomeServer } from "../lib/analytics";

export async function approveRevisionAction(workId: string, sourceId: string, revisionId: string) {
  const API_BASE = getApiBase();
  const headers = await getApiAuthHeaders();
  const res = await fetch(`${API_BASE}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(sourceId)}/revisions/${encodeURIComponent(revisionId)}/approve`, {
    method: 'POST',
    headers
  });
  if (res.status === 401) {
    await trackApprovalOutcomeServer({
      decision: "approve",
      outcome: "unauthorized",
      workId,
      sourceId,
      revisionId,
    });
    redirect('/api/auth/signin');
  }
  if (!res.ok) {
    const text = await res.text();
    await trackApprovalOutcomeServer({
      decision: "approve",
      outcome: "failure",
      workId,
      sourceId,
      revisionId,
      error: text || `HTTP ${res.status}`,
    });
    throw new Error(text || 'Failed to approve revision');
  }
  await trackApprovalOutcomeServer({
    decision: "approve",
    outcome: "success",
    workId,
    sourceId,
    revisionId,
  });
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
    await trackApprovalOutcomeServer({
      decision: "reject",
      outcome: "unauthorized",
      workId,
      sourceId,
      revisionId,
    });
    redirect('/api/auth/signin');
  }
  if (!res.ok) {
    const text = await res.text();
    await trackApprovalOutcomeServer({
      decision: "reject",
      outcome: "failure",
      workId,
      sourceId,
      revisionId,
      error: text || `HTTP ${res.status}`,
    });
    throw new Error(text || 'Failed to reject revision');
  }
  await trackApprovalOutcomeServer({
    decision: "reject",
    outcome: "success",
    workId,
    sourceId,
    revisionId,
  });
  revalidatePath('/approvals');
}
