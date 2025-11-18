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
    let errorMessage = "Failed to prune pending sources";

    try {
      const json = JSON.parse(text);
      errorMessage = json.message || json.error || errorMessage;
    } catch {
      if (text && text.length > 0 && text.length < 200) {
        errorMessage = text;
      }
    }

    throw new Error(errorMessage);
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
    let errorMessage = "Failed to delete all sources";

    try {
      const json = JSON.parse(text);
      errorMessage = json.message || json.error || errorMessage;
    } catch {
      if (text && text.length > 0 && text.length < 200) {
        errorMessage = text;
      }
    }

    throw new Error(errorMessage);
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
    let errorMessage = "Failed to delete source";

    try {
      const json = JSON.parse(text);
      errorMessage = json.message || json.error || errorMessage;
    } catch {
      // If not JSON, use the text directly if it's not empty
      if (text && text.length > 0 && text.length < 200) {
        errorMessage = text;
      }
    }

    throw new Error(errorMessage);
  }

  revalidatePath(`/works/${encodeURIComponent(workId)}`);
}

