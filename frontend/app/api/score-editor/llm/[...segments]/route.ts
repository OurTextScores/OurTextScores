import { createEditorApiProxy } from "../../_lib/editor-api-proxy";

// Token-injecting proxy for the editor API LLM routes (/api/llm/*). Replaces the
// former next.config rewrite, which could not attach the app auth token — the
// editor API is publicly reachable, so the LLM proxy must not be an open relay.
const proxyLlmRequest = createEditorApiProxy("llm");

export const GET = proxyLlmRequest;
export const POST = proxyLlmRequest;
export const PUT = proxyLlmRequest;
export const PATCH = proxyLlmRequest;
export const DELETE = proxyLlmRequest;
