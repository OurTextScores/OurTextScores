import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import PageReview, { mergeOptions } from "./page-review";

function review(overrides: Record<string, unknown> = {}) {
  return {
    pageNumber: 3,
    engineId: "homr",
    contentSignature: "scanner-engine-review-v1:before",
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
    fireEvent.click(await screen.findByRole("button", { name: "Skip" }));
    expect(await screen.findByText("Which duration is this?")).toBeInTheDocument();
    expect(screen.getByText(/This is the last one flagged/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
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

  it("expands to the neighbouring staves and back", async () => {
    mockReview(review());
    render(<PageReview jobId="job-1" pageNumber={3} />);
    const image = await screen.findByRole("img");
    expect(image).toHaveAttribute("src", expect.stringContaining("level=staff"));
    expect(image).toHaveAttribute("src", expect.stringContaining("engineId=homr"));
    expect(image).toHaveAttribute(
      "src",
      expect.stringContaining("contentSignature=scanner-engine-review-v1%3Abefore"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Show the staves around it" }));
    await waitFor(() =>
      expect(screen.getByRole("img")).toHaveAttribute(
        "src",
        expect.stringContaining("level=context"),
      ),
    );
  });

  it("keeps the highlight when expanded", async () => {
    // The context crop grows only vertically, so the band's horizontal
    // position is still correct — and without it the expanded view would be
    // exactly as unanswerable as the whole page was.
    mockReview(review());
    const { container } = render(<PageReview jobId="job-1" pageNumber={3} />);
    fireEvent.click(await screen.findByRole("button", { name: "Show the staves around it" }));
    await waitFor(() =>
      expect(screen.getByRole("img")).toHaveAttribute(
        "src",
        expect.stringContaining("level=context"),
      ),
    );
    const overlay = container.querySelector('[aria-hidden="true"].absolute') as HTMLElement;
    expect(overlay).not.toBeNull();
    expect(overlay.style.left).toBe("47%");
  });

  it("returns to the staff view when moving to the next spot", async () => {
    // The previous spot's zoom says nothing about the next one.
    mockReview(review());
    render(<PageReview jobId="job-1" pageNumber={3} />);
    fireEvent.click(await screen.findByRole("button", { name: "Show the staves around it" }));
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
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
    expect(screen.getByText("dotted eighth note")).toBeInTheDocument();
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
        return {
          ok: true,
          json: async () => ({ ok: true, contentSignature: "scanner-engine-review-v1:after" }),
        } as Response;
      }
      return { ok: true, json: async () => review() } as Response;
    }) as any;

    render(<PageReview jobId="job-1" pageNumber={3} />);
    fireEvent.click(await screen.findByRole("button", { name: /D4\s+39%/ }));
    await waitFor(() =>
      expect(calls).toEqual([
        {
          spotId: 0,
          chosen: "D4",
          engineId: "homr",
          contentSignature: "scanner-engine-review-v1:before",
        },
      ]),
    );
    expect(await screen.findByText("Which duration is this?")).toBeInTheDocument();
  });

  it("confirming the recognised value is recorded too", async () => {
    // A confirmation of a low-confidence prediction says the model was right
    // but unsure, which is exactly what improves calibration.
    const calls: any[] = [];
    global.fetch = jest.fn(async (url: any, init: any) => {
      if (init?.method === "POST") {
        calls.push(JSON.parse(init.body));
        return {
          ok: true,
          json: async () => ({ ok: true, contentSignature: "scanner-engine-review-v1:after" }),
        } as Response;
      }
      return { ok: true, json: async () => review() } as Response;
    }) as any;

    render(<PageReview jobId="job-1" pageNumber={3} />);
    fireEvent.click(await screen.findByRole("button", { name: /what the scanner chose/ }));
    await waitFor(() =>
      expect(calls).toEqual([
        {
          spotId: 0,
          chosen: "C4",
          engineId: "homr",
          contentSignature: "scanner-engine-review-v1:before",
        },
      ]),
    );
  });

  it("uses the refreshed content signature for the next decision", async () => {
    const calls: any[] = [];
    global.fetch = jest.fn(async (_url: any, init: any) => {
      if (init?.method === "POST") {
        calls.push(JSON.parse(init.body));
        return {
          ok: true,
          json: async () => ({
            ok: true,
            contentSignature: `scanner-engine-review-v1:after-${calls.length}`,
          }),
        } as Response;
      }
      return { ok: true, json: async () => review() } as Response;
    }) as any;

    render(<PageReview jobId="job-1" pageNumber={3} />);
    fireEvent.click(await screen.findByRole("button", { name: /D4\s+39%/ }));
    fireEvent.click(await screen.findByRole("button", { name: /sixteenth note/ }));

    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]).toMatchObject({
      spotId: 1,
      engineId: "homr",
      contentSignature: "scanner-engine-review-v1:after-1",
    });
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

  it("refreshes the review when another change invalidates its signature", async () => {
    let gets = 0;
    global.fetch = jest.fn(async (_url: any, init: any) => {
      if (init?.method === "POST") return { ok: false, status: 409 } as Response;
      gets += 1;
      return {
        ok: true,
        json: async () =>
          review({ contentSignature: `scanner-engine-review-v1:version-${gets}` }),
      } as Response;
    }) as any;

    render(<PageReview jobId="job-1" pageNumber={3} />);
    fireEvent.click(await screen.findByRole("button", { name: /D4\s+39%/ }));

    expect(await screen.findByText(/page changed while you were reviewing/)).toBeInTheDocument();
    expect(screen.getByRole("img")).toHaveAttribute(
      "src",
      expect.stringContaining("contentSignature=scanner-engine-review-v1%3Aversion-2"),
    );
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

  it("asks what a symbol is when the options are not all durations", async () => {
    // The `rhythm` head is really "what symbol is this": its vocabulary holds
    // bar lines and clefs alongside durations, so "which duration is this?"
    // over a list containing a clef is incoherent.
    mockReview(
      review({
        spots: [
          {
            id: 0,
            head: "rhythm",
            chosen: "note_16",
            confidence: 0.47,
            alternatives: [
              { value: "barline", confidence: 0.22 },
              { value: "clef_F4", confidence: 0.04 },
              { value: "chord", confidence: 0.02 },
            ],
            band: { start: 0.4, end: 0.44, basis: "note" },
          },
        ],
      }),
    );
    render(<PageReview jobId="job-1" pageNumber={3} />);
    expect(await screen.findByText("What is this symbol?")).toBeInTheDocument();
    expect(screen.getByText("a barline")).toBeInTheDocument();
    expect(screen.getByText("bass clef")).toBeInTheDocument();
    expect(screen.getByText("part of a chord")).toBeInTheDocument();
  });

  it("keeps the duration wording when every option is a duration", async () => {
    mockReview(
      review({
        spots: [
          {
            id: 0,
            head: "rhythm",
            chosen: "note_16",
            confidence: 0.47,
            alternatives: [{ value: "note_8", confidence: 0.3 }],
            band: { start: 0.4, end: 0.44, basis: "note" },
          },
        ],
      }),
    );
    render(<PageReview jobId="job-1" pageNumber={3} />);
    expect(await screen.findByText("Which duration is this?")).toBeInTheDocument();
  });

  it("can go back to fix an earlier answer", async () => {
    // A choice commits the moment it is clicked, so without this a misclick is
    // only fixable by re-reviewing the whole page.
    mockReview(review());
    render(<PageReview jobId="job-1" pageNumber={3} />);
    fireEvent.click(await screen.findByRole("button", { name: "Skip" }));
    expect(await screen.findByText("Which duration is this?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(await screen.findByText("Which note is this?")).toBeInTheDocument();
  });

  it("cannot go back past the first spot", async () => {
    mockReview(review());
    render(<PageReview jobId="job-1" pageNumber={3} />);
    expect(await screen.findByRole("button", { name: "Previous" })).toBeDisabled();
  });

  it("skips the rest and still offers a way back", async () => {
    // Stopping early is a normal ending, not a dead end.
    mockReview(review());
    render(<PageReview jobId="job-1" pageNumber={3} />);
    fireEvent.click(await screen.findByRole("button", { name: "Skip remaining" }));
    expect(await screen.findByText(/everything flagged on this page/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back to the last one" }));
    expect(await screen.findByText("Which duration is this?")).toBeInTheDocument();
  });

  it("does not offer the same answer twice", async () => {
    // HOMR has two placeholders, `.` and `_`, and for a pitch both mean no
    // note — so the reviewer was asked to choose between two things they
    // cannot tell apart.
    mockReview(
      review({
        spots: [
          {
            id: 0,
            head: "pitch",
            chosen: "C4",
            confidence: 0.45,
            alternatives: [
              { value: ".", confidence: 0.31 },
              { value: "_", confidence: 0.12 },
            ],
            band: { start: 0.4, end: 0.44, basis: "note" },
          },
        ],
      }),
    );
    render(<PageReview jobId="job-1" pageNumber={3} />);
    await screen.findByText("Which note is this?");
    expect(screen.getAllByText("nothing here")).toHaveLength(1);
    // Mutually exclusive outcomes meaning the same thing: 31 + 12.
    expect(screen.getByText(/43%/)).toBeInTheDocument();
  });

  it("submits a value the model actually offered when options merge", async () => {
    const calls: any[] = [];
    global.fetch = jest.fn(async (url: any, init: any) => {
      if (init?.method === "POST") {
        calls.push(JSON.parse(init.body));
        return {
          ok: true,
          json: async () => ({ ok: true, contentSignature: "scanner-engine-review-v1:after" }),
        } as Response;
      }
      return {
        ok: true,
        json: async () =>
          review({
            spots: [
              {
                id: 0,
                head: "pitch",
                chosen: "C4",
                confidence: 0.45,
                alternatives: [
                  { value: ".", confidence: 0.31 },
                  { value: "_", confidence: 0.12 },
                ],
                band: null,
              },
            ],
          }),
      } as Response;
    }) as any;

    render(<PageReview jobId="job-1" pageNumber={3} />);
    fireEvent.click(await screen.findByRole("button", { name: /nothing here/ }));
    // The higher-confidence member of the merged pair.
    await waitFor(() =>
      expect(calls).toEqual([
        {
          spotId: 0,
          chosen: ".",
          engineId: "homr",
          contentSignature: "scanner-engine-review-v1:before",
        },
      ]),
    );
  });
});

describe("mergeOptions", () => {
  it("keeps distinct answers separate", () => {
    const merged = mergeOptions([
      { value: "C4", label: "C4", confidence: 0.5, recognised: true },
      { value: "D4", label: "D4", confidence: 0.3, recognised: false },
    ]);
    expect(merged).toHaveLength(2);
  });

  it("carries the recognised marker onto the merged entry", () => {
    const merged = mergeOptions([
      { value: ".", label: "nothing here", confidence: 0.3, recognised: true },
      { value: "_", label: "nothing here", confidence: 0.4, recognised: false },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].recognised).toBe(true);
    // Submits the likelier token, not the one that happened to be chosen.
    expect(merged[0].value).toBe("_");
    expect(merged[0].confidence).toBeCloseTo(0.7);
  });

  it("re-sorts so the likeliest answer leads", () => {
    const merged = mergeOptions([
      { value: "C4", label: "C4", confidence: 0.4, recognised: true },
      { value: ".", label: "nothing here", confidence: 0.31, recognised: false },
      { value: "_", label: "nothing here", confidence: 0.2, recognised: false },
    ]);
    expect(merged[0].label).toBe("nothing here");
  });
});
