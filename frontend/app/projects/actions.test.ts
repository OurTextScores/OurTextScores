"use server";

import { revalidatePath } from "next/cache";
import {
  createProjectAction,
  joinProjectAction,
  removeProjectSourceAction
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
    expect(out).toEqual({ ok: true, projectId: "prj_1" });
  });

  it("joinProjectAction posts join and revalidates project paths", async () => {
    (fetch as jest.Mock).mockResolvedValueOnce({
      status: 200,
      ok: true,
      json: () => Promise.resolve({ projectId: "prj_1" })
    });

    const out = await joinProjectAction("prj_1");

    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:4000/api/projects/prj_1/join",
      expect.objectContaining({ method: "POST" })
    );
    expect(revalidatePath).toHaveBeenCalledWith("/projects");
    expect(revalidatePath).toHaveBeenCalledWith("/projects/prj_1");
    expect(out).toEqual({ projectId: "prj_1" });
  });

  it("removeProjectSourceAction deletes source link and revalidates project path", async () => {
    (fetch as jest.Mock).mockResolvedValueOnce({
      status: 200,
      ok: true
    });

    const out = await removeProjectSourceAction("prj_1", "src_1");

    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:4000/api/projects/prj_1/sources/src_1",
      expect.objectContaining({ method: "DELETE" })
    );
    expect(revalidatePath).toHaveBeenCalledWith("/projects/prj_1");
    expect(out).toEqual({ ok: true });
  });
});
