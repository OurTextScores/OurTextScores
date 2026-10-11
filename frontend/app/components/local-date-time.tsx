"use client";

import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

/**
 * False on the server and while the server's HTML is being hydrated; true once the page is
 * live in the browser, and from the start on a page reached by in-app navigation.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false
  );
}

function utcText(date: Date, dateOnly: boolean): string {
  const iso = date.toISOString();
  return dateOnly ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/**
 * A point in time, in the reader's own locale and time zone.
 *
 * The server knows neither, so it cannot write that text, and a component that formats a date
 * with `toLocaleString()` while it renders produces HTML the browser disagrees with: React
 * then throws the page's HTML away and renders it again (errors #418, #423 and #425). This
 * writes the time in UTC first, the same on both sides, and swaps in the local form once the
 * page has hydrated.
 */
export default function LocalDateTime({
  value,
  dateOnly = false,
  fallback = "—"
}: {
  value?: string | number | Date | null;
  dateOnly?: boolean;
  fallback?: string;
}) {
  const hydrated = useHydrated();
  if (value === undefined || value === null || value === "") return <>{fallback}</>;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return <>{fallback}</>;
  const local = dateOnly ? date.toLocaleDateString() : date.toLocaleString();
  return <time dateTime={date.toISOString()}>{hydrated ? local : utcText(date, dateOnly)}</time>;
}
