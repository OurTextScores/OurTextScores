import { render, screen } from "@testing-library/react";
import WelcomePage from "./page";

describe("WelcomePage", () => {
  it("features and links to the standalone score player", () => {
    render(<WelcomePage />);

    expect(
      screen.getByRole("heading", { name: "Score Player" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Integrated score-following audio player")).toBeInTheDocument();
    expect(
      screen.getAllByRole("link", { name: /Open Score Player/ }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          href: expect.stringMatching(/\/player$/),
        }),
      ]),
    );
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
