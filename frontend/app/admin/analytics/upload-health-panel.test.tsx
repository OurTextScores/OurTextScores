import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import UploadHealthPanel from "./upload-health-panel";

const report = {
  generatedAt: new Date().toISOString(),
  startedAt: new Date().toISOString(),
  minutes: 60,
  totals: {
    attempts: 3,
    accepted: 2,
    serverFailures: 0,
    tooLarge: 1,
    limited: 0,
    unknown: 0,
    clientObserved: 1,
    averageDurationMs: 100,
    lastEventAt: null,
  },
  health: { status: "up", incidents: [] },
  telemetry: {
    writeFailures: 0,
    retentionDays: 30,
    coverage: "Acceptance does not assert derivative completion.",
  },
  policy: { limit: 60, disabled: false, scope: "Process-local counters" },
  categories: [],
  trend: [],
  recentFailures: [],
};

describe("upload health panel", () => {
  beforeEach(() => {
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: true, json: async () => report });
  });
  it("loads operations separately from business analytics and reports unavailable data honestly", async () => {
    render(<UploadHealthPanel />);
    await screen.findByText("Accepted requests");
    expect(
      screen.getByText(/Operational traffic includes administrators/),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Window"), {
      target: { value: "15" },
    });
    await waitFor(() =>
      expect((fetch as jest.Mock).mock.calls.at(-1)[0]).toContain("minutes=15"),
    );
    (fetch as jest.Mock).mockResolvedValue({
      ok: false,
      json: async () => ({ message: "Metrics unavailable" }),
    });
    fireEvent.click(screen.getByText("Refresh upload health"));
    await screen.findByRole("alert");
    expect(screen.queryByText("Accepted requests")).not.toBeInTheDocument();
  });
  it("requires an account lookup and reason before exposing quota changes", async () => {
    render(<UploadHealthPanel />);
    await screen.findByText("Accepted requests");
    expect(screen.queryByText("Reset this account")).not.toBeInTheDocument();
    (fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({
        account: {
          email: "target@example.test",
          userId: "target",
          count: 60,
          resetAt: null,
          allowance: null,
        },
        audit: [],
      }),
    });
    fireEvent.change(screen.getByLabelText("Email or username"), {
      target: { value: "target@example.test" },
    });
    fireEvent.click(screen.getByText("Look up account"));
    await screen.findByText("Reset this account");
    expect(screen.getByText("Reset this account")).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Reason for change"), {
      target: { value: "Resume approved import" },
    });
    expect(screen.getByText("Reset this account")).not.toBeDisabled();
  });
});
