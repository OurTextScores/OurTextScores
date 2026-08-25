import { render, screen } from "@testing-library/react";
import WelcomePage from "./page";

describe("WelcomePage", () => {
  it("features and links to the standalone score player", () => {
    render(<WelcomePage />);

    expect(
      screen.getByRole("heading", { name: "Score Player" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Integrated score-following audio player")).toBeInTheDocument();
    const playerExample = screen.getByRole("link", {
      name: /Open Example in Score Player/,
    });
    const playerUrl = new URL(playerExample.getAttribute("href")!, "https://www.ourtextscores.com");
    expect(playerUrl.pathname).toBe("/player");
    expect(playerUrl.searchParams.get("score")).toBe(
      "https://raw.githubusercontent.com/DCMLab/beethoven_piano_sonatas/main/MS3/01-1.mscx",
    );

    const exampleLinks = [
      ["Open Example Versioned Sources", "/works/1148359"],
      ["Open Example in Score Editor", "/score-editor/index.html"],
      ["Try the Scanner", "/scanner"],
      ["Explore the Catalogue", "/catalogue"],
      [
        "Open Example Change Review",
        "/change-reviews/b81896dd-0ce1-4b60-b5e4-29273c7384aa",
      ],
    ] as const;
    for (const [name, pathname] of exampleLinks) {
      expect(screen.getByRole("link", { name: new RegExp(name) })).toHaveAttribute(
        "href",
        expect.stringContaining(pathname),
      );
    }
    expect(screen.getByRole("heading", { name: "Score Editor" })).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Project Workspaces" }),
    ).not.toBeInTheDocument();

    const playerCard = screen.getByRole("heading", { name: "Score Player" }).closest("article");
    expect(playerCard?.querySelector('video[src="/images/features/player-light.webm"]')).toBeTruthy();
    expect(playerCard?.querySelector('video[src="/images/features/player-dark.webm"]')).toBeTruthy();

    const editorCard = screen.getByRole("heading", { name: "Score Editor" }).closest("article");
    expect(editorCard?.querySelector('video[src="/images/features/score-editor-light.webm"]')).toBeTruthy();
  });
});
