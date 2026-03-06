jest.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

const sendMail = jest.fn();
const createTransport = jest.fn(() => ({ sendMail }));
jest.mock("nodemailer", () => ({
  createTransport: (...args: unknown[]) => createTransport(...args),
}));

const updateOne = jest.fn();
const db = {
  collection: jest.fn((name: string) => {
    if (name === "beta_interest_signups") {
      return { updateOne };
    }
    throw new Error(`Unexpected collection ${name}`);
  }),
};

jest.mock("../../lib/mongo", () => ({
  __esModule: true,
  default: Promise.resolve({ db: () => db }),
}));

jest.mock("../../lib/beta-approvals", () => ({
  generateApprovalToken: jest.fn(() => "approval-token-123"),
  hashApprovalToken: jest.fn(() => "approval-hash-123"),
  getApprovalTtlHours: jest.fn(() => 72),
}));

jest.mock("../../lib/beta-invites", () => ({
  buildBetaApprovalUrl: jest.fn(() => "https://ourtextscores.test/a/approval-token-123"),
  resolveInviteBaseUrl: jest.fn(() => "https://ourtextscores.test"),
}));

import { POST } from "./route";

function makeJsonRequest(url: string, body: unknown): Request {
  return {
    url,
    json: async () => body,
  } as unknown as Request;
}

describe("beta-interest route", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    updateOne.mockResolvedValue({ acknowledged: true });
    process.env.EMAIL_SERVER = "smtp://mail.test";
    process.env.EMAIL_FROM = "OurTextScores <noreply@ourtextscores.test>";
    process.env.BETA_PREVIEW_ADMIN_EMAIL = "admin@ourtextscores.test";
  });

  it("stores approval token metadata and emails an approval link", async () => {
    const request = makeJsonRequest("https://ourtextscores.test/api/beta-interest", {
      email: "newuser@example.com",
      description: "I want to help with Bach sources.",
      tosAccepted: true,
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(updateOne).toHaveBeenCalledWith(
      { email: "newuser@example.com" },
      expect.objectContaining({
        $set: expect.objectContaining({
          adminApprovalTokenHash: "approval-hash-123",
          adminApprovalIssuedTo: "admin@ourtextscores.test",
        }),
        $unset: expect.objectContaining({
          adminApprovalUsedAt: "",
        }),
      }),
      { upsert: true }
    );
    expect(createTransport).toHaveBeenCalledWith("smtp://mail.test");
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "admin@ourtextscores.test",
        replyTo: "newuser@example.com",
        text: expect.stringContaining("https://ourtextscores.test/a/approval-token-123"),
        html: expect.stringContaining('href="https://ourtextscores.test/a/approval-token-123"'),
      })
    );
  });
});
