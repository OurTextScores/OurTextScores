const originalScoreEditorApiOrigin = process.env.SCORE_EDITOR_API_ORIGIN;
const originalScoreEditorApiToken = process.env.SCORE_EDITOR_API_TOKEN;
const originalFetch = global.fetch;
const originalResponse = global.Response;

describe("score-editor llm proxy route", () => {
  beforeEach(() => {
    process.env.SCORE_EDITOR_API_ORIGIN = "http://score-editor-api:3000";
    delete process.env.SCORE_EDITOR_API_TOKEN;
    global.fetch = jest.fn();
    global.Response = class MockResponse {
      status: number;
      statusText: string;
      headers: Headers;
      body: unknown;

      constructor(body?: BodyInit | null, init?: ResponseInit) {
        this.status = init?.status ?? 200;
        this.statusText = init?.statusText ?? "";
        this.headers = new Headers(init?.headers);
        this.body = body;
      }

      async json() {
        return JSON.parse(String(this.body));
      }
    } as unknown as typeof Response;
  });

  afterAll(() => {
    process.env.SCORE_EDITOR_API_ORIGIN = originalScoreEditorApiOrigin;
    process.env.SCORE_EDITOR_API_TOKEN = originalScoreEditorApiToken;
    global.fetch = originalFetch;
    global.Response = originalResponse;
  });

  const makeRequest = (headers: Record<string, string> = {}) =>
    ({
      url: "http://localhost:3000/api/score-editor/llm/openai/models?x=1",
      method: "POST",
      headers: new Headers({ "content-type": "application/json", ...headers }),
      arrayBuffer: async () => Uint8Array.from([1]).buffer
    } as unknown as Request);

  const mockUpstreamOk = () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      body: JSON.stringify({ ok: true }),
      status: 200,
      statusText: "OK",
      headers: new Headers({ "content-type": "application/json" })
    } as unknown as Response);
  };

  const forwardedHeaders = () =>
    (global.fetch as jest.Mock).mock.calls[0][1].headers as Headers;

  it("proxies to the editor API /api/llm/* preserving the query string", async () => {
    mockUpstreamOk();
    const { POST } = await import("./route");
    const response = await POST(makeRequest(), { params: { segments: ["openai", "models"] } });
    expect(global.fetch).toHaveBeenCalledWith(
      "http://score-editor-api:3000/api/llm/openai/models?x=1",
      expect.objectContaining({ method: "POST", cache: "no-store", redirect: "manual" })
    );
    expect(forwardedHeaders().has("host")).toBe(false);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("injects the configured app token and strips client-supplied token headers", async () => {
    process.env.SCORE_EDITOR_API_TOKEN = "shared-secret";
    mockUpstreamOk();
    const { POST } = await import("./route");
    await POST(
      makeRequest({ "x-ots-api-token": "attacker", "x-music-api-token": "attacker" }),
      { params: { segments: ["openai", "models"] } }
    );
    const headers = forwardedHeaders();
    expect(headers.get("x-ots-api-token")).toBe("shared-secret");
    expect(headers.has("x-music-api-token")).toBe(false);
  });

  it("forwards no token and drops client-supplied tokens when none is configured", async () => {
    mockUpstreamOk();
    const { POST } = await import("./route");
    await POST(
      makeRequest({ "x-ots-api-token": "attacker" }),
      { params: { segments: ["openai", "models"] } }
    );
    const headers = forwardedHeaders();
    expect(headers.has("x-ots-api-token")).toBe(false);
    expect(headers.has("x-music-api-token")).toBe(false);
  });
});
