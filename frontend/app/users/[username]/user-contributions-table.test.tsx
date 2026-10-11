import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";

import { hydrationProblems } from "../../test-utils";
import UserContributionsTable from "./user-contributions-table";

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn() }),
  usePathname: () => "/users/clara",
  useSearchParams: () => new URLSearchParams(),
}));

const contributions = [
  {
    workId: "12745",
    workTitle: "Dichterliebe",
    workComposer: "Schumann, Robert",
    workCatalogNumber: "Op.48",
    sourceId: "source-1",
    label: "Ich grolle nicht",
    lastContributionAt: "2026-03-07T16:05:00.000Z",
  },
];

describe("UserContributionsTable", () => {
  it("hydrates cleanly for a reader whose locale is not the server's", async () => {
    // "Last Contribution" used to be written in the reader's locale while rendering, which
    // did not match the server's HTML on a direct load of a profile.
    expect(
      await hydrationProblems(
        <UserContributionsTable contributions={contributions} total={1} currentPage={1} itemsPerPage={20} />,
      ),
    ).toEqual([]);
  });

  it("shows when the last contribution was, in the reader's form, and a dash when unknown", () => {
    jest.spyOn(Date.prototype, "toLocaleString").mockReturnValue("7 Mar 2026, 08:05");

    render(
      <UserContributionsTable
        contributions={[...contributions, { workId: "2203", sourceId: "source-2", label: "Gute Nacht" }]}
        total={2}
        currentPage={1}
        itemsPerPage={20}
      />,
    );

    expect(screen.getByText("7 Mar 2026, 08:05")).toBeInTheDocument();
    const unknown = screen.getByRole("row", { name: /Gute Nacht/ });
    expect(unknown.querySelector("td:last-child")).toHaveTextContent("—");
    jest.restoreAllMocks();
  });
});
