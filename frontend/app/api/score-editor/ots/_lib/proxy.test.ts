jest.mock("next/server", () => ({
  NextResponse: class MockNextResponse {
    status: number;
    headers: Headers;
    private readonly body: unknown;

    constructor(body: unknown, init?: { status?: number; headers?: HeadersInit }) {
      this.body = body;
      this.status = init?.status ?? 200;
      this.headers = new Headers(init?.headers);
    }

    static json(body: unknown, init?: { status?: number; headers?: HeadersInit }) {
      return new MockNextResponse(body, init);
    }

    async json() {
      return this.body;
    }

    async text() {
      if (typeof this.body === "string") {
        return this.body;
      }
      return JSON.stringify(this.body);
    }
  }
}));

jest.mock("../../../../lib/authToken", () => ({
  getApiAuthHeaders: jest.fn(),
}));

jest.mock("../../../proxy/_lib/upstream", () => ({
  getBackendApiBase: jest.fn(() => "http://backend:4000/api"),
  proxyFetch: jest.fn(),
}));

import { getApiAuthHeaders } from "../../../../lib/authToken";
import { getBackendApiBase, proxyFetch } from "../../../proxy/_lib/upstream";
import {
  buildScoreEditorOtsHeaders,
  buildScoreEditorOtsUpstreamUrl,
  proxyScoreEditorOtsJson
} from "./proxy";

const mockGetApiAuthHeaders = getApiAuthHeaders as jest.MockedFunction<typeof getApiAuthHeaders>;
const mockGetBackendApiBase = getBackendApiBase as jest.MockedFunction<typeof getBackendApiBase>;
const mockProxyFetch = proxyFetch as jest.MockedFunction<typeof proxyFetch>;

describe("score-editor ots proxy helper", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockGetApiAuthHeaders.mockResolvedValue({});
    mockGetBackendApiBase.mockReturnValue("http://backend:4000/api");
  });

  it("preserves the incoming query string when building upstream urls", () => {
    const request = {
      url: "http://localhost:3000/api/score-editor/ots/works/10/sources/s1/history?branch=feature-a&limit=25",
      headers: new Headers()
    } as unknown as Request;

    const url = buildScoreEditorOtsUpstreamUrl(request, "/works/10/sources/s1/history");

    expect(url).toBe("http://backend:4000/api/works/10/sources/s1/history?branch=feature-a&limit=25");
  });

  it("adds auth, content-type, and progress headers when requested", async () => {
    mockGetApiAuthHeaders.mockResolvedValue({ Authorization: "Bearer token-123" });
    const request = {
      url: "http://localhost:3000/api/score-editor/ots/works/10/sources/s1/revisions",
      headers: new Headers({
        "content-type": "multipart/form-data; boundary=abc",
        "x-progress-id": "progress-1"
      })
    } as unknown as Request;

    const headers = await buildScoreEditorOtsHeaders(request, {
      includeContentType: true,
      includeProgressHeader: true
    });

    expect(headers.get("content-type")).toBe("multipart/form-data; boundary=abc");
    expect(headers.get("x-progress-id")).toBe("progress-1");
    expect(headers.get("authorization")).toBe("Bearer token-123");
  });

  it("returns parsed json payloads from upstream json responses", async () => {
    mockProxyFetch.mockResolvedValue(
      {
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        text: async () => JSON.stringify({ ok: true, branch: "trunk" })
      } as unknown as Response
    );
    const request = {
      url: "http://localhost:3000/api/score-editor/ots/works/10/sources/s1/history",
      headers: new Headers()
    } as unknown as Request;

    const response = await proxyScoreEditorOtsJson(request, "/works/10/sources/s1/history");

    expect(mockProxyFetch).toHaveBeenCalledWith(
      request,
      "http://backend:4000/api/works/10/sources/s1/history",
      expect.objectContaining({ cache: "no-store" })
    );
    expect(response.status).toBe(200);
    await expect((response as any).json()).resolves.toEqual({ ok: true, branch: "trunk" });
  });
});
