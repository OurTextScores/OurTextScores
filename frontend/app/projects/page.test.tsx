import { render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom";

import ProjectsPage from "./page";
import { fetchProjects } from "../lib/api";
import { fetchBackendSession } from "../lib/server-session";

jest.mock("../lib/api", () => ({ fetchProjects: jest.fn() }));
jest.mock("../lib/server-session", () => ({ fetchBackendSession: jest.fn() }));
jest.mock("./create-project-form", () => ({
  __esModule: true,
  default: () => <div data-testid="create-project-form" />,
}));

const project = {
  projectId: "prj_1",
  slug: "dichterliebe-complete",
  title: "Dichterliebe, complete",
  description: "All sixteen songs.",
  visibility: "public" as const,
  status: "active" as const,
  // Still sent by the API, which keeps rows; the page has nowhere to show them.
  rowCount: 7,
  linkedSourceCount: 3,
  createdBy: "lead_1",
  updatedAt: "2026-03-07T16:05:00.000Z",
  lead: { userId: "lead_1", username: "maintainer" },
  members: [{ userId: "m1" }, { userId: "m2" }],
};

async function renderPage({ projects = [project], user = null as null | { userId: string } } = {}) {
  (fetchProjects as jest.Mock).mockResolvedValue({ projects, total: projects.length, limit: 100, offset: 0 });
  (fetchBackendSession as jest.Mock).mockResolvedValue({ user });
  render(await ProjectsPage());
}

describe("ProjectsPage", () => {
  beforeEach(() => jest.clearAllMocks());

  it("lists each project with what its own page shows: lead, members, linked sources", async () => {
    await renderPage();

    const row = screen.getByRole("row", { name: /Dichterliebe, complete/ });
    expect(within(row).getByRole("link", { name: "Dichterliebe, complete" })).toHaveAttribute("href", "/projects/prj_1");
    expect(within(row).getByText("maintainer")).toBeInTheDocument();
    expect(within(row).getAllByRole("cell").map((cell) => cell.textContent)).toEqual(
      expect.arrayContaining(["2", "3"]),
    );
  });

  it("has no Rows column: rows are not shown anywhere on a project's page", async () => {
    // The rows table was replaced by the spreadsheet panel and the sources table. A count of
    // rows here pointed at something a reader could never open.
    await renderPage();

    expect(screen.getAllByRole("columnheader").map((header) => header.textContent)).toEqual([
      "Project",
      "Lead",
      "Members",
      "Linked Sources",
      "Updated",
    ]);
    const row = screen.getByRole("row", { name: /Dichterliebe, complete/ });
    expect(within(row).getAllByRole("cell")).toHaveLength(5);
    expect(within(row).queryByText("7")).not.toBeInTheDocument();
  });

  it("says so when there are no projects, across the whole table", async () => {
    await renderPage({ projects: [] });

    expect(screen.getByText("No projects found.")).toHaveAttribute("colspan", "5");
  });

  it("offers the form for starting a project only to a signed-in reader", async () => {
    await renderPage();
    expect(screen.queryByTestId("create-project-form")).not.toBeInTheDocument();

    await renderPage({ user: { userId: "u1" } });
    expect(screen.getByTestId("create-project-form")).toBeInTheDocument();
  });
});
