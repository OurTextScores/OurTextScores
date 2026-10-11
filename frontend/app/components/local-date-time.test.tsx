import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";

import { hydrationProblems, renderServerHtml } from "../test-utils";
import LocalDateTime from "./local-date-time";

const moment = "2026-10-11T14:06:03.000Z";

describe("LocalDateTime", () => {
  afterEach(() => jest.restoreAllMocks());

  it("writes the time in UTC on the server, where the reader's locale is unknown", () => {
    jest.spyOn(Date.prototype, "toLocaleString").mockReturnValue("as the server would format it");

    const html = renderServerHtml(<LocalDateTime value={moment} />);

    expect(html).toContain("2026-10-11 14:06 UTC");
    expect(html).toContain('dateTime="2026-10-11T14:06:03.000Z"');
    expect(html).not.toContain("as the server would format it");
  });

  it("shows the reader's own form of the time in the browser", () => {
    jest.spyOn(Date.prototype, "toLocaleString").mockReturnValue("11 Oct 2026, 07:06");

    render(<LocalDateTime value={moment} />);

    expect(screen.getByText("11 Oct 2026, 07:06")).toBeInTheDocument();
  });

  it("hydrates without a mismatch, then switches to the reader's form", async () => {
    expect(await hydrationProblems(<LocalDateTime value={moment} />)).toEqual([]);
  });

  it("is needed: a date formatted while rendering does not survive hydration", async () => {
    // What the pages did before. This is also the check that `hydrationProblems` can see it.
    const Naive = () => <span>{new Date(moment).toLocaleString()}</span>;

    expect(await hydrationProblems(<Naive />)).not.toEqual([]);
  });

  it("can show the date alone", () => {
    expect(renderServerHtml(<LocalDateTime value={moment} dateOnly />)).toContain(">2026-10-11<");

    jest.spyOn(Date.prototype, "toLocaleDateString").mockReturnValue("11 Oct 2026");
    render(<LocalDateTime value={moment} dateOnly />);
    expect(screen.getByText("11 Oct 2026")).toBeInTheDocument();
  });

  it("shows the fallback for a missing or unreadable time", () => {
    const { container, rerender } = render(<LocalDateTime value={undefined} />);
    expect(container).toHaveTextContent("—");

    rerender(<LocalDateTime value="not a date" fallback="-" />);
    expect(container).toHaveTextContent("-");
    expect(container.querySelector("time")).toBeNull();
  });
});
