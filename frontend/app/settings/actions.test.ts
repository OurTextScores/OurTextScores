"use server";

import { updateWatchPreference, updateProfile, handleUpdateProfile } from "./actions";
import { getApiBase } from "../lib/api";
import { getApiAuthHeaders } from "../lib/authToken";
import { revalidatePath } from "next/cache";
import { jest } from "@jest/globals";

// Mock dependencies
jest.mock("../lib/api", () => ({
  getApiBase: jest.fn(() => "http://localhost:4000/api"),
}));

global.fetch = jest.fn();

describe("settings-actions", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("updateWatchPreference", () => {
    it("should call the API with the correct preference and revalidate the path on success", async () => {
      (fetch as jest.Mock).mockResolvedValueOnce({ ok: true });

      await updateWatchPreference("daily");

      expect(fetch).toHaveBeenCalledWith(
        `http://localhost:4000/api/users/me/preferences`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer test-token",
          },
          body: JSON.stringify({ watchPreference: "daily" }),
        }
      );
      expect(revalidatePath).toHaveBeenCalledWith("/settings");
    });

    it("should throw an error on API failure", async () => {
      (fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Server error"),
      });

      await expect(updateWatchPreference("weekly")).rejects.toThrow("Server error");
    });
  });

  describe("updateProfile", () => {
    it("should call the API with username and revalidate the path on success", async () => {
      (fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ ok: true }),
      });

      const result = await updateProfile({ username: "johndoe" });

      expect(fetch).toHaveBeenCalledWith(
        `http://localhost:4000/api/users/me`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer test-token",
          },
          body: JSON.stringify({ username: "johndoe" }),
        }
      );
      expect(revalidatePath).toHaveBeenCalledWith("/settings");
      expect(result).toEqual({ success: true });
    });

    it("should return error when API returns error", async () => {
      (fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ ok: false, error: "Username already taken" }),
      });

      const result = await updateProfile({ username: "taken" });

      expect(result).toEqual({ success: false, error: "Username already taken" });
    });

    it("should return error on API failure", async () => {
      (fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        json: () => Promise.resolve({ ok: false, error: "Server error" }),
      });

      const result = await updateProfile({ username: "test" });

      expect(result).toEqual({ success: false, error: "Server error" });
    });
  });

  describe("handleUpdateProfile", () => {
    it("should extract username from formData and call updateProfile", async () => {
      (fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ ok: true }),
      });

      const formData = new FormData();
      formData.set("username", "newuser");

      const result = await handleUpdateProfile(null, formData);

      expect(fetch).toHaveBeenCalledWith(
        `http://localhost:4000/api/users/me`,
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ username: "newuser" }),
        })
      );
      expect(result).toEqual({ success: true });
    });

    it("should handle errors gracefully", async () => {
      (fetch as jest.Mock).mockRejectedValueOnce(new Error("Network error"));

      const formData = new FormData();
      formData.set("username", "test");

      const result = await handleUpdateProfile(null, formData);

      expect(result).toEqual({ success: false, error: "An unexpected error occurred" });
    });
  });
});
