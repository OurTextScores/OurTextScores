/**
 * Performer mode, the vendored editor's iPad score reader (OTS_Web v3.5.0+): a static page under /score-editor
 * (the host serves perform.html; see OTS_Web docs/BUILD_EMBED.md, "Hosting Performer Mode").
 */
const PERFORM_APP = "/score-editor/perform.html";

/** A score to try it with (the Score Player's example on /welcome). */
export const EXAMPLE_SCORE_URL =
  "https://raw.githubusercontent.com/DCMLab/beethoven_piano_sonatas/main/MS3/01-1.mscx";

/** Performer mode's address: its library, a score (`score`), its guide (`guide`) or its device self-test. */
export function performHref(query: Record<string, string | true> = {}): string {
  const search = Object.entries(query)
    .map(([key, value]) => (value === true ? key : `${key}=${encodeURIComponent(value)}`))
    .join("&");
  return search ? `${PERFORM_APP}?${search}` : PERFORM_APP;
}
