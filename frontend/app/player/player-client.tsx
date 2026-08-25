"use client";

import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import { useRouter } from "next/navigation";

const SCORE_FILE_ACCEPT = ".musicxml,.xml,.mxl,.mscx,.mscz";
const SUPPORTED_SCORE_FILE = /\.(?:musicxml|xml|mxl|mscx|mscz)$/i;

type ActiveScore = {
  key: string;
  label: string;
  source: "local" | "remote";
  url: string;
};

export function normalizeRemoteScoreUrl(value: string): string | null {
  const candidate = value.trim();
  if (!candidate) return null;

  if (candidate.startsWith("/") && !candidate.startsWith("//")) {
    return candidate;
  }

  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

export function buildStandalonePlayerUrl(
  scoreUrl: string,
  theme?: "light" | "dark",
): string {
  const params = new URLSearchParams({
    score: scoreUrl,
    embed: "player",
    playerId: "standalone-player",
  });
  if (theme) params.set("theme", theme);
  return `/score-editor/index.html?${params.toString()}`;
}

export function buildStandaloneEditorUrl(scoreUrl: string): string {
  const params = new URLSearchParams({ score: scoreUrl });
  return `/score-editor/index.html?${params.toString()}`;
}

function labelForRemoteScore(scoreUrl: string): string {
  try {
    const pathname = new URL(scoreUrl, "https://ourtextscores.invalid").pathname;
    const filename = pathname.split("/").filter(Boolean).at(-1);
    return filename ? decodeURIComponent(filename) : "Score from URL";
  } catch {
    return "Score from URL";
  }
}

function remoteScore(scoreUrl: string): ActiveScore | null {
  const normalized = normalizeRemoteScoreUrl(scoreUrl);
  return normalized
    ? {
        key: `remote:${normalized}`,
        label: labelForRemoteScore(normalized),
        source: "remote",
        url: normalized,
      }
    : null;
}

export default function PlayerClient({
  initialScoreUrl,
}: {
  initialScoreUrl: string;
}) {
  const router = useRouter();
  const initialScoreRef = useRef(remoteScore(initialScoreUrl));
  const localObjectUrlRef = useRef<string | null>(null);
  const [urlInput, setUrlInput] = useState(initialScoreUrl);
  const [activeScore, setActiveScore] = useState<ActiveScore | null>(
    initialScoreRef.current,
  );
  const [error, setError] = useState(
    initialScoreUrl.trim() && !initialScoreRef.current
      ? "Enter an http(s) score URL or a path beginning with /."
      : "",
  );
  const [playerTheme, setPlayerTheme] = useState<"light" | "dark" | null>(null);

  useEffect(() => {
    return () => {
      if (localObjectUrlRef.current) {
        URL.revokeObjectURL(localObjectUrlRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    const updateTheme = () => {
      setPlayerTheme(root.classList.contains("dark") ? "dark" : "light");
    };
    updateTheme();
    const observer = new MutationObserver(updateTheme);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  const releaseLocalObjectUrl = () => {
    if (localObjectUrlRef.current) {
      URL.revokeObjectURL(localObjectUrlRef.current);
      localObjectUrlRef.current = null;
    }
  };

  const handleUrlSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextScore = remoteScore(urlInput);
    if (!nextScore) {
      setError("Enter an http(s) score URL or a path beginning with /.");
      return;
    }

    releaseLocalObjectUrl();
    setError("");
    setUrlInput(nextScore.url);
    setActiveScore(nextScore);
    const params = new URLSearchParams({ score: nextScore.url });
    router.replace(`/player?${params.toString()}`, { scroll: false });
  };

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!SUPPORTED_SCORE_FILE.test(file.name)) {
      setError("Choose a MusicXML (.musicxml, .xml, .mxl) or MuseScore (.mscx, .mscz) file.");
      return;
    }

    releaseLocalObjectUrl();
    const objectUrl = URL.createObjectURL(file);
    localObjectUrlRef.current = objectUrl;
    setError("");
    setActiveScore({
      key: `local:${file.name}:${file.lastModified}:${objectUrl}`,
      label: file.name,
      source: "local",
      url: objectUrl,
    });
    router.replace("/player", { scroll: false });
  };

  return (
    <main className="min-h-[calc(100vh-4rem)] bg-[linear-gradient(180deg,#f8fafc_0%,#e8f1fb_100%)] px-4 py-8 text-slate-900 dark:bg-[linear-gradient(180deg,#020617_0%,#111827_100%)] dark:text-slate-100 sm:px-6">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6">
        <header>
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-cyan-700 dark:text-cyan-300">
            Browser-based playback
          </p>
          <h1 className="mt-2 font-[var(--font-heading)] text-4xl">
            Score Player
          </h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-600 dark:text-slate-300">
            Open a public MusicXML or MuseScore file by URL, or choose a score
            from your device. Public URLs must permit browser access (CORS).
          </p>
        </header>

        <section
          aria-labelledby="open-score-heading"
          className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900 sm:p-5"
        >
          <h2 id="open-score-heading" className="text-base font-semibold">
            Open a score
          </h2>
          <div className="mt-3 flex flex-col gap-3 lg:flex-row lg:items-end">
            <form className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-end" onSubmit={handleUrlSubmit}>
              <label className="min-w-0 flex-1 text-sm font-medium text-slate-700 dark:text-slate-200">
                Score URL
                <input
                  type="text"
                  inputMode="url"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  value={urlInput}
                  onChange={(event) => setUrlInput(event.target.value)}
                  placeholder="https://example.org/path/score.mxl"
                  className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-500/30 dark:border-slate-600 dark:bg-slate-950 dark:text-slate-100"
                />
              </label>
              <button
                type="submit"
                className="rounded-md bg-cyan-700 px-4 py-2 text-sm font-semibold text-white transition hover:bg-cyan-800 focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:ring-offset-2 dark:bg-cyan-600 dark:hover:bg-cyan-500 dark:focus:ring-offset-slate-900"
              >
                Open URL
              </button>
            </form>

            <div className="flex items-center gap-3 lg:border-l lg:border-slate-200 lg:pl-4 dark:lg:border-slate-700">
              <span className="text-xs uppercase tracking-wide text-slate-400">or</span>
              <label className="cursor-pointer rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 focus-within:ring-2 focus-within:ring-cyan-500 focus-within:ring-offset-2 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700 dark:focus-within:ring-offset-slate-900">
                Load file
                <input
                  type="file"
                  accept={SCORE_FILE_ACCEPT}
                  onChange={handleFileChange}
                  className="sr-only"
                />
              </label>
            </div>
          </div>
          <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
            Supported files: MusicXML (.musicxml, .xml, .mxl) and MuseScore
            (.mscx, .mscz). Local files stay in your browser and are not uploaded.
          </p>
          {error && (
            <p role="alert" className="mt-3 text-sm text-red-700 dark:text-red-300">
              {error}
            </p>
          )}
        </section>

        {activeScore ? (
          <section aria-labelledby="player-heading" className="min-w-0">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-3 px-1">
              <h2 id="player-heading" className="truncate text-sm font-semibold text-slate-700 dark:text-slate-200">
                {activeScore.label}
              </h2>
              <div className="flex items-center gap-3">
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  {activeScore.source === "local" ? "Local file" : "Score URL"}
                </span>
                <a
                  href={buildStandaloneEditorUrl(activeScore.url)}
                  target="_blank"
                  rel="noopener"
                  className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:border-cyan-500 hover:text-cyan-800 focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:ring-offset-2 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:hover:border-cyan-400 dark:hover:text-cyan-200 dark:focus:ring-offset-slate-900"
                >
                  Open in Editor <span aria-hidden="true">↗</span>
                </a>
              </div>
            </div>
            {playerTheme ? (
              <iframe
                key={`${activeScore.key}:${playerTheme}`}
                data-testid="standalone-player-frame"
                src={buildStandalonePlayerUrl(activeScore.url, playerTheme)}
                title={`Playback of ${activeScore.label}`}
                allow="autoplay"
                className="h-[min(72vh,52rem)] min-h-[32rem] w-full rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700"
              />
            ) : (
              <div className="flex min-h-[32rem] items-center justify-center rounded-xl border border-slate-200 bg-white text-sm text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400">
                Preparing player…
              </div>
            )}
          </section>
        ) : (
          <section className="flex min-h-72 items-center justify-center rounded-xl border border-dashed border-slate-300 bg-white/60 px-6 text-center dark:border-slate-700 dark:bg-slate-900/50">
            <div>
              <div aria-hidden="true" className="text-4xl text-cyan-700 dark:text-cyan-300">
                ♫
              </div>
              <h2 className="mt-3 text-lg font-semibold">Choose a score to begin</h2>
              <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
                Playback controls will appear here after the score loads.
              </p>
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
