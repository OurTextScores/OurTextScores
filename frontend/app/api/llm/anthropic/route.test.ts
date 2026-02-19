jest.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

import { POST } from "./route";

describe("POST /api/llm/anthropic", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    process.env.ANTHROPIC_API_KEY = "";
    (global as any).fetch = jest.fn();
  });

  it("returns 400 when API key is missing", async () => {
    const req = {
      json: async () => ({ promptText: "Hello" }),
    } as unknown as Request;

    const response = await POST(req);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Missing Anthropic API key." });
  });

  it("forwards chat request and returns extracted text", async () => {
    process.env.ANTHROPIC_API_KEY = "env-key";
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      text: async () =>
        JSON.stringify({
          content: [{ type: "text", text: "Patch payload" }],
        }),
    });

    const req = {
      json: async () => ({
        model: "claude-opus-4-5",
        promptText: "Return patch",
      }),
    } as unknown as Request;

    const response = await POST(req);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect((global.fetch as jest.Mock).mock.calls[0][0]).toBe("https://api.anthropic.com/v1/messages");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ text: "Patch payload" });
  });

  it("bubbles upstream status and body on failure", async () => {
    process.env.ANTHROPIC_API_KEY = "env-key";
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => "rate_limited",
    });

    const req = {
      json: async () => ({ promptText: "Return patch" }),
    } as unknown as Request;

    const response = await POST(req);

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({ error: "rate_limited" });
  });
});
