/**
 * @jest-environment node
 */

/*
 * Copyright (C) 2025 OurTextScores Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

import { notFound } from "next/navigation";
import {
  getApiBase,
  getPublicApiBase,
  fetchWorks,
  fetchWorksPaginated,
  fetchWorkDetail,
  updateWorkMetadata,
  ensureWork,
  uploadSourceRevision,
  searchImslp,
  resolveImslpUrl,
  fetchImslpMetadataByWorkId,
  fetchImslpRawDoc,
  type WorkSummary,
  type PaginatedWorksResponse,
  type WorkDetail,
  type EnsureWorkResponse,
  type ImslpWorkSummary,
  type ImslpRawDoc,
} from "./api";

// Mock next/navigation
jest.mock("next/navigation", () => ({
  notFound: jest.fn(),
}));

describe("API utility functions", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
    process.env = { ...originalEnv };
    // Ensure we're in server-side mode by default
    delete (global as any).window;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("getApiBase", () => {
    it("returns server API base on server side with INTERNAL_API_URL", () => {
      delete (global as any).window;
      process.env.INTERNAL_API_URL = "http://internal-backend:5000";

      const result = getApiBase();

      expect(result).toBe("http://internal-backend:5000/api");
    });

    it("returns server API base with NEXT_PUBLIC_API_URL when INTERNAL_API_URL not set", () => {
      delete (global as any).window;
      delete process.env.INTERNAL_API_URL;
      process.env.NEXT_PUBLIC_API_URL = "http://public-api:6000";

      const result = getApiBase();

      expect(result).toBe("http://public-api:6000/api");
    });

    it("returns default server API base when no env vars set", () => {
      delete (global as any).window;
      delete process.env.INTERNAL_API_URL;
      delete process.env.NEXT_PUBLIC_API_URL;

      const result = getApiBase();

      expect(result).toBe("http://backend:4000/api");
    });

    it("returns client API base on client side", () => {
      (global as any).window = {};
      process.env.NEXT_PUBLIC_API_URL = "http://client-api:7000";

      const result = getApiBase();

      expect(result).toBe("http://client-api:7000/api");
    });

    it("returns default client API base when no env vars set on client", () => {
      (global as any).window = {};
      delete process.env.NEXT_PUBLIC_API_URL;

      const result = getApiBase();

      expect(result).toBe("http://localhost:4000/api");
    });

    it("normalizes API base by removing trailing slashes", () => {
      (global as any).window = {};
      process.env.NEXT_PUBLIC_API_URL = "http://api.example.com///";

      const result = getApiBase();

      expect(result).toBe("http://api.example.com/api");
    });

    it("preserves /api suffix if already present", () => {
      (global as any).window = {};
      process.env.NEXT_PUBLIC_API_URL = "http://api.example.com/api";

      const result = getApiBase();

      expect(result).toBe("http://api.example.com/api");
    });
  });

  describe("getPublicApiBase", () => {
    it("returns public API base from NEXT_PUBLIC_API_URL", () => {
      process.env.NEXT_PUBLIC_API_URL = "http://public.example.com:8080";

      const result = getPublicApiBase();

      expect(result).toBe("http://public.example.com:8080/api");
    });

    it("returns default client API base when NEXT_PUBLIC_API_URL not set", () => {
      delete process.env.NEXT_PUBLIC_API_URL;

      const result = getPublicApiBase();

      expect(result).toBe("http://localhost:4000/api");
    });

    it("returns default client API base when NEXT_PUBLIC_API_URL is empty", () => {
      process.env.NEXT_PUBLIC_API_URL = "";

      const result = getPublicApiBase();

      expect(result).toBe("http://localhost:4000/api");
    });

    it("normalizes the public API base URL", () => {
      process.env.NEXT_PUBLIC_API_URL = "http://public.example.com//";

      const result = getPublicApiBase();

      expect(result).toBe("http://public.example.com/api");
    });
  });
});

describe("fetchWorks", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
    delete (global as any).window;
  });

  it("fetches works without parameters", async () => {
    const mockWorks: WorkSummary[] = [
      { workId: "work1", sourceCount: 1, availableFormats: ["mxl"] },
      { workId: "work2", sourceCount: 2, availableFormats: ["pdf"] },
    ];
    const mockResponse: PaginatedWorksResponse = {
      works: mockWorks,
      total: 2,
      limit: 20,
      offset: 0,
    };

    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    });

    const result = await fetchWorks();

    expect(global.fetch).toHaveBeenCalledWith(
      "http://backend:4000/api/works",
      expect.objectContaining({
        headers: expect.objectContaining({ Accept: "application/json" }),
      })
    );
    expect(result).toEqual(mockWorks);
  });

  it("fetches works with limit and offset", async () => {
    const mockResponse: PaginatedWorksResponse = {
      works: [],
      total: 0,
      limit: 10,
      offset: 5,
    };

    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    });

    await fetchWorks({ limit: 10, offset: 5 });

    expect(global.fetch).toHaveBeenCalledWith(
      "http://backend:4000/api/works?limit=10&offset=5",
      expect.any(Object)
    );
  });

  it("returns empty array in production when API fails", async () => {
    process.env.NODE_ENV = "production";
    (global.fetch as jest.Mock).mockRejectedValue(new Error("API error"));

    const result = await fetchWorks();

    expect(result).toEqual([]);
  });

  it("throws error in non-production when API fails", async () => {
    process.env.NODE_ENV = "development";
    (global.fetch as jest.Mock).mockRejectedValue(new Error("API error"));

    await expect(fetchWorks()).rejects.toThrow("API error");
  });

  it("calls notFound when response status is 404", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      status: 404,
      ok: false,
    });

    await expect(fetchWorks()).rejects.toThrow();
    expect(notFound).toHaveBeenCalled();
  });

  it("throws error when response is not ok", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      status: 500,
      ok: false,
      text: async () => "Internal server error",
    });

    await expect(fetchWorks()).rejects.toThrow("API request failed (500): Internal server error");
  });
});

describe("fetchWorksPaginated", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
    delete (global as any).window;
  });

  it("fetches paginated works with all metadata", async () => {
    const mockResponse: PaginatedWorksResponse = {
      works: [{ workId: "work1", sourceCount: 1, availableFormats: ["mxl"] }],
      total: 100,
      limit: 20,
      offset: 40,
    };

    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    });

    const result = await fetchWorksPaginated({ limit: 20, offset: 40 });

    expect(result).toEqual(mockResponse);
    expect(result.total).toBe(100);
    expect(result.limit).toBe(20);
    expect(result.offset).toBe(40);
  });

  it("returns default empty response in production when API fails", async () => {
    process.env.NODE_ENV = "production";
    (global.fetch as jest.Mock).mockRejectedValue(new Error("API error"));

    const result = await fetchWorksPaginated();

    expect(result).toEqual({ works: [], total: 0, limit: 20, offset: 0 });
  });

  it("throws error in non-production when API fails", async () => {
    process.env.NODE_ENV = "development";
    (global.fetch as jest.Mock).mockRejectedValue(new Error("API error"));

    await expect(fetchWorksPaginated()).rejects.toThrow("API error");
  });
});

describe("fetchWorkDetail", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
    delete (global as any).window;
  });

  it("fetches work detail with no-store cache", async () => {
    const mockDetail: WorkDetail = {
      workId: "test-work",
      sourceCount: 1,
      availableFormats: ["mxl"],
      sources: [],
    };

    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => mockDetail,
    });

    const result = await fetchWorkDetail("test-work");

    expect(global.fetch).toHaveBeenCalledWith(
      "http://backend:4000/api/works/test-work",
      expect.objectContaining({
        cache: "no-store",
        next: expect.objectContaining({ revalidate: 0 }),
      })
    );
    expect(result).toEqual(mockDetail);
  });

  it("encodes work ID in URL", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ workId: "work with spaces", sourceCount: 0, availableFormats: [], sources: [] }),
    });

    await fetchWorkDetail("work with spaces");

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("work%20with%20spaces"),
      expect.any(Object)
    );
  });
});

describe("updateWorkMetadata", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
    delete (global as any).window;
  });

  it("updates work metadata successfully", async () => {
    const mockUpdatedWork: WorkSummary = {
      workId: "test-work",
      title: "Updated Title",
      composer: "New Composer",
      catalogNumber: "Op. 1",
      sourceCount: 1,
      availableFormats: [],
    };

    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => mockUpdatedWork,
    });

    const result = await updateWorkMetadata("test-work", {
      title: "Updated Title",
      composer: "New Composer",
      catalogNumber: "Op. 1",
    });

    expect(global.fetch).toHaveBeenCalledWith(
      "http://backend:4000/api/works/test-work/metadata",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Updated Title",
          composer: "New Composer",
          catalogNumber: "Op. 1",
        }),
      })
    );
    expect(result).toEqual(mockUpdatedWork);
  });

  it("uses proxy endpoint on client side", async () => {
    (global as any).window = {};
    const mockUpdatedWork: WorkSummary = {
      workId: "test-work",
      sourceCount: 0,
      availableFormats: [],
    };

    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => mockUpdatedWork,
    });

    await updateWorkMetadata("test-work", { title: "Updated Title" });

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/proxy/works/test-work/metadata",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Updated Title" }),
      })
    );
  });

  it("throws error when update fails", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => "Invalid metadata",
    });

    await expect(
      updateWorkMetadata("test-work", { title: "New Title" })
    ).rejects.toThrow("Invalid metadata");
  });

  it("throws generic error when response has no body", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "",
    });

    await expect(
      updateWorkMetadata("test-work", { title: "New Title" })
    ).rejects.toThrow("Failed to update work metadata");
  });
});

describe("ensureWork", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
    delete (global as any).window;
  });

  it("ensures work exists and returns metadata", async () => {
    const mockResponse: EnsureWorkResponse = {
      work: { workId: "test-work", sourceCount: 0, availableFormats: [] },
      metadata: {
        workId: "test-work",
        title: "Test Work",
        composer: "Test Composer",
        permalink: "https://imslp.org/wiki/test-work",
        metadata: {},
      },
    };

    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockResponse,
    });

    const result = await ensureWork("test-work");

    expect(global.fetch).toHaveBeenCalledWith(
      "http://backend:4000/api/works",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workId: "test-work" }),
      })
    );
    expect(result).toEqual(mockResponse);
  });

  it("throws specific error when work not found (404)", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 404,
    });

    await expect(ensureWork("nonexistent-work")).rejects.toThrow(
      "Work nonexistent-work not found in IMSLP metadata"
    );
  });

  it("throws generic error for other failures", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "Server error",
    });

    await expect(ensureWork("test-work")).rejects.toThrow(
      "Unable to ensure work: Server error"
    );
  });
});

describe("uploadSourceRevision", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
    delete (global as any).window;
  });

  it("uploads source revision successfully", async () => {
    const mockResponse = {
      revisionId: "rev123",
      workId: "work1",
      sourceId: "source1",
    };

    const formData = new FormData();
    formData.append("file", new Blob(["test content"]));

    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    });

    const result = await uploadSourceRevision("work1", "source1", formData);

    expect(global.fetch).toHaveBeenCalledWith(
      "http://backend:4000/api/works/work1/sources/source1/revisions",
      expect.objectContaining({
        method: "POST",
        body: formData,
      })
    );
    expect(result).toEqual(mockResponse);
  });

  it("encodes work ID and source ID in URL", async () => {
    const formData = new FormData();
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ revisionId: "rev1", workId: "w1", sourceId: "s1" }),
    });

    await uploadSourceRevision("work with spaces", "source/with/slashes", formData);

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("work%20with%20spaces/sources/source%2Fwith%2Fslashes"),
      expect.any(Object)
    );
  });

  it("throws error with response text when upload fails", async () => {
    const formData = new FormData();
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => "Invalid file format",
    });

    await expect(
      uploadSourceRevision("work1", "source1", formData)
    ).rejects.toThrow("Invalid file format");
  });

  it("throws error with status when response has no text", async () => {
    const formData = new FormData();
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "",
    });

    await expect(
      uploadSourceRevision("work1", "source1", formData)
    ).rejects.toThrow("Upload failed with status 500");
  });
});

describe("searchImslp", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
    delete (global as any).window;
  });

  it("searches IMSLP with query", async () => {
    const mockResults: ImslpWorkSummary[] = [
      {
        workId: "work1",
        title: "Symphony No. 5",
        composer: "Beethoven",
        permalink: "https://imslp.org/wiki/work1",
        metadata: {},
      },
      {
        workId: "work2",
        title: "Piano Sonata",
        composer: "Mozart",
        permalink: "https://imslp.org/wiki/work2",
        metadata: {},
      },
    ];

    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => mockResults,
    });

    const result = await searchImslp("Beethoven", 10);

    expect(global.fetch).toHaveBeenCalledWith(
      "http://backend:4000/api/imslp/search?q=Beethoven&limit=10",
      expect.any(Object)
    );
    expect(result).toEqual(mockResults);
  });

  it("returns empty array for empty query", async () => {
    const result = await searchImslp("", 10);

    expect(result).toEqual([]);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("returns empty array for whitespace-only query", async () => {
    const result = await searchImslp("   ", 10);

    expect(result).toEqual([]);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("uses default limit of 10 when not specified", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => [],
    });

    await searchImslp("test");

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("limit=10"),
      expect.any(Object)
    );
  });

  it("returns empty array in production when API fails", async () => {
    process.env.NODE_ENV = "production";
    (global.fetch as jest.Mock).mockRejectedValue(new Error("API error"));

    const result = await searchImslp("Beethoven");

    expect(result).toEqual([]);
  });

  it("throws error in non-production when API fails", async () => {
    process.env.NODE_ENV = "development";
    (global.fetch as jest.Mock).mockRejectedValue(new Error("API error"));

    await expect(searchImslp("Beethoven")).rejects.toThrow("API error");
  });
});

describe("resolveImslpUrl", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
    delete (global as any).window;
  });

  it("resolves IMSLP URL successfully", async () => {
    const mockResponse: EnsureWorkResponse = {
      work: { workId: "test-work", sourceCount: 0, availableFormats: [] },
      metadata: {
        workId: "test-work",
        title: "Test Work",
        composer: "Test Composer",
        permalink: "https://imslp.org/wiki/test-work",
        metadata: {},
      },
    };

    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockResponse,
    });

    const result = await resolveImslpUrl("https://imslp.org/wiki/test-work");

    expect(global.fetch).toHaveBeenCalledWith(
      "http://backend:4000/api/works/save-by-url",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://imslp.org/wiki/test-work" }),
      })
    );
    expect(result).toEqual(mockResponse);
  });

  it("throws specific error when work not found (404)", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 404,
    });

    await expect(
      resolveImslpUrl("https://imslp.org/wiki/nonexistent")
    ).rejects.toThrow("IMSLP work not found for the provided URL");
  });

  it("throws error with response body for other failures", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => "Invalid URL format",
    });

    await expect(
      resolveImslpUrl("invalid-url")
    ).rejects.toThrow("Unable to resolve IMSLP URL: Invalid URL format");
  });

  it("throws error with generic message when response has no body", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "",
    });

    await expect(
      resolveImslpUrl("https://imslp.org/wiki/test")
    ).rejects.toThrow("Unable to resolve IMSLP URL: Unknown error");
  });
});

describe("fetchImslpMetadataByWorkId", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
    delete (global as any).window;
  });

  it("fetches IMSLP metadata by work ID", async () => {
    const mockMetadata: ImslpWorkSummary = {
      workId: "test-work",
      title: "Test Work Title",
      composer: "Test Composer",
      permalink: "https://imslp.org/wiki/test-work",
      metadata: { key: "value" },
    };

    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ workId: "test-work", metadata: mockMetadata }),
    });

    const result = await fetchImslpMetadataByWorkId("test-work");

    expect(global.fetch).toHaveBeenCalledWith(
      "http://backend:4000/api/imslp/works/test-work",
      expect.any(Object)
    );
    expect(result).toEqual(mockMetadata);
  });

  it("encodes work ID in URL", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({
        workId: "work/with/slashes",
        metadata: {
          workId: "work/with/slashes",
          title: "Test",
          permalink: "https://imslp.org/wiki/test",
          metadata: {},
        },
      }),
    });

    await fetchImslpMetadataByWorkId("work/with/slashes");

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("work%2Fwith%2Fslashes"),
      expect.any(Object)
    );
  });
});

describe("fetchImslpRawDoc", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
    delete (global as any).window;
  });

  it("fetches raw IMSLP document successfully", async () => {
    const mockRawDoc: ImslpRawDoc = {
      _id: "doc123",
      workId: "test-work",
      title: "Test Work",
      composer: "Test Composer",
      permalink: "https://imslp.org/wiki/test-work",
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-02T00:00:00Z",
      metadata: { additional: "data" },
    };

    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => mockRawDoc,
    });

    const result = await fetchImslpRawDoc("test-work");

    expect(global.fetch).toHaveBeenCalledWith(
      "http://backend:4000/api/imslp/works/test-work/raw",
      expect.any(Object)
    );
    expect(result).toEqual(mockRawDoc);
  });

  it("returns undefined when fetch fails", async () => {
    (global.fetch as jest.Mock).mockRejectedValue(new Error("API error"));

    const result = await fetchImslpRawDoc("test-work");

    expect(result).toBeUndefined();
  });

  it("returns undefined when response is 404", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      status: 404,
      ok: false,
    });

    const result = await fetchImslpRawDoc("nonexistent-work");

    expect(result).toBeUndefined();
  });

  it("encodes work ID in URL", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ workId: "test work", title: "Test" }),
    });

    await fetchImslpRawDoc("test work");

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("test%20work"),
      expect.any(Object)
    );
  });
});
