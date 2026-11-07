import { render, screen } from "@testing-library/react";
import PerformerPage from "./page";

describe("Performer mode page", () => {
  it("opens the vendored performer app, an example score and its guide", () => {
    render(<PerformerPage />);
    expect(screen.getByRole("heading", { level: 1, name: "Performer mode" })).toBeVisible();
    expect(screen.getByTestId("performer-open")).toHaveAttribute("href", "/score-editor/perform.html");
    const example = new URL(screen.getByTestId("performer-example").getAttribute("href")!, "https://ots.invalid");
    expect(example.pathname).toBe("/score-editor/perform.html");
    expect(example.searchParams.get("score")).toMatch(/^https:\/\/raw\.githubusercontent\.com\/.+\.mscx$/);
    expect(screen.getByRole("link", { name: "How to use it" })).toHaveAttribute(
      "href",
      "/score-editor/perform.html?guide",
    );
  });

  it("explains the features, installing on an iPad, and opening any catalogue score", () => {
    render(<PerformerPage />);
    for (const heading of ["Made for the stage", "Install it on your iPad", "Any score in the catalogue"]) {
      expect(screen.getByRole("heading", { level: 2, name: heading })).toBeVisible();
    }
    expect(screen.getAllByRole("listitem").length).toBeGreaterThanOrEqual(9);
  });
});
