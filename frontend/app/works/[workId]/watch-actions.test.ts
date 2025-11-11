"use server";

import { watchSourceAction, unwatchSourceAction } from "./watch-actions";
import { getApiBase } from "../../lib/api";
import { getApiAuthHeaders } from "../../lib/authToken";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { jest } from "@jest/globals";

// Mock dependencies
jest.mock("../../lib/api", () => ({
  getApiBase: jest.fn(() => "http://localhost:4000/api"),
}));

const mockRedirect = jest.mocked(redirect);

global.fetch = jest.fn();

describe("watch-actions", () => {
  const workId = "test-work-id";
  const sourceId = "test-source-id";

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("watchSourceAction", () => {
    it("should call the watch API and revalidate the path on success", async () => {
      (fetch as jest.Mock).mockResolvedValueOnce({ ok: true });

      await watchSourceAction(workId, sourceId);

      expect(fetch).toHaveBeenCalledWith(
        `http://localhost:4000/api/works/${workId}/sources/${sourceId}/watch`,
        {
          method: "POST",
          headers: { "Authorization": "Bearer test-token" },
        }
      );
      expect(revalidatePath).toHaveBeenCalledWith(`/works/${workId}`);
    });

    it("should redirect to signin on 401", async () => {
      (fetch as jest.Mock).mockResolvedValueOnce({ status: 401, ok: false, text: () => Promise.resolve("") });

      await expect(watchSourceAction(workId, sourceId)).rejects.toThrow("NEXT_REDIRECT");

      expect(mockRedirect).toHaveBeenCalledWith("/api/auth/signin");
    });

    it("should throw an error on other failures", async () => {
      (fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Server error"),
      });

      await expect(watchSourceAction(workId, sourceId)).rejects.toThrow("Server error");
    });
  });

  describe("unwatchSourceAction", () => {
    it("should call the unwatch API and revalidate the path on success", async () => {
      (fetch as jest.Mock).mockResolvedValueOnce({ ok: true });

      await unwatchSourceAction(workId, sourceId);

      expect(fetch).toHaveBeenCalledWith(
        `http://localhost:4000/api/works/${workId}/sources/${sourceId}/watch`,
        {
          method: "DELETE",
          headers: { "Authorization": "Bearer test-token" },
        }
      );
      expect(revalidatePath).toHaveBeenCalledWith(`/works/${workId}`);
    });

    it("should redirect to signin on 401", async () => {
      (fetch as jest.Mock).mockResolvedValueOnce({ status: 401, ok: false, text: () => Promise.resolve("") });

      await expect(unwatchSourceAction(workId, sourceId)).rejects.toThrow("NEXT_REDIRECT");

      expect(mockRedirect).toHaveBeenCalledWith("/api/auth/signin");
    });

    it("should throw an error on other failures", async () => {
      (fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Server error"),
      });

      await expect(unwatchSourceAction(workId, sourceId)).rejects.toThrow("Server error");
    });
  });
});
