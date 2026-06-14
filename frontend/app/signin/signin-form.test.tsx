import { jest } from "@jest/globals";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { signIn } from "next-auth/react";

jest.mock("next-auth/react", () => ({
  signIn: jest.fn(),
}));

import SignInForm from "./signin-form";

describe("SignInForm", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (signIn as jest.Mock).mockResolvedValue(undefined);
  });

  it("starts email magic-link sign-in when email is configured", async () => {
    const user = userEvent.setup();
    render(
      <SignInForm
        initialNext="/change-reviews/review-1"
        emailEnabled
        googleEnabled={false}
        githubEnabled={false}
      />,
    );

    await user.type(screen.getByLabelText("Email"), "reviewer@example.com");
    fireEvent.submit(screen.getByRole("button", { name: "Send magic link" }).closest("form")!);

    await waitFor(() => {
      expect(signIn).toHaveBeenCalledWith("email", {
        email: "reviewer@example.com",
        callbackUrl: "/change-reviews/review-1",
      });
    });
    expect(screen.queryByText(/Sign-in is not configured/)).not.toBeInTheDocument();
  });

  it("shows a configuration message when no providers are enabled", () => {
    render(<SignInForm emailEnabled={false} googleEnabled={false} githubEnabled={false} />);

    expect(screen.getByText("Sign-in is not configured yet. Contact an administrator.")).toBeInTheDocument();
  });
});
