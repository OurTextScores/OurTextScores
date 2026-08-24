import { render, screen } from "@testing-library/react";
import WelcomePage from "./page";

describe("WelcomePage", () => {
  it("features and links to the standalone score player", () => {
    render(<WelcomePage />);

    expect(
      screen.getByRole("heading", { name: "Standalone Score Player" }),
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole("link", { name: /Open Score Player/ }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          href: expect.stringMatching(/\/player$/),
        }),
      ]),
    );
  });
});
