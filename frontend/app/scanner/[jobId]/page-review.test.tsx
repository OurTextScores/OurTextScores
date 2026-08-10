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
        band: { start: 0.47, end: 0.52, basis: "note" },
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

  it("shows music, not the model's vocabulary", async () => {
    // Raw tokens ask the reviewer to interpret HOMR's alphabet rather than the
    // notation in front of them.
    mockReview(
      review({
        spots: [
          {
            id: 0,
            head: "rhythm",
            chosen: "note_16",
            confidence: 0.4,
            alternatives: [{ value: "note_8.", confidence: 0.35 }],
          },
        ],
      }),
    );
    render(<PageReview jobId="job-1" pageNumber={3} />);
    expect(await screen.findByText("sixteenth note")).toBeInTheDocument();
    expect(screen.getByText("eighth note dotted")).toBeInTheDocument();
  });

  it("renders a placeholder as an absence", async () => {
    mockReview(
      review({
        spots: [
          {
            id: 0,
            head: "slur",
            chosen: ".",
            confidence: 0.39,
            alternatives: [{ value: "slurStart", confidence: 0.31 }],
          },
        ],
      }),
    );
    render(<PageReview jobId="job-1" pageNumber={3} />);
    expect(await screen.findByText("none")).toBeInTheDocument();
    expect(screen.getByText("a slur starts here")).toBeInTheDocument();
  });

  it("records the choice and moves on", async () => {
    const calls: any[] = [];
    global.fetch = jest.fn(async (url: any, init: any) => {
      if (init?.method === "POST") {
        calls.push(JSON.parse(init.body));
        return { ok: true, json: async () => ({ ok: true }) } as Response;
      }
      return { ok: true, json: async () => review() } as Response;
    }) as any;

    render(<PageReview jobId="job-1" pageNumber={3} />);
    fireEvent.click(await screen.findByRole("button", { name: /D4\s+39%/ }));
    await waitFor(() => expect(calls).toEqual([{ spotId: 0, chosen: "D4" }]));
    expect(await screen.findByText("Which duration is this?")).toBeInTheDocument();
  });

  it("confirming the recognised value is recorded too", async () => {
    // A confirmation of a low-confidence prediction says the model was right
    // but unsure, which is exactly what improves calibration.
    const calls: any[] = [];
    global.fetch = jest.fn(async (url: any, init: any) => {
      if (init?.method === "POST") {
        calls.push(JSON.parse(init.body));
        return { ok: true, json: async () => ({ ok: true }) } as Response;
      }
      return { ok: true, json: async () => review() } as Response;
    }) as any;

    render(<PageReview jobId="job-1" pageNumber={3} />);
    fireEvent.click(await screen.findByRole("button", { name: /what the scanner chose/ }));
    await waitFor(() => expect(calls).toEqual([{ spotId: 0, chosen: "C4" }]));
  });

  it("keeps the reviewer on the spot when saving fails", async () => {
    // Advancing silently would lose the decision without saying so.
    global.fetch = jest.fn(async (url: any, init: any) => {
      if (init?.method === "POST") return { ok: false } as Response;
      return { ok: true, json: async () => review() } as Response;
    }) as any;

    render(<PageReview jobId="job-1" pageNumber={3} />);
    fireEvent.click(await screen.findByRole("button", { name: /D4\s+39%/ }));
    expect(await screen.findByText(/could not be saved/)).toBeInTheDocument();
    expect(screen.getByText("Which note is this?")).toBeInTheDocument();
  });

  it("points at the symbol rather than the whole line", async () => {
    // A staff crop can hold thirty notes; "which duration is this?" over all of
    // them is unanswerable.
    mockReview(review());
    const { container } = render(<PageReview jobId="job-1" pageNumber={3} />);
    await screen.findByText("Which note is this?");
    const overlay = container.querySelector('[aria-hidden="true"].absolute') as HTMLElement;
    expect(overlay).not.toBeNull();
    expect(overlay.style.left).toBe("47%");
    expect(screen.getByText(/Highlighted: this symbol/)).toBeInTheDocument();
  });

  it("does not draw the band over the whole page", async () => {
    // The band is a fraction of the staff's width and means nothing against
    // the full page.
    mockReview(review());
    const { container } = render(<PageReview jobId="job-1" pageNumber={3} />);
    fireEvent.click(await screen.findByRole("button", { name: "Show the whole page" }));
    await waitFor(() =>
      expect(container.querySelector('[aria-hidden="true"].absolute')).toBeNull(),
    );
  });

  it("says when the position is only approximate", async () => {
    mockReview(
      review({
        spots: [
          {
            id: 0,
            head: "rhythm",
            chosen: "note_8",
            confidence: 0.5,
            alternatives: [{ value: "note_16", confidence: 0.4 }],
            band: { start: 0.4, end: 0.56, basis: "position" },
          },
        ],
      }),
    );
    render(<PageReview jobId="job-1" pageNumber={3} />);
    expect(await screen.findByText(/roughly where it falls/)).toBeInTheDocument();
  });

  it("says when it could only narrow to the measure", async () => {
    // The attention point failed its scan-order check, so the claim is weaker
    // and the caption has to match.
    mockReview(
      review({
        spots: [
          {
            id: 0,
            head: "rhythm",
            chosen: "note_8",
            confidence: 0.5,
            alternatives: [{ value: "note_16", confidence: 0.4 }],
            band: { start: 0.25, end: 0.5, basis: "measure" },
          },
        ],
      }),
    );
    render(<PageReview jobId="job-1" pageNumber={3} />);
    expect(await screen.findByText(/the measure it is in/)).toBeInTheDocument();
  });
});
