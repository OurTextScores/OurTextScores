"use client";

import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { useSession } from "next-auth/react";

import WorksPage from "./page";

jest.mock("next-auth/react", () => ({
  useSession: jest.fn(),
}));

jest.mock("next/navigation", () => ({
  useRouter: () => ({
    push: jest.fn(),
  }),
}));

jest.mock("../lib/api", () => ({
  fetchWorksPaginated: jest.fn(async () => ({
    works: [],
    total: 0,
    totalSourceCount: 0,
  })),
  resolveImslpUrl: jest.fn(),
  searchWorks: jest.fn(async () => ({
    works: [],
    total: 0,
    limit: 20,
    offset: 0,
    query: "",
  })),
}));

describe("Catalogue admin-only filters", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it("hides admin-only filters for non-admin users", async () => {
    (useSession as jest.Mock).mockReturnValue({
      data: { user: { roles: ["user"] } },
    });

    render(<WorksPage />);

    await waitFor(() => {
      expect(screen.getByText(/no works have been uploaded yet/i)).toBeInTheDocument();
    });

    expect(screen.queryByText("Has reference PDF")).not.toBeInTheDocument();
    expect(screen.queryByText("Admin verified")).not.toBeInTheDocument();
    expect(screen.queryByText("Has flagged sources")).not.toBeInTheDocument();
  });

  it("shows admin-only filters for admins", async () => {
    (useSession as jest.Mock).mockReturnValue({
      data: { user: { roles: ["user", "admin"] } },
    });

    render(<WorksPage />);

    await waitFor(() => {
      expect(screen.getByText(/no works have been uploaded yet/i)).toBeInTheDocument();
    });

    expect(screen.getByText("Has reference PDF")).toBeInTheDocument();
    expect(screen.getByText("Admin verified")).toBeInTheDocument();
    expect(screen.getByText("Has flagged sources")).toBeInTheDocument();
  });
});
