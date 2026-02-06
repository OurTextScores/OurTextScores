import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ProjectSummaryCard from "./project-summary-card";
import { joinProjectAction, updateProjectAction } from "../actions";

jest.mock("../actions", () => ({
  joinProjectAction: jest.fn(),
  updateProjectAction: jest.fn(),
}));

const project = {
  projectId: "prj_1",
  slug: "project-1",
  title: "Project 1",
  description: "Initial description",
  visibility: "public" as const,
  status: "active" as const,
  rowCount: 0,
  linkedSourceCount: 0,
  createdBy: "lead_1",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
  lead: { userId: "lead_1", username: "lead" },
  members: [{ userId: "member_1", username: "member" }],
  spreadsheetProvider: "google" as const,
  spreadsheetEmbedUrl: "https://docs.google.com/spreadsheets/d/e/demo/pubhtml",
  spreadsheetExternalUrl: "https://docs.google.com/spreadsheets/d/demo/edit",
};

describe("ProjectSummaryCard", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("renders project metadata", () => {
    render(<ProjectSummaryCard project={project} canEdit={true} canJoin={false} />);
    expect(screen.getByText("Project 1")).toBeInTheDocument();
    expect(screen.getByText("Initial description")).toBeInTheDocument();
    expect(screen.getByText(/Lead:/)).toBeInTheDocument();
  });

  it("supports editing project details", async () => {
    (updateProjectAction as jest.Mock).mockResolvedValue({ ...project });
    render(<ProjectSummaryCard project={project} canEdit={true} canJoin={false} />);

    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    const titleInput = screen.getByLabelText("Title");
    await userEvent.clear(titleInput);
    await userEvent.type(titleInput, "Updated Project");
    await userEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => {
      expect(updateProjectAction).toHaveBeenCalledWith(
        "prj_1",
        expect.objectContaining({ title: "Updated Project" })
      );
    });
  });

  it("joins project when join button is shown", async () => {
    (joinProjectAction as jest.Mock).mockResolvedValue({ ...project });
    render(<ProjectSummaryCard project={project} canEdit={false} canJoin={true} />);

    await userEvent.click(screen.getByRole("button", { name: "Join Project" }));

    await waitFor(() => {
      expect(joinProjectAction).toHaveBeenCalledWith("prj_1");
    });
  });
});
