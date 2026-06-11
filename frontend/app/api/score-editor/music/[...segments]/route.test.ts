const originalScoreEditorApiOrigin = process.env.SCORE_EDITOR_API_ORIGIN;
const originalFetch = global.fetch;
const originalResponse = global.Response;

describe("score-editor music proxy route", () => {
  beforeEach(() => {
    process.env.SCORE_EDITOR_API_ORIGIN = "http://score-editor-api:3000";
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
    global.fetch = originalFetch;
    global.Response = originalResponse;
  });

  it("proxies POST bodies and query strings through a route handler", async () => {
    const upstreamResponse = {
      body: JSON.stringify({ ok: true }),
      status: 200,
      statusText: "OK",
      headers: new Headers({ "content-type": "application/json" })
    } as unknown as Response;
    (global.fetch as jest.Mock).mockResolvedValue(upstreamResponse);

    const { POST } = await import("./route");
    const body = Uint8Array.from([1, 2, 3]).buffer;
    const request = {
      url: "http://localhost:3000/api/score-editor/music/omr/transcribe?mode=beam",
      method: "POST",
      headers: new Headers({
        "content-type": "application/json",
        host: "localhost:3000"
      }),
      arrayBuffer: async () => body
    } as unknown as Request;
    const response = await POST(request, { params: { segments: ["omr", "transcribe"] } });

    expect(global.fetch).toHaveBeenCalledWith(
      "http://score-editor-api:3000/api/music/omr/transcribe?mode=beam",
      expect.objectContaining({
        method: "POST",
        body: expect.any(ArrayBuffer),
        cache: "no-store",
        redirect: "manual"
      })
    );
    const upstreamHeaders = (global.fetch as jest.Mock).mock.calls[0][1].headers as Headers;
    expect(upstreamHeaders.get("content-type")).toBe("application/json");
    expect(upstreamHeaders.has("host")).toBe(false);
    expect(await response.json()).toEqual({ ok: true });
  });
});
