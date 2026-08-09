"use client";

import { useEffect, useState } from "react";

export default function ThemeToggle() {
  // The server has no localStorage, so it always renders the light glyph. If the
  // first client render disagreed — which it did when the initial state was read
  // straight from localStorage — React hit a text-content hydration mismatch
  // (error #425) and discarded the server-rendered tree. Remounting that tree
  // took the header's `useSession()` state with it, so a signed-in user saw
  // signed-out chrome in dark mode.
  //
  // So: render the same thing the server did, then adopt the real theme after
  // mount. There is no flash, because the inline script in `layout.tsx` has
  // already applied the class before first paint.
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    // Read the stored preference, not the current class: React's rendered
    // `<html>` className contains no `dark`, so hydration strips the class the
    // pre-hydration script added. The effect below puts it back.
    const saved = window.localStorage.getItem("theme");
    setTheme(saved === "dark" ? "dark" : "light");
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted) return;
    const root = document.documentElement;
    if (theme === "dark") root.classList.add("dark");
    else root.classList.remove("dark");
    window.localStorage.setItem("theme", theme);
  }, [theme, mounted]);

  return (
    <button
      type="button"
      aria-label="Toggle theme"
      onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
      className="rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-900"
      title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
    >
      {theme === "dark" ? "☼" : "◐"}
    </button>
  );
}
