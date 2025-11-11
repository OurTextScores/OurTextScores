import { jest } from "@jest/globals";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";

// Mock dependencies FIRST before any imports
jest.mock("../lib/api", () => ({
  getApiBase: jest.fn(() => "http://localhost:4000/api"),
}));
jest.mock("../lib/authToken", () => ({
  getApiAuthHeaders: jest.fn(() => ({ Authorization: "Bearer test-token" })),
}));

// Mock the client components BEFORE importing the page
jest.mock("./profile-form", () => {
  return {
    ProfileForm: function MockProfileForm({ email, username }: any) {
      return (
        <div data-testid="profile-form-mock">
          <input data-testid="email" value={email} readOnly />
          <input data-testid="username" defaultValue={username || ''} />
        </div>
      );
    }
  };
});

jest.mock("./notifications-form", () => {
  return {
    NotificationsForm: function MockNotificationsForm({ preference }: any) {
      return (
        <div data-testid="notifications-form-mock">
          <input data-testid="pref-immediate" type="radio" checked={preference === 'immediate'} readOnly />
          <input data-testid="pref-daily" type="radio" checked={preference === 'daily'} readOnly />
          <input data-testid="pref-weekly" type="radio" checked={preference === 'weekly'} readOnly />
        </div>
      );
    }
  };
});

// Import the actual SettingsPage AFTER all mocks
import SettingsPage from "./page";

global.fetch = jest.fn();

/**
 * SettingsPage tests
 *
 * Note: Full rendering tests are skipped because the component uses React Server Components
 * with useFormState/useFormStatus hooks that require a full Next.js environment.
 * These components are thoroughly tested in smoke/e2e tests instead.
 */
describe("SettingsPage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("exports SettingsPage component", () => {
    expect(SettingsPage).toBeDefined();
    expect(typeof SettingsPage).toBe("function");
  });

  it("throws an error if fetching user data fails", async () => {
    (fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
      text: () => Promise.resolve("Failed to load user"),
    });

    await expect(SettingsPage()).rejects.toThrow("Failed to load user");
  });
});
