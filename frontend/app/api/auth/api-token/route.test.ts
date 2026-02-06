import { getApiAuthHeaders } from "../../../lib/authToken";

jest.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

jest.mock("../../../lib/authToken", () => ({
  getApiAuthHeaders: jest.fn(),
}));

import { GET } from "./route";

const mockGetApiAuthHeaders = getApiAuthHeaders as jest.MockedFunction<typeof getApiAuthHeaders>;

describe("api-token route", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("returns token when Authorization header exists", async () => {
    mockGetApiAuthHeaders.mockResolvedValue({ Authorization: "Bearer abc123" });

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ token: "abc123" });
  });

  it("returns 401 when Authorization header is missing", async () => {
    mockGetApiAuthHeaders.mockResolvedValue({});

    const response = await GET();

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("returns 500 when token generation throws", async () => {
    mockGetApiAuthHeaders.mockRejectedValue(new Error("NEXTAUTH_SECRET is not configured"));

    const response = await GET();

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "Server misconfiguration" });
  });
});
