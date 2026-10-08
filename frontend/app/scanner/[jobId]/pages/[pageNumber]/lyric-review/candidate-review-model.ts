/** Text review of detector-found lyric boxes. Transcription is manual: no OCR exists yet. */

export const CANDIDATE_DECISION_SCHEMA = "ots.lyric-candidate-decisions.v1";

export type Candidate = {
  id: string;
  regionStatus: "accepted" | "review";
  reason: string;
  box: [number, number, number, number];
  rawConfidence: number;
  calibratedConfidence: number | null;
  competingText: boolean;
};

export type Inventory = {
  schemaVersion: string;
  automaticAttachment: false;
  pageNumber: number;
  raster: { checksumSha256: string; width: number; height: number };
  candidates: Candidate[];
};

export type CandidateDecision = {
  id: string;
  text: string;
  state: "pending" | "accept" | "exclude";
};

export const blankCandidate = (c: Candidate): CandidateDecision => ({
  id: c.id,
  text: "",
  state: "pending",
});

/** Editing text withdraws an acceptance; empty text can never be accepted. */
export function setText(d: CandidateDecision, text: string): CandidateDecision {
  return { ...d, text, state: d.state === "accept" ? "pending" : d.state };
}

export function setState(
  d: CandidateDecision,
  state: CandidateDecision["state"],
): CandidateDecision {
  if (state === "accept" && d.text.trim() === "") return d;
  return { ...d, state };
}

export function buildCandidateExport(
  jobId: string,
  inventory: Inventory,
  decisions: Record<string, CandidateDecision>,
) {
  return {
    schemaVersion: CANDIDATE_DECISION_SCHEMA,
    automaticAttachment: false,
    jobId,
    pageNumber: inventory.pageNumber,
    raster: inventory.raster,
    decisions: inventory.candidates.map((c) => ({
      ...(decisions[c.id] ?? blankCandidate(c)),
      box: c.box,
    })),
  };
}
