import { fireEvent, render, screen, within } from "@testing-library/react";
import WelcomePage from "./page";

describe("WelcomePage", () => {
  it("leads with a catalogue search", () => {
    render(<WelcomePage />);
    expect(screen.getByRole("search")).toHaveAttribute("action", "/catalogue");
    expect(screen.getByRole("searchbox")).toHaveAttribute("name", "q");
  });

  it("shows one feature video at a time and switches with tabs", () => {
    const { container } = render(<WelcomePage />);
    expect(container.querySelectorAll("video").length).toBe(2); // first tab: light + dark
    expect(container.querySelector('video[src="/images/features/versioned-sources-light.webm"]')).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Score Player" }));
    expect(container.querySelector('video[src="/images/features/player-light.webm"]')).toBeTruthy();
    expect(container.querySelector('video[src="/images/features/player-dark.webm"]')).toBeTruthy();
    expect(container.querySelector('video[src="/images/features/versioned-sources-light.webm"]')).toBeNull();

    const playerUrl = new URL(
      screen.getByRole("link", { name: /Open Example in Score Player/ }).getAttribute("href")!,
      "https://www.ourtextscores.com",
    );
    expect(playerUrl.pathname).toBe("/player");
    expect(playerUrl.searchParams.get("score")).toBe(
      "https://raw.githubusercontent.com/DCMLab/beethoven_piano_sonatas/main/MS3/01-1.mscx",
    );
  });

  it("links every example from its tab", () => {
    render(<WelcomePage />);
    const examples = [
      ["Score Editor", "Open Example in Score Editor", "/score-editor/index.html"],
      ["Scanner", "Open Example Scan", "/scanner/ef98b123-329e-4ae7-a01f-cf15059b354b"],
      ["Catalogue", "Explore the Catalogue", "/catalogue"],
      ["Change Reviews", "Open Example Change Review", "/change-reviews/f8fce149-4c91-488a-8516-e051d9868f30"],
      ["Versioned Sources", "Open Example Versioned Source", "/works/1148359"],
    ] as const;
    for (const [tab, link, pathname] of examples) {
      fireEvent.click(screen.getByRole("tab", { name: tab }));
      expect(screen.getByRole("link", { name: new RegExp(link) })).toHaveAttribute(
        "href",
        expect.stringContaining(pathname),
      );
    }
  });

  it("keeps the long-form content collapsed", () => {
    render(<WelcomePage />);
    expect(screen.getByText("Why digitize?").closest("details")).not.toHaveAttribute("open");
    expect(screen.getByText("IMSLP and copyright").closest("details")).not.toHaveAttribute("open");
  });

  it("restores the contribution cards and community links", () => {
    render(<WelcomePage />);
    const section = screen.getByRole("region", { name: "Get Involved" });
    expect(section.querySelectorAll("article")).toHaveLength(8);
    for (const title of ["Scan a Printed Score", "Submit a New Revision", "Rate and Comment on a Source", "Flag Mismatched Sources"]) {
      expect(within(section).getByRole("heading", { name: title })).toBeVisible();
    }
    expect(within(section).getByRole("link", { name: "Join Discord Server" })).toHaveAttribute("href", "https://discord.gg/T3BuWeWGqt");
    expect(within(section).getByRole("link", { name: "OurTextScores Website Repo" })).toHaveAttribute("href", "https://github.com/OurTextScores/OurTextScores/");
    expect(within(section).getByRole("link", { name: "OTS_WebEditor Repo" })).toHaveAttribute("href", "https://github.com/OurTextScores/OTS_WebEditor/");
  });

  it("embeds both walkthroughs with matching YouTube links", () => {
    render(<WelcomePage />);
    for (const [title, id] of [["Website walkthrough", "Ni-rVhAV884"], ["Score Editor walkthrough", "AJj0lmKWtRA"]]) {
      const frame = screen.getByTitle(title);
      expect(frame).toHaveAttribute("src", `https://www.youtube-nocookie.com/embed/${id}`);
      expect(frame).toHaveAttribute("loading", "lazy");
      expect(frame).toHaveAttribute("allowfullscreen");
      expect(screen.getByRole("link", { name: `Watch the ${title} on YouTube` })).toHaveAttribute("href", `https://www.youtube.com/watch?v=${id}`);
    }
  });
});
