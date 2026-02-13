export type ClientConversionEngine = "webmscore";
export type ClientConversionMilestone =
  | "prepare"
  | "engine"
  | "convert"
  | "finalize"
  | "done";

export interface ClientMsczConversionProgress {
  message: string;
  milestone: ClientConversionMilestone;
  engine: ClientConversionEngine;
  startedAtMs: number;
  heartbeatAtMs: number;
  heartbeatOnly?: boolean;
}

export interface PreparedUploadFile {
  file: File;
  convertedFromMscz: boolean;
  originalFilename: string;
  originalMsczFile?: File;
}

interface WebMscoreInstance {
  ready: Promise<void>;
  load: (format: string, data: Uint8Array) => Promise<{
    saveMxl?: () => Promise<Uint8Array>;
    destroy?: () => void;
  }>;
}

interface WorkerConvertRequest {
  type: "convert";
  fileName: string;
  bytes: ArrayBuffer;
}

type WorkerConvertResponse =
  | { type: "progress"; message: string; milestone: ClientConversionMilestone }
  | { type: "heartbeat"; message: string; milestone: ClientConversionMilestone }
  | { type: "done"; bytes: ArrayBuffer }
  | { type: "error"; message: string };

const MXL_CONTENT_TYPE = "application/vnd.recordare.musicxml";

let webMscoreReadyPromise: Promise<WebMscoreInstance> | null = null;

function isMsczFilename(name: string): boolean {
  return name.toLowerCase().endsWith(".mscz");
}

function toMxlFilename(name: string): string {
  return name.replace(/\.mscz$/i, ".mxl");
}

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
  if (typeof window === "undefined") {
    throw new Error("Browser conversion is only available in the browser.");
  }

  if (!webMscoreReadyPromise) {
    webMscoreReadyPromise = (async () => {
      // webmscore reads this global at initialization time.
      (globalThis as { MSCORE_SCRIPT_URL?: string }).MSCORE_SCRIPT_URL = "/";
      const webMscoreMod = await import("webmscore");
      const resolved = resolveWebMscoreModule(webMscoreMod);
      await resolved.ready;
      return resolved;
    })();
  }

  return webMscoreReadyPromise;
}

type ProgressCallback = (progress: ClientMsczConversionProgress) => void;

type ProgressEmitter = (
  message: string,
  milestone: ClientConversionMilestone,
  options?: { heartbeatOnly?: boolean }
) => void;

function createProgressEmitter(callback?: ProgressCallback): ProgressEmitter {
  const startedAtMs = Date.now();

  return (
    message: string,
    milestone: ClientConversionMilestone,
    options?: { heartbeatOnly?: boolean }
  ) => {
    callback?.({
      message,
      milestone,
      engine: "webmscore",
      startedAtMs,
      heartbeatAtMs: Date.now(),
      heartbeatOnly: options?.heartbeatOnly === true,
    });
  };
}

function supportsWorkerConversion(): boolean {
  return typeof window !== "undefined" && typeof Worker !== "undefined";
}

async function readFileBytes(file: File): Promise<Uint8Array> {
  const maybeArrayBuffer = (file as { arrayBuffer?: () => Promise<ArrayBuffer> })?.arrayBuffer;
  if (typeof maybeArrayBuffer === "function") {
    return new Uint8Array(await maybeArrayBuffer.call(file));
  }
  const fallbackBuffer = await new Response(file).arrayBuffer();
  return new Uint8Array(fallbackBuffer);
}

function toTransferableBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer;
  }
  return bytes.slice().buffer;
}

async function convertWithWorker(
  file: File,
  inputBytes: Uint8Array,
  emitProgress: ProgressEmitter
): Promise<Uint8Array> {
  if (!supportsWorkerConversion()) {
    throw new Error("Web Worker API is unavailable.");
  }

  const worker = new Worker(new URL("./mscz-conversion.worker.ts", import.meta.url), {
    type: "module",
  });

  return await new Promise<Uint8Array>((resolve, reject) => {
    const cleanup = () => {
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
    };

    worker.onmessage = (event: MessageEvent<WorkerConvertResponse>) => {
      const data = event.data;
      if (!data) {
        return;
      }

      if (data.type === "progress") {
        emitProgress(data.message, data.milestone);
        return;
      }

      if (data.type === "heartbeat") {
        emitProgress(data.message, data.milestone, { heartbeatOnly: true });
        return;
      }

      if (data.type === "done") {
        emitProgress("Browser conversion complete (webmscore)", "done");
        cleanup();
        resolve(new Uint8Array(data.bytes));
        return;
      }

      if (data.type === "error") {
        cleanup();
        reject(new Error(data.message || "Web worker conversion failed."));
      }
    };

    worker.onerror = (event: ErrorEvent) => {
      cleanup();
      reject(new Error(event.message || "Web worker conversion failed."));
    };

    const bytes = toTransferableBuffer(inputBytes);
    const payload: WorkerConvertRequest = {
      type: "convert",
      fileName: file.name,
      bytes,
    };
    worker.postMessage(payload, [bytes]);
  });
}

async function convertOnMainThread(
  inputBytes: Uint8Array,
  emitProgress: ProgressEmitter
): Promise<Uint8Array> {
  emitProgress("Loading webmscore in page thread", "engine");
  const webMscore = await loadWebMscore();

  let score: Awaited<ReturnType<WebMscoreInstance["load"]>> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  try {
    emitProgress("Converting MSCZ to MXL with webmscore", "convert");
    heartbeatTimer = setInterval(() => {
      emitProgress("Still converting in browser thread", "convert", { heartbeatOnly: true });
    }, 1500);

    score = await webMscore.load("mscz", inputBytes);
    if (typeof score.saveMxl !== "function") {
      throw new Error("webmscore build does not support saveMxl().");
    }

    emitProgress("Finalizing converted file", "finalize");
    const mxlBytes = await score.saveMxl();
    return mxlBytes;
  } finally {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
    }
    try {
      score?.destroy?.();
    } catch {
      // Best-effort cleanup only.
    }
  }
}

export async function prepareUploadScoreFile(
  file: File,
  onProgress?: ProgressCallback
): Promise<PreparedUploadFile> {
  if (!isMsczFilename(file.name)) {
    return {
      file,
      convertedFromMscz: false,
      originalFilename: file.name,
    };
  }

  const emitProgress = createProgressEmitter(onProgress);
  emitProgress("Preparing browser conversion (webmscore)", "prepare");
  const inputBytes = await readFileBytes(file);

  let mxlBytes: Uint8Array;
  if (supportsWorkerConversion()) {
    emitProgress("Starting webmscore worker", "engine");
    try {
      mxlBytes = await convertWithWorker(file, inputBytes, emitProgress);
    } catch (workerError) {
      const workerMessage =
        workerError instanceof Error ? workerError.message : String(workerError);
      emitProgress(`Worker unavailable, retrying in page thread: ${workerMessage}`, "engine");
      // `convertWithWorker` transfers the original buffer, which can detach it in
      // the main thread. Re-read bytes for a safe fallback path.
      const fallbackInputBytes = await readFileBytes(file);
      mxlBytes = await convertOnMainThread(fallbackInputBytes, emitProgress);
    }
  } else {
    mxlBytes = await convertOnMainThread(inputBytes, emitProgress);
  }

  const mxlFile = new File([mxlBytes], toMxlFilename(file.name), {
    type: MXL_CONTENT_TYPE,
    lastModified: Date.now(),
  });

  emitProgress("Browser conversion complete (webmscore)", "done");
  return {
    file: mxlFile,
    convertedFromMscz: true,
    originalFilename: file.name,
    originalMsczFile: file,
  };
}
