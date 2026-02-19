jest.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

import { POST } from "./route";

describe("POST /api/llm/gemini/models", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    process.env.GEMINI_API_KEY = "";
    (global as any).fetch = jest.fn();
  });

  it("returns 400 when API key is missing", async () => {
    const req = {
      json: async () => ({}),
    } as unknown as Request;

    const response = await POST(req);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Missing Gemini API key." });
  });

  it("returns upstream models response", async () => {
    process.env.GEMINI_API_KEY = "env-key";
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      text: async () =>
        JSON.stringify({
          models: [{ name: "models/gemini-3-pro-preview" }],
        }),
    });

    const req = {
      json: async () => ({}),
    } as unknown as Request;

    const response = await POST(req);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect((global.fetch as jest.Mock).mock.calls[0][0]).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models",
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      models: [{ name: "models/gemini-3-pro-preview" }],
    });
  });

  it("bubbles upstream status on failure", async () => {
    process.env.GEMINI_API_KEY = "env-key";
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

