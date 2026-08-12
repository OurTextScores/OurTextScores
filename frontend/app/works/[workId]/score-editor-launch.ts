export type ScoreEditorLaunchContext = {
  source?: string;
  workId?: string;
  sourceId?: string;
  branchName?: string;
  revisionId?: string;
  sourceType?: string;
  sourceLabel?: string;
  workTitle?: string;
  composer?: string;
  imslpUrl?: string;
  canonicalXmlUrl?: string;
};

const FIELD_LIMITS: Record<keyof ScoreEditorLaunchContext, number> = {
  source: 64,
  workId: 128,
  sourceId: 128,
  branchName: 128,
  revisionId: 128,
  sourceType: 64,
  sourceLabel: 256,
  workTitle: 512,
  composer: 256,
  imslpUrl: 2048,
  canonicalXmlUrl: 4096,
};

const asRecord = (value: unknown): Record<string, unknown> | null => (
  value && typeof value === 'object' ? value as Record<string, unknown> : null
);

const readBoundedString = (value: unknown, maxLength: number) => {
  if (typeof value !== 'string') {
    return '';
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }
  return trimmed.slice(0, maxLength);
};

export function sanitizeScoreEditorLaunchContext(value: unknown): ScoreEditorLaunchContext | null {
  const data = asRecord(value);
  if (!data) {
    return null;
  }

  const next: ScoreEditorLaunchContext = {};
  (Object.keys(FIELD_LIMITS) as Array<keyof ScoreEditorLaunchContext>).forEach((key) => {
    const normalized = readBoundedString(data[key], FIELD_LIMITS[key]);
    if (normalized) {
      next[key] = normalized;
    }
  });

  return Object.keys(next).length > 0 ? next : null;
}

export function buildScoreEditorLaunchUrl(args: {
  scoreUrl: string;
  launchContext?: ScoreEditorLaunchContext | null;
  /**
   * Render one score with no editor chrome, for an inline preview.
   *
   * Opt-in rather than implied by `scoreUrl`, because the same URL shape opens
   * the full editor from elsewhere in the product and that must keep its
   * toolbar. The editor reads this as `embed=1`.
   */
  embed?: boolean;
}) {
  const params = new URLSearchParams();
  params.set('score', args.scoreUrl);
  const launchContext = sanitizeScoreEditorLaunchContext(args.launchContext);
  if (launchContext) {
    params.set('launchContext', JSON.stringify(launchContext));
  }
  if (args.embed) {
    params.set('embed', '1');
  }
  return `/score-editor/index.html?${params.toString()}`;
}

/**
 * The canonical MusicXML of a source, as an absolute URL.
 *
 * Absolute because the score editor is served as a static export and fetches
 * this itself; a path relative to the page would resolve against the editor's
 * own origin in development, where the API is on another port.
 */
export function canonicalScoreUrl(args: {
  apiBase: string;
  workId: string;
  sourceId: string;
}) {
  const absoluteApiBase = args.apiBase.startsWith('http')
    ? args.apiBase
    : `${window.location.protocol}//${window.location.hostname}:4000${args.apiBase}`;
  return `${absoluteApiBase}/works/${encodeURIComponent(args.workId)}/sources/${encodeURIComponent(
    args.sourceId,
  )}/canonical.xml`;
}
