"use server";

import { revalidatePath } from "next/cache";
import {
  createProjectAction,
  createProjectRowAction,
  updateProjectRowAction,
  createInternalSourceFromRowAction
} from "./actions";

jest.mock("../lib/api", () => ({
  getApiBase: jest.fn(() => "http://localhost:4000/api")
}));

global.fetch = jest.fn();

describe("projects actions", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("createProjectAction posts payload and revalidates", async () => {
    (fetch as jest.Mock).mockResolvedValueOnce({
      status: 201,
      ok: true,
      json: () => Promise.resolve({ projectId: "prj_1" })
    });

    const out = await createProjectAction({ title: "Project A", visibility: "public" });

    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:4000/api/projects",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ title: "Project A", visibility: "public" }) })
    );
    expect(revalidatePath).toHaveBeenCalledWith("/projects");
    expect(out).toEqual({ projectId: "prj_1" });
  });

  it("createProjectRowAction sends row and revalidates detail path", async () => {
    (fetch as jest.Mock).mockResolvedValueOnce({
      status: 201,
      ok: true,
      json: () => Promise.resolve({ rowId: "row_1", rowVersion: 1 })
    });

    const out = await createProjectRowAction("prj_1", { notes: "x" });

    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:4000/api/projects/prj_1/rows",
      expect.objectContaining({ method: "POST" })
    );
    expect(revalidatePath).toHaveBeenCalledWith("/projects/prj_1");
    expect(out).toEqual({ rowId: "row_1", rowVersion: 1 });
  });

  it("updateProjectRowAction throws parsed error body", async () => {
    (fetch as jest.Mock).mockResolvedValueOnce({
      status: 400,
      ok: false,
      text: () => Promise.resolve(JSON.stringify({ message: "bad row" }))
    });

    await expect(
      updateProjectRowAction("prj_1", "row_1", { rowVersion: 1, notes: "x" })
    ).rejects.toThrow("bad row");
  });

  it("createInternalSourceFromRowAction revalidates projects and work paths", async () => {
    (fetch as jest.Mock).mockResolvedValueOnce({
      status: 200,
      ok: true,
      json: () => Promise.resolve({ workId: "100", sourceId: "src_1" })
    });

    const out = await createInternalSourceFromRowAction("prj_1", "row_1", { imslpUrl: "https://imslp.org/wiki/Test" });

    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:4000/api/projects/prj_1/rows/row_1/create-source",
      expect.objectContaining({ method: "POST" })
    );
    expect(revalidatePath).toHaveBeenCalledWith("/projects/prj_1");
    expect(revalidatePath).toHaveBeenCalledWith("/works/100");
    expect(out).toEqual({ workId: "100", sourceId: "src_1" });
  });
});
