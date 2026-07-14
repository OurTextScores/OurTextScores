import { createEditorApiProxy } from "../../_lib/editor-api-proxy";

const proxyMusicRequest = createEditorApiProxy("music");

export const GET = proxyMusicRequest;
export const POST = proxyMusicRequest;
export const PUT = proxyMusicRequest;
export const PATCH = proxyMusicRequest;
export const DELETE = proxyMusicRequest;
