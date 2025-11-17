"use server";

import { jest } from "@jest/globals";
import { prunePendingSourcesAction, deleteAllSourcesAction, deleteSourceAction } from "./admin-actions";
import { getApiBase } from "../../lib/api";
import { getApiAuthHeaders } from "../../lib/authToken";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

jest.mock("../../lib/api", () => ({
  getApiBase: jest.fn(() => "http://localhost:4000/api"),
}));

const mockRedirect = jest.mocked(redirect);

global.fetch = jest.fn();

describe("admin-actions", () => {
  const workId = "test-work-id";
  const sourceId = "test-source-id";

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("prunePendingSourcesAction calls API and revalidates on success", async () => {
    (fetch as jest.Mock).mockResolvedValueOnce({ ok: true });

    await prunePendingSourcesAction(workId);

    expect(fetch).toHaveBeenCalledWith(
      `http://localhost:4000/api/works/${workId}/sources/prune-pending`,
      {
        method: "POST",
        headers: { Authorization: "Bearer test-token" },
      }
    );
    expect(revalidatePath).toHaveBeenCalledWith(`/works/${workId}`);
  });

  it("deleteAllSourcesAction redirects on 401", async () => {
    (fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: () => Promise.resolve(""),
    });

    await expect(deleteAllSourcesAction(workId)).rejects.toThrow("NEXT_REDIRECT");
    expect(mockRedirect).toHaveBeenCalledWith("/api/auth/signin");
  });

  it("deleteSourceAction calls API and revalidates on success", async () => {
    (fetch as jest.Mock).mockResolvedValueOnce({ ok: true });

    await deleteSourceAction(workId, sourceId);

    expect(fetch).toHaveBeenCalledWith(
      `http://localhost:4000/api/works/${workId}/sources/${sourceId}`,
      {
        method: "DELETE",
        headers: { Authorization: "Bearer test-token" },
      }
    );
    expect(revalidatePath).toHaveBeenCalledWith(`/works/${workId}`);
  });

  it("deleteSourceAction throws on other failures", async () => {
    (fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Server error"),
    });

    await expect(deleteSourceAction(workId, sourceId)).rejects.toThrow("Server error");
  });
});
