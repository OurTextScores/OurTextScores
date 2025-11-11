"use server";

import { approveRevisionAction, rejectRevisionAction } from "./actions";
import { getApiBase } from "../lib/api";
import { getApiAuthHeaders } from "../lib/authToken";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { jest } from "@jest/globals";

// Mock dependencies
jest.mock("../lib/api", () => ({
  getApiBase: jest.fn(() => "http://localhost:4000/api"),
}));

const mockRedirect = jest.mocked(redirect);

global.fetch = jest.fn();

describe("approvals-actions", () => {
  const workId = "test-work-id";
  const sourceId = "test-source-id";
  const revisionId = "test-revision-id";

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("approveRevisionAction", () => {
    it("should call the approve API and revalidate the path on success", async () => {
      (fetch as jest.Mock).mockResolvedValueOnce({ ok: true });

      await approveRevisionAction(workId, sourceId, revisionId);

      expect(fetch).toHaveBeenCalledWith(
        `http://localhost:4000/api/works/${workId}/sources/${sourceId}/revisions/${revisionId}/approve`,
        {
          method: "POST",
          headers: { "Authorization": "Bearer test-token" },
        }
      );
      expect(revalidatePath).toHaveBeenCalledWith("/approvals");
    });

    it("should redirect to signin on 401", async () => {
      (fetch as jest.Mock).mockResolvedValueOnce({ status: 401, ok: false, text: () => Promise.resolve("") });

      await expect(approveRevisionAction(workId, sourceId, revisionId)).rejects.toThrow("NEXT_REDIRECT");

      expect(mockRedirect).toHaveBeenCalledWith("/api/auth/signin");
    });

    it("should throw an error on other failures", async () => {
      (fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Server error"),
      });

      await expect(approveRevisionAction(workId, sourceId, revisionId)).rejects.toThrow("Server error");
    });
  });

  describe("rejectRevisionAction", () => {
    it("should call the reject API and revalidate the path on success", async () => {
      (fetch as jest.Mock).mockResolvedValueOnce({ ok: true });

      await rejectRevisionAction(workId, sourceId, revisionId);

      expect(fetch).toHaveBeenCalledWith(
        `http://localhost:4000/api/works/${workId}/sources/${sourceId}/revisions/${revisionId}/reject`,
        {
          method: "POST",
          headers: { "Authorization": "Bearer test-token" },
        }
      );
      expect(revalidatePath).toHaveBeenCalledWith("/approvals");
    });

    it("should redirect to signin on 401", async () => {
      (fetch as jest.Mock).mockResolvedValueOnce({ status: 401, ok: false, text: () => Promise.resolve("") });

      await expect(rejectRevisionAction(workId, sourceId, revisionId)).rejects.toThrow("NEXT_REDIRECT");

      expect(mockRedirect).toHaveBeenCalledWith("/api/auth/signin");
    });

    it("should throw an error on other failures", async () => {
      (fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Server error"),
      });

      await expect(rejectRevisionAction(workId, sourceId, revisionId)).rejects.toThrow("Server error");
    });
  });
});
