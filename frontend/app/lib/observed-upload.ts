type UploadOperation =
  | "source"
  | "revision"
  | "project"
  | "reference_pdf"
  | "scanner";

export function startUploadObservation(operation: UploadOperation) {
  // This ID is only for correlation. Telemetry must not stop uploads in a
  // browser without randomUUID support (for example, an HTTP dev deployment).
  const attemptId = globalThis.crypto?.randomUUID?.() || "10000000-1000-4000-8000-100000000000".replace(/[018]/g, c =>
    (Number(c) ^ Math.floor(Math.random() * 16) >> Number(c) / 4).toString(16));
  const started = Date.now();
  return {
    attemptId,
    finish(status: number) {
      if (![0, 413, 429].includes(status)) return;
      void fetch("/api/proxy/operations/upload-observations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        keepalive: true,
        body: JSON.stringify({
          attemptId,
          operation,
          status,
          durationMs: Date.now() - started,
        }),
      }).catch(() => {
        /* Telemetry must not break the upload. */
      });
    },
  };
}

function operationFor(url: string): UploadOperation | null {
  const path = url.split("?")[0].replace("/api/proxy/", "/api/");
  if (/\/projects\/[^/]+\/sources\/?$/.test(path)) return "project";
  if (/\/works\/[^/]+\/sources\/[^/]+\/revisions\/?$/.test(path))
    return "revision";
  if (/\/works\/[^/]+\/sources\/[^/]+\/reference\.pdf\/?$/.test(path))
    return "reference_pdf";
  if (/\/works\/[^/]+\/sources\/?$/.test(path)) return "source";
  if (/\/scanner\/jobs\/?$/.test(path)) return "scanner";
  return null;
}

/** Report only transport observations, never file contents or raw error text. */
export async function observedUpload(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const operation = operationFor(String(input));
  if (
    init?.method?.toUpperCase() !== "POST" ||
    !operation ||
    typeof window === "undefined"
  )
    return init === undefined ? fetch(input) : fetch(input, init);
  const observation = startUploadObservation(operation);
  const headers = new Headers(init.headers);
  headers.set("x-upload-attempt-id", observation.attemptId);
  try {
    const response = await fetch(input, { ...init, headers });
    observation.finish(response.status);
    return response;
  } catch (error) {
    observation.finish(0);
    throw error;
  }
}
