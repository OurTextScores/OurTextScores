"use client";

import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { useSession, signOut } from "next-auth/react";
import Header from "./header";

// Mock next-auth
jest.mock("next-auth/react", () => ({
  useSession: jest.fn(),
  signOut: jest.fn(),
}));

describe("Header", () => {
  beforeEach(() => {
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ unreadCount: 0 }),
    }) as any;
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it("renders only sign-in link when unauthenticated", () => {
    (useSession as jest.Mock).mockReturnValue({ data: null });
    render(<Header />);
    const signInLink = screen.getByRole("link", { name: /Sign in/i });
    expect(signInLink).toBeInTheDocument();
    expect(signInLink).toHaveAttribute("href", "/signin");
    expect(screen.queryByRole("link", { name: /Join beta/i })).not.toBeInTheDocument();
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

  it("links username in toolbar to user profile page", () => {
    const session = {
      user: { name: "jhlusko", email: "test@example.com", username: "jhlusko" },
    };
    (useSession as jest.Mock).mockReturnValue({ data: session });
    render(<Header />);

    const profileLink = screen.getByRole("link", { name: "jhlusko" });
    expect(profileLink).toHaveAttribute("href", "/users/jhlusko");
  });

  it("loads username from /api/proxy/users/me when session only has email", async () => {
    const session = {
      user: { email: "jhlusko@gmail.com" },
    };
    (useSession as jest.Mock).mockReturnValue({ data: session });
    (globalThis.fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ unreadCount: 0 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ user: { username: "jhlusko" } }),
      });

    render(<Header />);

    const profileLink = await screen.findByRole("link", { name: "jhlusko" });
    expect(profileLink).toHaveAttribute("href", "/users/jhlusko");
  });
});
