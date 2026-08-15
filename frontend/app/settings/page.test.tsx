import { jest } from "@jest/globals";
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
    NotificationsForm: function MockNotificationsForm({ preference, emailEnabled, emailCategories }: any) {
      return (
        <div data-testid="notifications-form-mock">
          <input data-testid="pref-immediate" type="radio" checked={preference === 'immediate'} readOnly />
          <input data-testid="pref-daily" type="radio" checked={preference === 'daily'} readOnly />
          <input data-testid="pref-weekly" type="radio" checked={preference === 'weekly'} readOnly />
          <input data-testid="email-enabled" type="checkbox" checked={emailEnabled} readOnly />
          <span data-testid="comments-enabled">{String(emailCategories.comments)}</span>
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

  it("passes persisted email opt-outs to the notification form", async () => {
    (fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        user: {
          email: "user@example.com",
          roles: ["user"],
          notify: {
            watchPreference: "daily",
            emailEnabled: false,
            emailCategories: { comments: false }
          }
        }
      })
    });

    const page: any = await SettingsPage();
    const findNotificationForm = (node: any): any => {
      if (!node || typeof node !== "object") return undefined;
      if (node.props?.emailCategories && node.props?.preference) return node;
      const children = Array.isArray(node.props?.children)
        ? node.props.children
        : [node.props?.children];
      return children.map(findNotificationForm).find(Boolean);
    };
    const form = findNotificationForm(page);

    expect(form.props.preference).toBe("daily");
    expect(form.props.emailEnabled).toBe(false);
    expect(form.props.emailCategories.comments).toBe(false);
    expect(form.props.emailCategories.revisions).toBe(true);
  });
});
