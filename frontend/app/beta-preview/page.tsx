import { redirect } from "next/navigation";

export const metadata = {
  title: "Beta Preview | OurTextScores",
  description: "OurTextScores is currently in beta preview. Request access."
};

export default function BetaPreviewPage({
  searchParams
}: {
  searchParams?: Record<string, string | string[] | undefined>;
}) {
  const initialNext = typeof searchParams?.next === "string" ? searchParams.next : "";
  redirect(`/signin${initialNext ? `?next=${encodeURIComponent(initialNext)}` : ""}`);
}
