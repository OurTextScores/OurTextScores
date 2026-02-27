"use client";

import { useEffect } from "react";

const SESSION_COOKIE_NAME = "ots_session_id";
const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

function readCookie(name: string): string | null {
  if (typeof document === "undefined") {
    return null;
  }
  const encoded = encodeURIComponent(name);
  const segments = document.cookie ? document.cookie.split(";") : [];
  for (const segment of segments) {
    const trimmed = segment.trim();
    if (!trimmed.startsWith(`${encoded}=`)) {
      continue;
    }
    const raw = trimmed.slice(encoded.length + 1);
    if (!raw) {
      return null;
    }
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}

function ensureClientSessionCookie(): void {
  const existing = readCookie(SESSION_COOKIE_NAME);
  if (existing && SESSION_ID_PATTERN.test(existing)) {
    return;
  }

  const id =
    (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`)
      .replace(/\s+/g, "");

  if (!SESSION_ID_PATTERN.test(id)) {
    return;
  }

  const secure = typeof window !== "undefined" && window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${encodeURIComponent(SESSION_COOKIE_NAME)}=${encodeURIComponent(
    id
  )}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
}

export default function ClientSessionBootstrap() {
  useEffect(() => {
    ensureClientSessionCookie();
  }, []);

  return null;
}
