/*
 * Copyright (C) 2025 OurTextScores Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

import { notFound } from "next/navigation";

// Prefer an internal URL for server-side fetches (inside the container),
// and a public URL for client-side/browser fetches. Always normalize to include '/api'.
const DEFAULT_CLIENT_API_BASE = "http://localhost:4000/api";

function normalizeApiBase(raw: string): string {
  if (!raw) return DEFAULT_CLIENT_API_BASE;
  const trimmed = raw.replace(/\/+$/, "");
  return trimmed.endsWith("/api") ? trimmed : `${trimmed}/api`;
}

export function getApiBase(): string {
  if (typeof window === "undefined") {
    const DEFAULT_SERVER_API_BASE = "http://backend:4000/api";
    return normalizeApiBase(process.env.INTERNAL_API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? DEFAULT_SERVER_API_BASE);
  }
  return normalizeApiBase(process.env.NEXT_PUBLIC_API_URL ?? DEFAULT_CLIENT_API_BASE);
}

// Always return a browser-accessible API base, regardless of SSR/runtime.
// Uses NEXT_PUBLIC_API_URL or defaults to localhost:4000/api.
export function getPublicApiBase(): string {
  return normalizeApiBase(process.env.NEXT_PUBLIC_API_URL ?? DEFAULT_CLIENT_API_BASE);
}

export interface WorkSummary {
  workId: string;
  latestRevisionAt?: string;
  sourceCount: number;
  availableFormats: string[];
  title?: string;
  composer?: string;
  catalogNumber?: string;
}

export interface PaginatedWorksResponse {
  works: WorkSummary[];
  total: number;
  limit: number;
  offset: number;
}

export interface StorageLocator {
  bucket: string;
  objectKey: string;
  sizeBytes: number;
  contentType: string;
  lastModifiedAt: string;
  checksum: {
    algorithm: string;
    hexDigest: string;
  };
}

export interface DerivativeArtifacts {
  normalizedMxl?: StorageLocator;
  canonicalXml?: StorageLocator;
  linearizedXml?: StorageLocator;
  pdf?: StorageLocator;
  mscz?: StorageLocator;
  manifest?: StorageLocator;
  musicDiffReport?: StorageLocator;
  musicDiffHtml?: StorageLocator;
}

export interface ValidationState {
  status: "pending" | "passed" | "failed";
  performedAt?: string;
  validatorVersion?: string;
  issues: Array<{
    level: string;
    code: string;
    message: string;
    path?: string;
  }>;
  overrideNote?: string;
}

export interface SourceRevisionView {
  revisionId: string;
  sequenceNumber: number;
  createdAt: string;
  createdBy: string;
  changeSummary?: string;
  rawStorage: StorageLocator;
  checksum: {
    algorithm: string;
    hexDigest: string;
  };
  derivatives?: DerivativeArtifacts;
  manifest?: StorageLocator;
  validation: ValidationState;
  fossilArtifactId?: string;
  fossilParentArtifactIds: string[];
  fossilBranch?: string;
}

export interface SourceView {
  sourceId: string;
  label: string;
  sourceType: "score" | "parts" | "audio" | "metadata" | "other";
  format: string;
  description?: string;
  license?: string;
  licenseUrl?: string;
  licenseAttribution?: string;
  originalFilename: string;
  isPrimary: boolean;
  storage: StorageLocator;
  validation: ValidationState;
  provenance: {
    ingestType: "manual" | "batch" | "sync";
    sourceSystem?: string;
    sourceIdentifier?: string;
    uploadedByUserId?: string;
    uploadedByName?: string;
    uploadedAt: string;
    notes: string[];
  };
  derivatives?: DerivativeArtifacts;
  latestRevisionId?: string;
  latestRevisionAt?: string;
  revisions: SourceRevisionView[];
}

export interface WorkDetail extends WorkSummary {
  sources: SourceView[];
}

export interface ImslpWorkSummary {
  workId: string;
  title: string;
  composer?: string;
  permalink: string;
  metadata: Record<string, unknown>;
}

export interface EnsureWorkResponse {
  work: WorkSummary;
  metadata: ImslpWorkSummary;
}

interface ImslpEnsureResult {
  workId: string;
  metadata: ImslpWorkSummary;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const explicitNext = init?.next;
  const response = await fetch(url, {
    ...init,
    headers: {
      "Accept": "application/json",
      ...(init?.headers ?? {})
    },
    next: explicitNext !== undefined
      ? explicitNext
      : (init?.cache === "no-store"
        ? undefined
        : {
            revalidate: 30,
            ...(init?.next ?? {})
          })
  });

  if (response.status === 404) {
    notFound();
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`API request failed (${response.status}): ${body}`);
  }

  return response.json() as Promise<T>;
}

export async function fetchWorks(options?: { limit?: number; offset?: number }): Promise<WorkSummary[]> {
  try {
    const params = new URLSearchParams();
    if (options?.limit !== undefined) params.set('limit', String(options.limit));
    if (options?.offset !== undefined) params.set('offset', String(options.offset));
    const url = `${getApiBase()}/works${params.toString() ? `?${params.toString()}` : ''}`;
    const response = await fetchJson<PaginatedWorksResponse>(url);
    return response.works;
  } catch (error) {
    // During static builds there may be no API available; fall back to empty data.
    if (process.env.NODE_ENV === "production") {
      return [];
    }
    throw error;
  }
}

export async function fetchWorksPaginated(options?: { limit?: number; offset?: number }): Promise<PaginatedWorksResponse> {
  try {
    const params = new URLSearchParams();
    if (options?.limit !== undefined) params.set('limit', String(options.limit));
    if (options?.offset !== undefined) params.set('offset', String(options.offset));
    const url = `${getApiBase()}/works${params.toString() ? `?${params.toString()}` : ''}`;
    return await fetchJson<PaginatedWorksResponse>(url);
  } catch (error) {
    // During static builds there may be no API available; fall back to empty data.
    if (process.env.NODE_ENV === "production") {
      return { works: [], total: 0, limit: 20, offset: 0 };
    }
    throw error;
  }
}

export async function fetchWorkDetail(workId: string): Promise<WorkDetail> {
  // Always fetch fresh data so revision history reflects immediately after uploads
  return fetchJson<WorkDetail>(`${getApiBase()}/works/${encodeURIComponent(workId)}` , {
    cache: "no-store",
    next: { revalidate: 0 }
  });
}

export async function updateWorkMetadata(
  workId: string,
  updates: { title?: string; composer?: string; catalogNumber?: string }
): Promise<WorkSummary> {
  const response = await fetch(`${getApiBase()}/works/${encodeURIComponent(workId)}/metadata`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates)
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || "Failed to update work metadata");
  }
  return (await response.json()) as WorkSummary;
}

export async function ensureWork(workId: string): Promise<EnsureWorkResponse> {
  const response = await fetch(`${getApiBase()}/works`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ workId })
  });

  if (response.status === 404) {
    throw new Error(`Work ${workId} not found in IMSLP metadata`);
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Unable to ensure work: ${body}`);
  }

  return response.json() as Promise<EnsureWorkResponse>;
}

export async function uploadSourceRevision(
  workId: string,
  sourceId: string,
  form: FormData
): Promise<{ revisionId: string; workId: string; sourceId: string }> {
  const response = await fetch(
    `${getApiBase()}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(sourceId)}/revisions`,
    {
      method: "POST",
      body: form
    }
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Upload failed with status ${response.status}`);
  }
  return (await response.json()) as { revisionId: string; workId: string; sourceId: string };
}

export async function searchImslp(query: string, limit = 10): Promise<ImslpWorkSummary[]> {
  if (!query.trim()) {
    return [];
  }

  try {
    const params = new URLSearchParams({ q: query, limit: String(limit) });
    return await fetchJson<ImslpWorkSummary[]>(`${getApiBase()}/imslp/search?${params.toString()}`);
  } catch (error) {
    if (process.env.NODE_ENV === "production") {
      return [];
    }
    throw error;
  }
}

export async function resolveImslpUrl(url: string): Promise<EnsureWorkResponse> {
  // Save work by URL (single round-trip, creates Work + caches metadata)
  const response = await fetch(`${getApiBase()}/works/save-by-url`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ url })
  });

  if (response.status === 404) {
    throw new Error("IMSLP work not found for the provided URL");
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Unable to resolve IMSLP URL: ${body || "Unknown error"}`);
  }

  return (await response.json()) as EnsureWorkResponse;
}

export async function fetchImslpMetadataByWorkId(workId: string): Promise<ImslpWorkSummary> {
  const result = await fetchJson<{ workId: string; metadata: ImslpWorkSummary }>(
    `${getApiBase()}/imslp/works/${encodeURIComponent(workId)}`
  );
  return result.metadata;
}

export interface ImslpRawDoc {
  _id?: string;
  workId: string;
  title?: string;
  composer?: string;
  permalink?: string;
  createdAt?: string;
  updatedAt?: string;
  metadata?: Record<string, unknown>;
}

export async function fetchImslpRawDoc(workId: string): Promise<ImslpRawDoc | undefined> {
  try {
    return await fetchJson<ImslpRawDoc>(`${getApiBase()}/imslp/works/${encodeURIComponent(workId)}/raw`);
  } catch {
    return undefined;
  }
}

export interface PublicUserProfile {
  id: string;
  username?: string;
  displayName?: string;
}

export interface UserUploadSourceSummary {
  workId: string;
  workTitle?: string;
  workComposer?: string;
  workCatalogNumber?: string;
  sourceId: string;
  label: string;
  format: string;
  isPrimary: boolean;
  latestRevisionId?: string;
  latestRevisionAt?: string;
}

export interface UserRecentRevisionSummary {
  workId: string;
  workTitle?: string;
  sourceId: string;
  revisionId: string;
  sequenceNumber: number;
  createdAt: string;
  changeSummary?: string;
}

export interface UserUploadsResponse {
  user: PublicUserProfile;
  stats: {
    sourceCount: number;
    revisionCount: number;
    workCount: number;
  };
  sources: UserUploadSourceSummary[];
  recentRevisions: UserRecentRevisionSummary[];
}

export interface UserSearchResult {
  id: string;
  username: string;
  displayName?: string;
}

export interface UserSearchResponse {
  users: UserSearchResult[];
  total: number;
  limit: number;
  offset: number;
}

export async function fetchUserByUsername(username: string): Promise<PublicUserProfile> {
  const data = await fetchJson<{ user: PublicUserProfile }>(
    `${getApiBase()}/users/by-username/${encodeURIComponent(username)}`
  );
  return data.user;
}

export async function fetchUserUploads(
  userId: string,
  options?: { limit?: number; offset?: number }
): Promise<UserUploadsResponse> {
  const params = new URLSearchParams();
  if (options?.limit !== undefined) params.set('limit', String(options.limit));
  if (options?.offset !== undefined) params.set('offset', String(options.offset));
  const qs = params.toString();
  return await fetchJson<UserUploadsResponse>(
    `${getApiBase()}/users/${encodeURIComponent(userId)}/uploads${qs ? `?${qs}` : ''}`
  );
}

export async function searchUsers(
  query: string,
  options?: { limit?: number; offset?: number }
): Promise<UserSearchResponse> {
  const trimmed = query.trim();
  const limit = options?.limit ?? 20;
  const offset = options?.offset ?? 0;
  if (!trimmed) {
    return { users: [], total: 0, limit, offset };
  }
  const params = new URLSearchParams({
    q: trimmed,
    limit: String(limit),
    offset: String(offset)
  });
  return await fetchJson<UserSearchResponse>(`${getApiBase()}/search/users?${params.toString()}`);
}
