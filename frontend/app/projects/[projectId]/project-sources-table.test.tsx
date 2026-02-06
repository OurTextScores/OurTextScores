import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ProjectSourcesTable from "./project-sources-table";
import { removeProjectSourceAction } from "../actions";

jest.mock("../actions", () => ({
  removeProjectSourceAction: jest.fn(),
}));

describe("ProjectSourcesTable", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("renders project sources and work links", () => {
    render(
      <ProjectSourcesTable
        projectId="prj_1"
        sources={[
          {
            workId: "100",
            sourceId: "src_1",
            label: "Main score",
            sourceType: "score",
            format: "application/xml",
            originalFilename: "score.xml",
            hasReferencePdf: false,
            adminVerified: false,
            projectIds: ["prj_1"],
            title: "Sonata",
          },
        ]}
        total={1}
        limit={20}
        offset={0}
        canRemoveSources={true}
      />
    );

    expect(screen.getByRole("link", { name: "Main score" })).toHaveAttribute(
      "href",
      "/works/100?source=src_1"
    );
    expect(screen.getByText("Sonata")).toBeInTheDocument();
  });

  it("removes source when remove is clicked", async () => {
    (removeProjectSourceAction as jest.Mock).mockResolvedValue({ ok: true });

    render(
      <ProjectSourcesTable
        projectId="prj_1"
        sources={[
          {
            workId: "100",
            sourceId: "src_1",
            label: "Main score",
            sourceType: "score",
            format: "application/xml",
            originalFilename: "score.xml",
            hasReferencePdf: false,
            adminVerified: false,
            projectIds: ["prj_1"],
          },
        ]}
        total={1}
        limit={20}
        offset={0}
        canRemoveSources={true}
      />
    );

    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => {
      expect(removeProjectSourceAction).toHaveBeenCalledWith("prj_1", "src_1");
    });
  });
});
