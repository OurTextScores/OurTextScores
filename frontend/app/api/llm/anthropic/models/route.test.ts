jest.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

import { POST } from "./route";

describe("POST /api/llm/anthropic/models", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    process.env.ANTHROPIC_API_KEY = "";
    (global as any).fetch = jest.fn();
  });

  it("returns 400 when API key is missing", async () => {
    const req = {
      json: async () => ({}),
    } as unknown as Request;

    const response = await POST(req);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Missing Anthropic API key." });
  });

  it("returns upstream models response", async () => {
    process.env.ANTHROPIC_API_KEY = "env-key";
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      text: async () =>
        JSON.stringify({
          data: [{ id: "claude-opus-4-5" }],
        }),
    });

    const req = {
      json: async () => ({}),
    } as unknown as Request;

    const response = await POST(req);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect((global.fetch as jest.Mock).mock.calls[0][0]).toBe("https://api.anthropic.com/v1/models");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: [{ id: "claude-opus-4-5" }] });
  });

  it("bubbles upstream status on failure", async () => {
    process.env.ANTHROPIC_API_KEY = "env-key";
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "unauthorized",
    });

    const req = {
      json: async () => ({}),
    } as unknown as Request;

    const response = await POST(req);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
  });
});
