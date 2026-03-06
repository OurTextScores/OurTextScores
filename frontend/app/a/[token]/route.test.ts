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

describe("short beta approval route", () => {
  it("redirects token path to the beta approval page", async () => {
    const response = await GET(
      { url: "https://www.ourtextscores.com/a/test-token" } as Request,
      { params: Promise.resolve({ token: "test-token" }) }
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "https://www.ourtextscores.com/beta-approve?token=test-token"
    );
  });
});
