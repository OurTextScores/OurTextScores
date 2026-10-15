import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import ReviewWorkflow from "./review-workflow";
import type { ScannerJob, ScannerReviewStep } from "../scanner-types";

jest.mock("./page-review", () => ({
  __esModule: true,
  default: ({ engineId }: { engineId: string }) => (
    <div>Base questions for {engineId}</div>
  ),
}));
jest.mock("./page-comparison", () => ({
  __esModule: true,
  default: (props: {
    initialBaseEngine: string;
    initialCandidateEngine: string;
    fixedPair?: boolean;
  }) => (
    <div data-testid="merge" data-fixed={String(Boolean(props.fixedPair))}>
      {props.initialBaseEngine} versus {props.initialCandidateEngine}
    </div>
  ),
}));

function job(active?: ScannerReviewStep): ScannerJob {
  const steps = Object.fromEntries(
    ["base", "heads", "engines"].map((step) => [
      step,
      {
        available: step === "base" || active !== "base",
        saved: step === active || step === "base",
        complete: step === "base" && active !== "base",
        stale: false,
        positions: {},
      },
    ]),
  ) as NonNullable<ScannerJob["pages"][number]["reviewWorkflow"]>["steps"];
  return {
    jobId: "job-1",
    status: "succeeded",
    statusVersion: 7,
    enginePlan: {
      version: "scanner-engine-plan-v1",
      engineIds: ["ots-homr", "transcoda"],
      primaryEngineId: "ots-homr",
      fallbackEngineIds: [],
      capabilitySnapshots: {
        "ots-homr": {
          displayName: "OTS-HOMR",
          supportsSpotReview: true,
          supportsMeasureGeometry: true,
          outputArtifactKinds: [],
          unsupportedSemanticClasses: [],
        },
      },
    },
    pages: [
      {
        pageNumber: 1,
        ordinal: 1,
        status: "succeeded",
        included: true,
        attempts: 1,
        manualRetries: 0,
        rotationDegrees: 0,
        hasMusicXml: true,
        hasPdf: false,
        hasThumbnail: true,
        canRetry: false,
        engines: {
          "ots-homr": {
            status: "succeeded",
            attempts: 1,
            hasMusicXml: true,
            hasPdf: false,
            availableStructuredHeadFamilies: ["beam", "stem"],
            selectedStructuredHeadFamilies: [],
          },
          transcoda: {
            status: "succeeded",
            attempts: 1,
            hasMusicXml: true,
            hasPdf: false,
          },
        },
        reviewWorkflow: active ? { active, revision: 2, steps } : undefined,
      },
    ],
    originalFilename: "score.png",
    pageCount: 1,
    hasMusicXml: true,
    hasPdf: false,
    hasThumbnail: true,
    hasZip: false,
    canRetry: false,
    createdAt: "",
    updatedAt: "",
    resultExpiresAt: "",
  };
}
function Host({ initial }: { initial: ScannerJob }) {
  const [current, setCurrent] = useState(initial);
  return (
    <ReviewWorkflow
      job={current}
      page={current.pages[0]}
      onChange={setCurrent}
    />
  );
}
function respond(body: unknown) {
  return { ok: true, json: async () => body } as Response;
}

it("opens directly in the engine merge without base questions or a head selection step", () => {
  render(<Host initial={job()} />);
  expect(screen.getByTestId("merge")).toHaveTextContent(
    "ots-homr versus transcoda",
  );
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(screen.queryByText(/Base questions/)).toBeNull();
  expect(
    screen.queryByRole("button", { name: /Start guided review/ }),
  ).toBeNull();
});

it.each(["base", "heads"] as const)(
  "preserves legacy work when opening a scan left at %s",
  async (active) => {
    const initial = job(active);
    const engines = job("engines");
    engines.pages[0].hasMergedScore = true;
    global.fetch = jest.fn(async (_url, init) =>
      respond(init?.method === "POST" ? engines : initial),
    );
    render(<Host initial={initial} />);
    expect(await screen.findByTestId("merge")).toHaveTextContent(
      "ots-homr versus transcoda",
    );
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/proxy/scanner/jobs/job-1/pages/1/review-workflow",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          action: "engine-review",
          statusVersion: 7,
          workflowStateVersion: null,
        }),
      }),
    );
  },
);

it("resumes an existing engine merge without changing stages", () => {
  global.fetch = jest.fn();
  render(<Host initial={job("engines")} />);
  expect(screen.getByTestId("merge")).toHaveTextContent(
    "ots-homr versus transcoda",
  );
  expect(global.fetch).not.toHaveBeenCalled();
});

it("internally refreshes a concurrent version conflict before opening the engine merge", async () => {
  const initial = job("base");
  let posts = 0;
  global.fetch = jest.fn(async (_url, init) => {
    if (init?.method !== "POST") return respond(initial);
    if (++posts === 1)
      return {
        ok: false,
        status: 409,
        json: async () => ({ message: "This scan changed" }),
      } as Response;
    return respond(job("engines"));
  });
  render(<Host initial={initial} />);
  expect(await screen.findByTestId("merge")).toBeInTheDocument();
  expect(posts).toBe(2);
  expect(screen.queryByRole("alert")).toBeNull();
});
