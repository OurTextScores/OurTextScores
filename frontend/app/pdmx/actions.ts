"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getApiBase } from "../lib/api";
import { getApiAuthHeaders } from "../lib/authToken";

async function parseError(res: Response, fallback: string): Promise<string> {
  const text = await res.text();
  try {
    const json = JSON.parse(text);
    return json.message || json.error || fallback;
  } catch {
    return text || fallback;
  }
}

export async function updatePdmxReviewAction(
  pdmxId: string,
  payload: {
    qualityStatus?: "unknown" | "acceptable" | "unacceptable";
    excludedFromSearch?: boolean;
    reason?: string;
    notes?: string;
  }
) {
  const API_BASE = getApiBase();
  const headers = await getApiAuthHeaders();
  const res = await fetch(`${API_BASE}/pdmx/records/${encodeURIComponent(pdmxId)}/review`, {
    method: "PATCH",
    headers: {
      ...headers,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  if (res.status === 401) {
    redirect("/api/auth/signin");
  }
  if (!res.ok) {
    throw new Error(await parseError(res, "Failed to update PDMX review"));
  }
  const updated = await res.json();
  revalidatePath("/pdmx");
  return updated;
}

export async function updatePdmxImportAction(
  pdmxId: string,
  payload: {
    status?: "not_imported" | "imported" | "failed";
    importedWorkId?: string;
    importedSourceId?: string;
    importedRevisionId?: string;
    importedProjectId?: string;
    imslpUrl?: string;
    error?: string;
  }
) {
  const API_BASE = getApiBase();
  const headers = await getApiAuthHeaders();
  const res = await fetch(`${API_BASE}/pdmx/records/${encodeURIComponent(pdmxId)}/import`, {
    method: "PATCH",
    headers: {
      ...headers,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  if (res.status === 401) {
    redirect("/api/auth/signin");
  }
  if (!res.ok) {
    throw new Error(await parseError(res, "Failed to update PDMX import status"));
  }
  const updated = await res.json();
  revalidatePath("/pdmx");
  return updated;
}

export async function associatePdmxSourceAction(
  pdmxId: string,
  payload: {
    imslpUrl: string;
    projectId: string;
    sourceLabel?: string;
    sourceType?: "score" | "parts" | "audio" | "metadata" | "other";
  }
) {
  const API_BASE = getApiBase();
  const headers = await getApiAuthHeaders();
  const res = await fetch(`${API_BASE}/pdmx/records/${encodeURIComponent(pdmxId)}/associate-source`, {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  if (res.status === 401) {
    redirect("/api/auth/signin");
  }
  if (!res.ok) {
    throw new Error(await parseError(res, "Failed to associate PDMX record"));
  }
  const result = await res.json();
  revalidatePath("/pdmx");
  if (result?.workId) {
    revalidatePath(`/works/${encodeURIComponent(result.workId)}`);
  }
  if (payload?.projectId) {
    revalidatePath(`/projects/${encodeURIComponent(payload.projectId)}`);
  }
  return result as {
    ok: boolean;
    alreadyImported?: boolean;
    workId?: string;
    sourceId?: string;
    revisionId?: string;
    projectId?: string;
  };
}
