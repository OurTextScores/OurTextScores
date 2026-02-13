/// <reference lib="webworker" />

interface WebMscoreInstance {
  ready: Promise<void>;
  load: (format: string, data: Uint8Array) => Promise<{
    saveMxl?: () => Promise<Uint8Array>;
    destroy?: () => void;
  }>;
}

type ClientConversionMilestone =
  | "prepare"
  | "engine"
  | "convert"
  | "finalize"
  | "done";

type WorkerConvertRequest = {
  type: "convert";
  fileName: string;
  bytes: ArrayBuffer;
};

type WorkerConvertResponse =
  | { type: "progress"; message: string; milestone: ClientConversionMilestone }
  | { type: "heartbeat"; message: string; milestone: ClientConversionMilestone }
  | { type: "done"; bytes: ArrayBuffer }
  | { type: "error"; message: string };

const HEARTBEAT_INTERVAL_MS = 1500;

let webMscoreReadyPromise: Promise<WebMscoreInstance> | null = null;

function resolveWebMscoreModule(mod: unknown): WebMscoreInstance {
  const candidates = [
    mod as Record<string, unknown> | undefined,
    (mod as { default?: unknown } | undefined)?.default as
      | Record<string, unknown>
      | undefined,
    ((mod as { default?: { default?: unknown } } | undefined)?.default?.default) as
      | Record<string, unknown>
      | undefined,
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    const ready = candidate.ready;
    const load = candidate.load;
    if (
      ready &&
      typeof (ready as Promise<void>).then === "function" &&
      typeof load === "function"
    ) {
      return candidate as unknown as WebMscoreInstance;
    }
  }

  throw new Error("Unexpected webmscore module shape (missing ready/load)");
}

async function loadWebMscore(): Promise<WebMscoreInstance> {
  if (!webMscoreReadyPromise) {
    webMscoreReadyPromise = (async () => {
      (globalThis as { MSCORE_SCRIPT_URL?: string }).MSCORE_SCRIPT_URL = "/";
      const mod = await import("webmscore");
      const resolved = resolveWebMscoreModule(mod);
      await resolved.ready;
      return resolved;
    })();
  }

  return webMscoreReadyPromise;
}

function post(payload: WorkerConvertResponse, transfer?: Transferable[]): void {
  if (transfer && transfer.length > 0) {
    self.postMessage(payload, transfer);
    return;
  }
  self.postMessage(payload);
}

self.onmessage = async (event: MessageEvent<WorkerConvertRequest>) => {
  const data = event.data;
  if (!data || data.type !== "convert") {
    return;
  }

  let score: Awaited<ReturnType<WebMscoreInstance["load"]>> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  try {
    post({
      type: "progress",
      message: "Loading webmscore engine",
      milestone: "engine",
    });
    const webMscore = await loadWebMscore();

    post({
      type: "progress",
      message: `Converting ${data.fileName} to MXL`,
      milestone: "convert",
    });

    heartbeatTimer = setInterval(() => {
      post({
        type: "heartbeat",
        message: "webmscore conversion still running",
        milestone: "convert",
      });
    }, HEARTBEAT_INTERVAL_MS);

    score = await webMscore.load("mscz", new Uint8Array(data.bytes));
    if (typeof score.saveMxl !== "function") {
      throw new Error("webmscore build does not support saveMxl().");
    }

    post({
      type: "progress",
      message: "Finalizing converted MXL",
      milestone: "finalize",
    });

    const mxlBytes = await score.saveMxl();
    // Copy into a standalone buffer before posting. Some engines return views
    // backed by wasm memory that are not safely transferable as-is.
    const copied = new Uint8Array(mxlBytes.byteLength);
    copied.set(mxlBytes);
    const transferred = copied.buffer;

    post({ type: "done", bytes: transferred }, [transferred]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    post({ type: "error", message });
  } finally {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
    }
    try {
      score?.destroy?.();
    } catch {
      // Best-effort cleanup.
    }
  }
};

export {};
