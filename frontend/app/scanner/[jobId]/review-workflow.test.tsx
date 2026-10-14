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

it("starts at base review and saves a checkpoint before showing the heads editor", async () => {
  const initial = job();
  const base = job("base");
  const heads = job("heads");
  let current = initial;
  const fetchMock = jest.fn(async (_url: unknown, init?: RequestInit) => {
    if (init?.method === "POST")
      current = JSON.parse(String(init.body)).action === "start" ? base : heads;
    return respond(current);
  });
  global.fetch = fetchMock;
  render(<Host initial={initial} />);
  fireEvent.click(screen.getByRole("button", { name: "Start guided review" }));
  expect(
    await screen.findByText("Base questions for ots-homr"),
  ).toBeInTheDocument();
  expect(screen.queryByTestId("merge")).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "Save base review and continue" }),
  );
  expect(
    await screen.findByRole("button", {
      name: "Prepare additional heads merge",
    }),
  ).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/proxy/scanner/jobs/job-1/pages/1/review-workflow",
    expect.objectContaining({
      body: JSON.stringify({
        action: "complete",
        statusVersion: 7,
        workflowStateVersion: null,
      }),
    }),
  );
});

it("prepares selected heads and opens the correct fixed merge pair", async () => {
  const initial = job("heads");
  const prepared = job("heads");
  Object.assign(prepared.pages[0].engines!["ots-homr"]!, {
    selectedStructuredHeadFamilies: ["beam"],
    artifactKinds: ["selected-heads-musicxml"],
  });
  global.fetch = jest.fn(async () => respond(prepared));
  render(<Host initial={initial} />);
  expect(screen.getByRole("checkbox", { name: "Beams" })).toBeChecked();
  expect(
    screen.getByRole("checkbox", { name: "Stem direction" }),
  ).toBeChecked();
  fireEvent.click(screen.getByRole("checkbox", { name: "Stem direction" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Prepare additional heads merge" }),
  );
  expect(await screen.findByTestId("merge")).toHaveTextContent(
    "ots-homr-core versus ots-homr-selected-heads",
  );
  expect(screen.getByTestId("merge")).toHaveAttribute("data-fixed", "true");
  expect(global.fetch).toHaveBeenCalledWith(
    "/api/proxy/scanner/jobs/job-1/pages/1/engines/ots-homr/structured-output",
    expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ families: ["beam"] }),
    }),
  );
});

it("resumes the engine merge and lets the reviewer reopen an earlier step", async () => {
  const initial = job("engines");
  const base = job("base");
  global.fetch = jest.fn(async (_url, init) =>
    respond(init?.method === "POST" ? base : initial),
  );
  render(<Host initial={initial} />);
  expect(screen.getByTestId("merge")).toHaveTextContent(
    "ots-homr versus transcoda",
  );
  fireEvent.click(
    screen.getByRole("button", { name: "1. Base recognition review" }),
  );
  expect(
    await screen.findByText("Base questions for ots-homr"),
  ).toBeInTheDocument();
  expect(global.fetch).toHaveBeenCalledWith(
    "/api/proxy/scanner/jobs/job-1/pages/1/review-workflow",
    expect.objectContaining({
      body: JSON.stringify({
        action: "open",
        step: "base",
        statusVersion: 7,
        workflowStateVersion: null,
      }),
    }),
  );
});

it("keeps the current step when saving fails", async () => {
  const initial = job("base");
  global.fetch = jest.fn(async (_url, init) =>
    init?.method === "POST"
      ? ({
          ok: false,
          json: async () => ({
            message: "This scan changed. Refresh before changing steps.",
          }),
        } as Response)
      : respond(initial),
  );
  render(<Host initial={initial} />);
  fireEvent.click(
    screen.getByRole("button", { name: "Save base review and continue" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "This scan changed",
  );
  expect(screen.getByText("Base questions for ots-homr")).toBeInTheDocument();
});

it.each([
  ["base", "Skip base review"],
  ["heads", "Skip additional heads"],
  ["engines", "Skip engine merge"],
] as const)("can explicitly skip the %s stage", async (active, label) => {
  const initial = job(active);
  global.fetch = jest.fn(async () => respond(initial));
  render(<Host initial={initial} />);
  fireEvent.click(screen.getByRole("button", { name: label }));
  await waitFor(() =>
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/proxy/scanner/jobs/job-1/pages/1/review-workflow",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          action: "skip",
          statusVersion: 7,
          workflowStateVersion: null,
        }),
      }),
    ),
  );
});

it("preserves a saved subset when reopening additional heads", () => {
  const initial = job("heads");
  initial.pages[0].engines!["ots-homr"]!.selectedStructuredHeadFamilies = [
    "stem",
  ];
  render(<Host initial={initial} />);
  expect(
    screen.getByRole("checkbox", { name: "Stem direction" }),
  ).toBeChecked();
  expect(screen.getByRole("checkbox", { name: "Beams" })).not.toBeChecked();
});
