"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getApiBase } from "../../lib/api";
import { getApiAuthHeaders } from "../../lib/authToken";

export async function prunePendingSourcesAction(workId: string) {
  const API_BASE = getApiBase();
  const headers = await getApiAuthHeaders();
  const res = await fetch(
    `${API_BASE}/works/${encodeURIComponent(workId)}/sources/prune-pending`,
    {
      method: "POST",
      headers
    }
  );

  if (res.status === 401) {
    redirect("/api/auth/signin");
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || "Failed to prune pending sources");
  }

  revalidatePath(`/works/${encodeURIComponent(workId)}`);
}

export async function deleteAllSourcesAction(workId: string) {
  const API_BASE = getApiBase();
  const headers = await getApiAuthHeaders();
  const res = await fetch(
    `${API_BASE}/works/${encodeURIComponent(workId)}/sources/delete-all`,
    {
      method: "POST",
      headers
    }
  );

  if (res.status === 401) {
    redirect("/api/auth/signin");
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || "Failed to delete all sources");
  }

  revalidatePath(`/works/${encodeURIComponent(workId)}`);
}

export async function deleteSourceAction(workId: string, sourceId: string) {
  const API_BASE = getApiBase();
  const headers = await getApiAuthHeaders();
  const res = await fetch(
    `${API_BASE}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(
      sourceId
    )}`,
    {
      method: "DELETE",
      headers
    }
  );

  if (res.status === 401) {
    redirect("/api/auth/signin");
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || "Failed to delete source");
  }

  revalidatePath(`/works/${encodeURIComponent(workId)}`);
}

