type AnalyticsValue = string | number | boolean | null | undefined;
type AnalyticsProperties = Record<string, AnalyticsValue>;

type UploadOutcome = "success" | "failure";
type UploadKind = "source" | "revision";
type UploadFlow = "upload_page" | "work_page_new_source" | "work_page_revision";
type BranchMode = "existing" | "new";
type ServerOutcome = "success" | "failure" | "unauthorized";

const MAX_STRING_LENGTH = 160;

function shouldSkipTracking(): boolean {
  return process.env.NODE_ENV === "test" || Boolean(process.env.JEST_WORKER_ID);
}

function sanitizeValue(value: AnalyticsValue): AnalyticsValue {
  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim().replace(/\s+/g, " ");
  if (!trimmed) {
    return undefined;
  }

  return trimmed.length > MAX_STRING_LENGTH
    ? `${trimmed.slice(0, MAX_STRING_LENGTH - 1)}…`
    : trimmed;
}

function sanitizeProperties(properties?: AnalyticsProperties): AnalyticsProperties | undefined {
  if (!properties) {
    return undefined;
  }

  const safe: AnalyticsProperties = {};
  for (const [key, value] of Object.entries(properties)) {
    const sanitized = sanitizeValue(value);
    if (sanitized !== undefined) {
      safe[key] = sanitized;
    }
  }

  return Object.keys(safe).length > 0 ? safe : undefined;
}

async function trackServerEvent(name: string, properties?: AnalyticsProperties): Promise<void> {
  if (shouldSkipTracking()) {
    return;
  }

  try {
    const { track } = await import("@vercel/analytics/server");
    await track(name, sanitizeProperties(properties));
  } catch {
    // Non-blocking: analytics should never break product flows.
  }
}

function trackClientEvent(name: string, properties?: AnalyticsProperties): void {
  if (shouldSkipTracking() || typeof window === "undefined") {
    return;
  }

  const safe = sanitizeProperties(properties);
  void import("@vercel/analytics/react")
    .then(({ track }) => {
      track(name, safe);
    })
    .catch(() => {
      // Non-blocking: analytics should never break product flows.
    });
}

export function getFileExtension(filename: string | null | undefined): string | undefined {
  if (!filename) {
    return undefined;
  }

  const trimmed = filename.trim();
  if (!trimmed || !trimmed.includes(".")) {
    return undefined;
  }

  return trimmed.split(".").pop()?.toLowerCase();
}

export function toAnalyticsError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function trackUploadOutcomeClient(params: {
  flow: UploadFlow;
  outcome: UploadOutcome;
  kind: UploadKind;
  workId: string;
  sourceId?: string;
  revisionId?: string;
  fileExt?: string;
  branchMode?: BranchMode;
  createBranch?: boolean;
  hasReferencePdf?: boolean;
  error?: string;
}): void {
  trackClientEvent("upload_outcome", {
    flow: params.flow,
    outcome: params.outcome,
    kind: params.kind,
    work_id: params.workId,
    source_id: params.sourceId,
    revision_id: params.revisionId,
    file_ext: params.fileExt,
    branch_mode: params.branchMode,
    create_branch: params.createBranch,
    has_reference_pdf: params.hasReferencePdf,
    error: params.error,
  });
}

export async function trackApprovalOutcomeServer(params: {
  decision: "approve" | "reject";
  outcome: ServerOutcome;
  workId: string;
  sourceId: string;
  revisionId: string;
  error?: string;
}): Promise<void> {
  await trackServerEvent("approval_outcome", {
    decision: params.decision,
    outcome: params.outcome,
    work_id: params.workId,
    source_id: params.sourceId,
    revision_id: params.revisionId,
    error: params.error,
  });
}

export async function trackWatchToggleServer(params: {
  action: "watch" | "unwatch";
  outcome: ServerOutcome;
  workId: string;
  sourceId: string;
  error?: string;
}): Promise<void> {
  await trackServerEvent("watch_toggle", {
    action: params.action,
    outcome: params.outcome,
    work_id: params.workId,
    source_id: params.sourceId,
    error: params.error,
  });
}
