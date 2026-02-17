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

export async function associatePdmxSourceAction(formData: FormData) {
  const pdmxId = String(formData.get("pdmxId") || "").trim();
  const imslpUrl = String(formData.get("imslpUrl") || "").trim();
  const projectId = String(formData.get("projectId") || "").trim();
  const sourceLabel = String(formData.get("sourceLabel") || "").trim();
  const sourceType = String(formData.get("sourceType") || "").trim();
  const license = String(formData.get("license") || "").trim();
  const adminVerified = String(formData.get("adminVerified") || "").trim() === "true";
  const referencePdf = formData.get("referencePdf");

  if (!pdmxId) {
    throw new Error("pdmxId is required");
  }
  if (!imslpUrl || !projectId) {
    throw new Error("IMSLP URL and projectId are required");
  }

  const API_BASE = getApiBase();
  const headers = await getApiAuthHeaders();
  const upstreamBody = new FormData();
  upstreamBody.set("imslpUrl", imslpUrl);
  upstreamBody.set("projectId", projectId);
  if (sourceLabel) upstreamBody.set("sourceLabel", sourceLabel);
  if (sourceType) upstreamBody.set("sourceType", sourceType);
  if (license) upstreamBody.set("license", license);
  if (adminVerified) upstreamBody.set("adminVerified", "true");
  if (referencePdf instanceof Blob && referencePdf.size > 0) {
    const filename = typeof File !== "undefined" && referencePdf instanceof File
      ? referencePdf.name
      : "reference.pdf";
    upstreamBody.set("referencePdf", referencePdf, filename);
  }

  const res = await fetch(`${API_BASE}/pdmx/records/${encodeURIComponent(pdmxId)}/associate-source`, {
    method: "POST",
    headers: {
      ...headers
    },
    body: upstreamBody
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
  revalidatePath(`/projects/${encodeURIComponent(projectId)}`);
  return result as {
    ok: boolean;
    alreadyImported?: boolean;
    workId?: string;
    sourceId?: string;
    revisionId?: string;
    projectId?: string;
  };
}
