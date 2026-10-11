"use client";

import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { useSession } from "next-auth/react";

import { fetchWorksPaginated, searchWorks } from "../lib/api";
import { renderServerHtml } from "../test-utils";

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

describe("Catalogue ?q= deep link", () => {
  beforeEach(() => {
    (useSession as jest.Mock).mockReturnValue({ data: null });
    window.history.pushState({}, "", "/catalogue?q=Faur%C3%A9");
  });

  afterEach(() => {
    window.history.pushState({}, "", "/");
    jest.clearAllMocks();
  });

  it("does not read the URL while rendering, so the first render matches the server HTML", () => {
    // The page is prerendered without a query string. If the first render used the URL, the
    // browser's first render would differ from that HTML and React would discard the tree.
    const html = renderServerHtml(<WorksPage />);
    expect(html).not.toContain("Fauré");
  });

  it("searches for the linked query without first loading the unfiltered list", async () => {
    render(<WorksPage />);

    await waitFor(() => {
      expect(searchWorks).toHaveBeenCalledWith("Fauré", expect.objectContaining({ offset: 0 }));
    });
    expect(screen.getByPlaceholderText(/search by title/i)).toHaveValue("Fauré");
    expect(fetchWorksPaginated).not.toHaveBeenCalled();
  });
});
