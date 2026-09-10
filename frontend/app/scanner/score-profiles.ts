import type { ScannerScoreProfile } from "./scanner-types";

/**
 * Ready-made profiles for the shapes this scanner actually sees.
 *
 * A profile is a prior, not a constraint: it can raise findings for a reviewer and can
 * never override what was recognized. Picking the wrong one costs a few dismissible
 * annotations, which is why offering presets is safe where offering a rule would not
 * be.
 *
 * The clef lists are deliberately generous, and mirror `homr/homr/score_profile.py`'s
 * own `STRING_QUARTET` — a cello reads in bass, tenor *and* treble in ordinary
 * repertoire, and a profile that named only bass would fire on the real music it is
 * meant to help with. homr's copy is the source of truth if the two ever disagree.
 */
export const SCORE_PROFILE_SCHEMA_VERSION = "homr.score-profile.v1" as const;

export interface ScoreProfilePreset {
  id: string;
  label: string;
  description: string;
  profile: ScannerScoreProfile;
}

export const SCORE_PROFILE_PRESETS: ScoreProfilePreset[] = [
  {
    id: "string-quartet",
    label: "String quartet",
    description: "Violin I, Violin II, Viola, Cello — one staff each.",
    profile: {
      schemaVersion: SCORE_PROFILE_SCHEMA_VERSION,
      parts: [
        { stableId: "violin-1", displayName: "Violin I", likelyClefs: ["G2"] },
        { stableId: "violin-2", displayName: "Violin II", likelyClefs: ["G2"] },
        { stableId: "viola", displayName: "Viola", likelyClefs: ["C3", "G2"] },
        {
          stableId: "cello",
          displayName: "Cello",
          likelyClefs: ["F4", "C4", "G2"],
        },
      ],
    },
  },
  {
    id: "voice-and-piano",
    label: "Voice and piano",
    description: "One vocal line above a grand staff — the Lieder shape.",
    profile: {
      schemaVersion: SCORE_PROFILE_SCHEMA_VERSION,
      parts: [
        {
          stableId: "voice",
          displayName: "Voice",
          likelyClefs: ["G2", "C3", "F4"],
        },
        {
          stableId: "piano",
          displayName: "Piano",
          likelyClefs: ["G2", "F4"],
          expectedStaffCount: 2,
        },
      ],
    },
  },
  {
    id: "piano",
    label: "Piano",
    description: "A single grand staff.",
    profile: {
      schemaVersion: SCORE_PROFILE_SCHEMA_VERSION,
      parts: [
        {
          stableId: "piano",
          displayName: "Piano",
          likelyClefs: ["G2", "F4"],
          expectedStaffCount: 2,
        },
      ],
    },
  },
];

export function presetById(id: string): ScoreProfilePreset | undefined {
  return SCORE_PROFILE_PRESETS.find((preset) => preset.id === id);
}
