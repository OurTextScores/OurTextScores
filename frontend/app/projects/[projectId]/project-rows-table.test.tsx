import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ProjectRowsTable from "./project-rows-table";
import {
  createProjectRowAction,
  updateProjectRowAction,
  deleteProjectRowAction,
  createInternalSourceFromRowAction
} from "../actions";

jest.mock("../actions", () => ({
  createProjectRowAction: jest.fn(),
  updateProjectRowAction: jest.fn(),
  deleteProjectRowAction: jest.fn(),
  createInternalSourceFromRowAction: jest.fn()
}));

describe("ProjectRowsTable", () => {
  const rows = [
    {
      projectId: "prj_1",
      rowId: "row_1",
      externalScoreUrl: "https://example.com/source.xml",
      imslpUrl: "https://imslp.org/wiki/Test",
      hasReferencePdf: false,
      verified: false,
      notes: "initial",
      createdBy: "u1",
      updatedBy: "u1",
      rowVersion: 1
    }
  ];

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("adds a new row", async () => {
    (createProjectRowAction as jest.Mock).mockResolvedValue({
      projectId: "prj_1",
      rowId: "row_2",
      hasReferencePdf: false,
      verified: false,
      createdBy: "u1",
      updatedBy: "u1",
      rowVersion: 1
    });

    render(<ProjectRowsTable projectId="prj_1" rows={rows as any} canEditRows={true} canToggleVerified={true} />);

    await userEvent.click(screen.getByRole("button", { name: "Add Row" }));

    await waitFor(() => {
      expect(createProjectRowAction).toHaveBeenCalledWith("prj_1", {
        externalScoreUrl: "",
        imslpUrl: "",
        hasReferencePdf: false,
        notes: ""
      });
    });

    expect(screen.getAllByText(/Create Internal Source/).length).toBeGreaterThan(0);
  });

  it("saves edited row", async () => {
    (updateProjectRowAction as jest.Mock).mockResolvedValue({
      ...rows[0],
      notes: "changed",
      rowVersion: 2
    });

    render(<ProjectRowsTable projectId="prj_1" rows={rows as any} canEditRows={true} canToggleVerified={true} />);

    const notes = screen.getByDisplayValue("initial");
    await userEvent.clear(notes);
    await userEvent.type(notes, "changed");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(updateProjectRowAction).toHaveBeenCalledWith(
        "prj_1",
        "row_1",
        expect.objectContaining({ rowVersion: 1, notes: "changed" })
      );
    });
  });

  it("creates internal source from row", async () => {
    (createInternalSourceFromRowAction as jest.Mock).mockResolvedValue({
      workId: "100",
      sourceId: "src_1",
      row: { rowVersion: 2 }
    });

    render(<ProjectRowsTable projectId="prj_1" rows={rows as any} canEditRows={true} canToggleVerified={true} />);

    await userEvent.click(screen.getByRole("button", { name: "Create Internal Source" }));

    await waitFor(() => {
      expect(createInternalSourceFromRowAction).toHaveBeenCalledWith("prj_1", "row_1", {
        imslpUrl: "https://imslp.org/wiki/Test"
      });
    });

    expect(await screen.findByRole("link", { name: "Open Source" })).toHaveAttribute(
      "href",
      "/works/100?source=src_1"
    );
  });
});
