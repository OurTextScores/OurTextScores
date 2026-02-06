import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRouter } from "next/navigation";
import CreateProjectForm from "./create-project-form";
import { createProjectAction } from "./actions";

jest.mock("./actions", () => ({
  createProjectAction: jest.fn()
}));

describe("CreateProjectForm", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("submits and navigates to created project", async () => {
    const push = jest.fn();
    (useRouter as jest.Mock).mockReturnValue({ push });
    (createProjectAction as jest.Mock).mockResolvedValue({ ok: true, projectId: "prj_1" });

    render(<CreateProjectForm />);

    await userEvent.type(screen.getByPlaceholderText("Project title"), "Bach Project");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(createProjectAction).toHaveBeenCalledWith({
        title: "Bach Project",
        description: undefined,
        visibility: "public"
      });
    });

    expect(push).toHaveBeenCalledWith("/projects/prj_1");
  });

  it("shows API error", async () => {
    (useRouter as jest.Mock).mockReturnValue({ push: jest.fn() });
    (createProjectAction as jest.Mock).mockResolvedValue({ ok: false, error: "boom" });

    render(<CreateProjectForm />);

    await userEvent.type(screen.getByPlaceholderText("Project title"), "X");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(await screen.findByText("boom")).toBeInTheDocument();
  });
});
