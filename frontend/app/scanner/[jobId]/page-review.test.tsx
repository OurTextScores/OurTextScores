import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import PageReview from "./page-review";

function review(overrides: Record<string, unknown> = {}) {
  return {
    pageNumber: 3,
    spots: [
      {
        id: 0,
        head: "pitch",
        chosen: "C4",
        confidence: 0.41,
        alternatives: [
          { value: "D4", confidence: 0.39 },
          { value: "B3", confidence: 0.1 },
        ],
      },
      {
        id: 1,
        head: "rhythm",
        chosen: "note_8",
        confidence: 0.62,
        alternatives: [{ value: "note_16", confidence: 0.3 }],
      },
    ],
    remainingFloor: 0.41,
    suitability: { symbols: 40, spots: 2, askableRatio: 0.05, unsuitable: false },
    ...overrides,
  };
}

function mockReview(body: unknown) {
  global.fetch = jest.fn(
    async () => ({ ok: true, json: async () => body }) as Response,
  );
}

describe("PageReview", () => {
  it("opens on the least certain spot and shows the alternatives", async () => {
    mockReview(review());
    render(<PageReview jobId="job-1" pageNumber={3} />);
    expect(await screen.findByText("Which note is this?")).toBeInTheDocument();
    expect(screen.getByText("C4")).toBeInTheDocument();
    expect(screen.getByText(/41% — what the scanner chose/)).toBeInTheDocument();
    expect(screen.getByText("D4")).toBeInTheDocument();
  });

  it("tells the reviewer how good the remainder is", async () => {
    // The number that makes stopping a judgement rather than fatigue.
    mockReview(review());
    render(<PageReview jobId="job-1" pageNumber={3} />);
    expect(
      await screen.findByText(/1 more after this, all at least 62% confident/),
    ).toBeInTheDocument();
  });

  it("moves through the queue and ends honestly", async () => {
    mockReview(review());
    render(<PageReview jobId="job-1" pageNumber={3} />);
    fireEvent.click(await screen.findByRole("button", { name: "Next" }));
    expect(await screen.findByText("Which duration is this?")).toBeInTheDocument();
    expect(screen.getByText(/This is the last one flagged/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(
      await screen.findByText(/That is everything flagged on this page/),
    ).toBeInTheDocument();
  });

  it("says nothing was uncertain rather than showing an empty queue", async () => {
    mockReview(review({ spots: [], remainingFloor: null }));
    render(<PageReview jobId="job-1" pageNumber={3} />);
    expect(
      await screen.findByText(/Nothing on this page looked uncertain/),
    ).toBeInTheDocument();
  });

  it("warns when the page is past reliable recognition, without hiding the queue", async () => {
    // Presenting hundreds of questions with no comment implies the page is
    // nearly right. The queue stays available: a signal, never a gate.
    mockReview(
      review({
        suitability: { symbols: 899, spots: 621, askableRatio: 0.69, unsuitable: true },
      }),
    );
    render(<PageReview jobId="job-1" pageNumber={3} />);
    expect(await screen.findByText(/past what automatic recognition can do/)).toBeInTheDocument();
    expect(screen.getByText("Which note is this?")).toBeInTheDocument();
  });

  it("expands to the whole page and back", async () => {
    mockReview(review());
    render(<PageReview jobId="job-1" pageNumber={3} />);
    const image = await screen.findByRole("img");
    expect(image).toHaveAttribute("src", expect.stringContaining("level=staff"));
    fireEvent.click(screen.getByRole("button", { name: "Show the whole page" }));
    await waitFor(() =>
      expect(screen.getByRole("img")).toHaveAttribute(
        "src",
        expect.stringContaining("level=page"),
      ),
    );
  });

  it("returns to the staff view when moving to the next spot", async () => {
    // The previous spot's zoom says nothing about the next one.
    mockReview(review());
    render(<PageReview jobId="job-1" pageNumber={3} />);
    fireEvent.click(await screen.findByRole("button", { name: "Show the whole page" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() =>
      expect(screen.getByRole("img")).toHaveAttribute(
        "src",
        expect.stringContaining("level=staff"),
      ),
    );
  });
});
