import type { Metadata } from "next";
import PlayerClient from "./player-client";

export const metadata: Metadata = {
  title: "Score Player | OurTextScores",
  description: "Open and play a public score URL or a score file from your device.",
};

export default function PlayerPage({
  searchParams,
}: {
  searchParams?: { score?: string | string[] };
}) {
  const requestedScore = Array.isArray(searchParams?.score)
    ? searchParams.score[0]
    : searchParams?.score;

  return <PlayerClient initialScoreUrl={requestedScore ?? ""} />;
}
