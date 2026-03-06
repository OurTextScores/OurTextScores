jest.mock("next/server", () => ({
  NextResponse: {
    redirect: (url: URL, status?: number) => ({
      status: status ?? 307,
      headers: {
        get: (name: string) => (name.toLowerCase() === "location" ? url.toString() : null),
      },
    }),
  },
}));

import { GET } from "./route";

describe("short beta invite route", () => {
  it("redirects token path to the beta invite page", async () => {
    const response = await GET(
      { url: "https://www.ourtextscores.com/i/test-token" } as Request,
      { params: Promise.resolve({ token: "test-token" }) }
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "https://www.ourtextscores.com/beta-invite?token=test-token"
    );
  });
});
