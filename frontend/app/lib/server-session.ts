import { getApiBase } from "./api";
import { getApiAuthHeaders } from "./authToken";

export interface BackendSessionUser {
  userId: string;
  email?: string;
  name?: string;
  roles?: string[];
}

export interface BackendSession {
  user: BackendSessionUser | null;
}

export async function fetchBackendSession(): Promise<BackendSession> {
  const API_BASE = getApiBase();
  const headers = await getApiAuthHeaders();
  const res = await fetch(`${API_BASE}/auth/session`, {
    headers,
    cache: "no-store"
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || "Failed to load session");
  }

  const data = (await res.json()) as { user?: BackendSessionUser | null };
  return { user: data.user ?? null };
}

