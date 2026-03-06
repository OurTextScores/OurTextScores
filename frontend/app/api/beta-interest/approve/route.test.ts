jest.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

const issueBetaInvite = jest.fn();
jest.mock("../../../lib/beta-invite-service", () => ({
  issueBetaInvite: (...args: unknown[]) => issueBetaInvite(...args),
}));

jest.mock("../../../lib/beta-approvals", () => ({
  hashApprovalToken: jest.fn(() => "approval-hash-123"),
}));

const findOne = jest.fn();
const updateOne = jest.fn();
const db = {
  collection: jest.fn((name: string) => {
    if (name === "beta_interest_signups") {
      return { findOne, updateOne };
    }
    throw new Error(`Unexpected collection ${name}`);
  }),
};

jest.mock("../../../lib/mongo", () => ({
  __esModule: true,
  default: Promise.resolve({ db: () => db }),
}));

import { GET, POST } from "./route";

function makeRequest(url: string, body?: unknown): Request {
  return {
    url,
    json: async () => body,
    headers: {
      get: () => null,
    },
  } as unknown as Request;
}

describe("beta-interest approve route", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.EMAIL_SERVER = "smtp://mail.test";
    process.env.EMAIL_FROM = "OurTextScores <noreply@ourtextscores.test>";
  });

  it("GET previews a pending approval without sending an invite", async () => {
    findOne.mockResolvedValue({
      _id: "signup-1",
      email: "pending@example.com",
      description: "Working on editorial cleanups.",
      createdAt: new Date("2026-03-01T12:00:00Z"),
      adminApprovalExpiresAt: new Date("2026-03-04T12:00:00Z"),
    });

    const response = await GET(makeRequest("https://ourtextscores.test/api/beta-interest/approve?token=approval-token-123"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      email: "pending@example.com",
      description: "Working on editorial cleanups.",
      createdAt: "2026-03-01T12:00:00.000Z",
      expiresAt: "2026-03-04T12:00:00.000Z",
    });
    expect(issueBetaInvite).not.toHaveBeenCalled();
  });

  it("POST claims the approval token and issues the existing beta invite", async () => {
    findOne.mockResolvedValue({
      _id: "signup-1",
      email: "pending@example.com",
      description: "Working on editorial cleanups.",
      adminApprovalIssuedTo: "admin@ourtextscores.test",
    });
    updateOne.mockResolvedValueOnce({ modifiedCount: 1 }).mockResolvedValueOnce({ modifiedCount: 1 });
    issueBetaInvite.mockResolvedValue({
      email: "pending@example.com",
      expiresAt: "2026-03-10T12:00:00.000Z",
    });

    const response = await POST(
      makeRequest("https://ourtextscores.test/api/beta-interest/approve", { token: "approval-token-123" })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      email: "pending@example.com",
      expiresAt: "2026-03-10T12:00:00.000Z",
    });
    expect(issueBetaInvite).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "pending@example.com",
        actorLabel: "admin@ourtextscores.test",
        emailServer: "smtp://mail.test",
      })
    );
    expect(updateOne).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ _id: "signup-1" }),
      expect.objectContaining({
        $set: expect.objectContaining({ adminApprovalClaimedAt: expect.any(Date) }),
      })
    );
    expect(updateOne).toHaveBeenNthCalledWith(
      2,
      { _id: "signup-1" },
      expect.objectContaining({
        $set: expect.objectContaining({
          approvedBy: "admin@ourtextscores.test",
        }),
      })
    );
  });
});
