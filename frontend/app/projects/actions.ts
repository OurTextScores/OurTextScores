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

export async function createProjectAction(payload: {
  title: string;
  description?: string;
  visibility?: "public" | "private";
}) {
  const API_BASE = getApiBase();
  const headers = await getApiAuthHeaders();
  const res = await fetch(`${API_BASE}/projects`, {
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
    throw new Error(await parseError(res, "Failed to create project"));
  }

  const project = await res.json();
  revalidatePath("/projects");
  return project as { projectId: string };
}

export async function updateProjectAction(
  projectId: string,
  payload: {
    title?: string;
    description?: string;
    status?: "active" | "archived";
    visibility?: "public" | "private";
  }
) {
  const API_BASE = getApiBase();
  const headers = await getApiAuthHeaders();
  const res = await fetch(`${API_BASE}/projects/${encodeURIComponent(projectId)}`, {
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
    throw new Error(await parseError(res, "Failed to update project"));
  }

  const project = await res.json();
  revalidatePath("/projects");
  revalidatePath(`/projects/${encodeURIComponent(projectId)}`);
  return project;
}

export async function createProjectRowAction(
  projectId: string,
  payload: {
    externalScoreUrl?: string;
    imslpUrl?: string;
    hasReferencePdf?: boolean;
    notes?: string;
  }
) {
  const API_BASE = getApiBase();
  const headers = await getApiAuthHeaders();
  const res = await fetch(`${API_BASE}/projects/${encodeURIComponent(projectId)}/rows`, {
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
    throw new Error(await parseError(res, "Failed to add row"));
  }

  const row = await res.json();
  revalidatePath(`/projects/${encodeURIComponent(projectId)}`);
  return row;
}

export async function updateProjectRowAction(
  projectId: string,
  rowId: string,
  payload: {
    rowVersion: number;
    externalScoreUrl?: string;
    imslpUrl?: string;
    hasReferencePdf?: boolean;
    verified?: boolean;
    notes?: string;
  }
) {
  const API_BASE = getApiBase();
  const headers = await getApiAuthHeaders();
  const res = await fetch(`${API_BASE}/projects/${encodeURIComponent(projectId)}/rows/${encodeURIComponent(rowId)}`, {
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
    throw new Error(await parseError(res, "Failed to update row"));
  }

  const row = await res.json();
  revalidatePath(`/projects/${encodeURIComponent(projectId)}`);
  return row;
}

export async function deleteProjectRowAction(projectId: string, rowId: string) {
  const API_BASE = getApiBase();
  const headers = await getApiAuthHeaders();
  const res = await fetch(`${API_BASE}/projects/${encodeURIComponent(projectId)}/rows/${encodeURIComponent(rowId)}`, {
    method: "DELETE",
    headers
  });

  if (res.status === 401) {
    redirect("/api/auth/signin");
  }
  if (!res.ok) {
    throw new Error(await parseError(res, "Failed to delete row"));
  }

  revalidatePath(`/projects/${encodeURIComponent(projectId)}`);
  return { ok: true };
}

export async function createInternalSourceFromRowAction(
  projectId: string,
  rowId: string,
  payload?: { workId?: string; imslpUrl?: string; sourceId?: string; sourceLabel?: string }
) {
  const API_BASE = getApiBase();
  const headers = await getApiAuthHeaders();
  const res = await fetch(`${API_BASE}/projects/${encodeURIComponent(projectId)}/rows/${encodeURIComponent(rowId)}/create-source`, {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload || {})
  });

  if (res.status === 401) {
    redirect("/api/auth/signin");
  }
  if (!res.ok) {
    throw new Error(await parseError(res, "Failed to create internal source"));
  }

  const result = await res.json();
  revalidatePath(`/projects/${encodeURIComponent(projectId)}`);
  if (result?.workId) {
    revalidatePath(`/works/${encodeURIComponent(result.workId)}`);
  }
  return result as { workId: string; sourceId: string; row?: any };
}
