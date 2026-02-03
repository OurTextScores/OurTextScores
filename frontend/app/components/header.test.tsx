"use client";

import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { useSession, signIn, signOut } from "next-auth/react";
import Header from "./header";

// Mock next-auth
jest.mock("next-auth/react", () => ({
  useSession: jest.fn(),
  signIn: jest.fn(),
  signOut: jest.fn(),
}));

describe("Header", () => {
  beforeEach(() => {
    globalThis.fetch = jest.fn().mockResolvedValue({
      json: async () => ({ unreadCount: 0 }),
    }) as any;
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it("renders sign-in button when unauthenticated", () => {
    (useSession as jest.Mock).mockReturnValue({ data: null });
    render(<Header />);
    const signInButton = screen.getByRole("button", { name: /Sign in/i });
    expect(signInButton).toBeInTheDocument();
    fireEvent.click(signInButton);
    expect(signIn).toHaveBeenCalled();
  });

  it("renders user info and sign-out button when authenticated", () => {
    const session = {
      user: { name: "Test User", email: "test@example.com" },
    };
    (useSession as jest.Mock).mockReturnValue({ data: session });
    render(<Header />);

    expect(screen.getByText("Test User")).toBeInTheDocument();
    expect(screen.getByText("Approvals")).toBeInTheDocument();
    expect(screen.getByText("Settings")).toBeInTheDocument();

    const signOutButton = screen.getByRole("button", { name: /Sign out/i });
    expect(signOutButton).toBeInTheDocument();
    fireEvent.click(signOutButton);
    expect(signOut).toHaveBeenCalled();
  });

  it("renders user email if name is not available", () => {
    const session = {
      user: { email: "test@example.com" },
    };
    (useSession as jest.Mock).mockReturnValue({ data: session });
    render(<Header />);
    expect(screen.getByText("test@example.com")).toBeInTheDocument();
  });
});
