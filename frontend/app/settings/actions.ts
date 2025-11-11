"use server";

import { revalidatePath } from "next/cache";
import { getApiBase } from "../lib/api";
import { getApiAuthHeaders } from "../lib/authToken";

export async function updateWatchPreference(pref: 'immediate' | 'daily' | 'weekly') {
  const API_BASE = getApiBase();
  const headers = await getApiAuthHeaders();
  const res = await fetch(`${API_BASE}/users/me/preferences`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      ...headers
    },
    body: JSON.stringify({ watchPreference: pref })
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(body || 'Failed to update preferences');
  }
  revalidatePath('/settings');
}

export async function handleUpdateWatchPreference(prevState: any, formData: FormData) {
  try {
    const value = String(formData.get('watchPreference') || 'immediate') as 'immediate' | 'daily' | 'weekly';
    await updateWatchPreference(value);
    return { success: true };
  } catch (error) {
    return { success: false, error: 'Failed to update notification preferences' };
  }
}

export async function updateProfile(data: { username?: string }) {
  const API_BASE = getApiBase();
  const headers = await getApiAuthHeaders();
  const res = await fetch(`${API_BASE}/users/me`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      ...headers
    },
    body: JSON.stringify(data)
  });
  const result = await res.json();
  if (!res.ok || !result.ok) {
    return { success: false, error: result.error || 'Failed to update profile' };
  }
  revalidatePath('/settings');
  return { success: true };
}

export async function handleUpdateProfile(prevState: any, formData: FormData) {
  try {
    const username = formData.get('username')?.toString();
    return await updateProfile({ username });
  } catch (error) {
    return { success: false, error: 'An unexpected error occurred' };
  }
}

