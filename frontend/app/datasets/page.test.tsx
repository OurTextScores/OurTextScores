import React from "react";
import { render, screen, within } from "@testing-library/react";

import DatasetsPage from "./page";
import corpora from "./corpora.json";

describe("Datasets page", () => {
  it("offers versioned source and public archive links without requiring sign-in", () => {
    render(<DatasetsPage />);
    expect(screen.getByRole("heading", { level: 1, name: "Datasets" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "v11 recipe" })).toHaveAttribute(
      "href",
      expect.stringMatching(/^https:\/\/github\.com\/OurTextScores\/homr\/tree\/[a-f0-9]{40}\/release\/V11_RECIPE\.md$/),
    );
    expect(screen.getByRole("link", { name: "OSSQ scanned-corrected · v1" })).toHaveAttribute(
      "href", "https://huggingface.co/datasets/jhlusko/ossq-omr-data",
    );
    expect(screen.getByRole("link", { name: "Lieder source provenance" })).toHaveAttribute(
      "href", "https://huggingface.co/datasets/jhlusko/lieder-omr-private-all-sources",
    );
    expect(screen.getByText(/rather than scan PDFs or staff-crop images/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /sign in/i })).not.toBeInTheDocument();
  });

  it("keeps every archive attached to its corpus version, size and checksum", () => {
    render(<DatasetsPage />);
    for (const corpus of corpora) {
      const article = screen.getByRole("article", { name: corpus.title });
      expect(within(article).getByText(corpus.version)).toBeInTheDocument();
      expect(within(article).getByRole("link", { name: "R2 release manifest" })).toHaveAttribute("href", corpus.manifest);
      for (const shard of corpus.shards) {
        // Downloads sit in native details elements, which start collapsed.
        expect(within(article).getByText(shard.name).closest("a")).toHaveAttribute("href", shard.url);
        expect(within(article).getByText(shard.sha256)).toBeInTheDocument();
        expect(shard.sha256).toMatch(/^[a-f0-9]{64}$/);
        expect(shard.url).toContain(`/${corpus.version}/`);
      }
      expect(corpus.shards.filter((shard) => shard.split === "train")).toHaveLength(corpus.splits.train.shards);
      expect(corpus.shards.filter((shard) => shard.split === "valid")).toHaveLength(corpus.splits.valid.shards);
    }
    const allLinks = screen.getAllByRole("link").map((anchor) => anchor.getAttribute("href") ?? "");
    expect(allLinks.some((href) => href.endsWith("/settings"))).toBe(false);
    expect(allLinks.some((href) => href.includes("lieder-v4-all-sources.tar.gz"))).toBe(false);
  });
});
