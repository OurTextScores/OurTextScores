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

import { searchWorks } from "./api";
import "@testing-library/jest-dom";

// Mock fetch globally
global.fetch = jest.fn();

describe("searchWorks", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("returns empty results when query is empty", async () => {
        const result = await searchWorks("");

        expect(result).toEqual({
            works: [],
            total: 0,
            limit: 20,
            offset: 0,
            query: "",
        });

        // Should not make API call
        expect(fetch).not.toHaveBeenCalled();
    });

    it("returns empty results when query is whitespace only", async () => {
        const result = await searchWorks("   ");

        expect(result).toEqual({
            works: [],
            total: 0,
            limit: 20,
            offset: 0,
            query: "",
        });

        expect(fetch).not.toHaveBeenCalled();
    });

    it("correctly maps backend response to frontend format", async () => {
        const mockBackendResponse = {
            hits: [
                {
                    workId: "12345",
                    title: "Cello Suite No.1",
                    composer: "Bach, Johann Sebastian",
                    catalogNumber: "BWV 1007",
                    sourceCount: 3,
                    availableFormats: ["mxl", "xml"],
                    latestRevisionAt: "2023-10-01T00:00:00Z",
                },
            ],
            estimatedTotalHits: 1,
            processingTimeMs: 15,
            query: "Bach",
        };

        (fetch as jest.Mock).mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => mockBackendResponse,
        });

        const result = await searchWorks("Bach");

        expect(result).toEqual({
            works: mockBackendResponse.hits,
            total: mockBackendResponse.estimatedTotalHits,
            limit: 20,
            offset: 0,
            query: "Bach",
        });
    });

    it("includes custom limit and offset in request", async () => {
        const mockBackendResponse = {
            hits: [],
            estimatedTotalHits: 0,
            processingTimeMs: 5,
            query: "test",
        };

        (fetch as jest.Mock).mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => mockBackendResponse,
        });

        await searchWorks("test", { limit: 50, offset: 100 });

        expect(fetch).toHaveBeenCalledWith(
            expect.stringContaining("limit=50"),
            expect.anything()
        );
        expect(fetch).toHaveBeenCalledWith(
            expect.stringContaining("offset=100"),
            expect.anything()
        );
    });

    it("includes sort parameter in request when provided", async () => {
        const mockBackendResponse = {
            hits: [],
            estimatedTotalHits: 0,
            processingTimeMs: 5,
            query: "test",
        };

        (fetch as jest.Mock).mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => mockBackendResponse,
        });

        await searchWorks("test", { sort: "latestRevisionAt:desc" });

        expect(fetch).toHaveBeenCalledWith(
            expect.stringContaining("sort=latestRevisionAt%3Adesc"),
            expect.anything()
        );
    });

    it("uses default limit and offset when not provided", async () => {
        const mockBackendResponse = {
            hits: [],
            estimatedTotalHits: 0,
            processingTimeMs: 5,
            query: "test",
        };

        (fetch as jest.Mock).mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => mockBackendResponse,
        });

        const result = await searchWorks("test");

        expect(result.limit).toBe(20);
        expect(result.offset).toBe(0);
    });

    it("handles API errors gracefully", async () => {
        (fetch as jest.Mock).mockResolvedValueOnce({
            ok: false,
            status: 500,
            text: async () => "Internal Server Error",
        });

        await expect(searchWorks("test")).rejects.toThrow();
    });

    it("returns empty results on error in production", async () => {
        // Temporarily set NODE_ENV to production
        const originalEnv = process.env.NODE_ENV;
        Object.defineProperty(process.env, 'NODE_ENV', {
            value: 'production',
            writable: true,
            configurable: true
        });

        (fetch as jest.Mock).mockResolvedValueOnce({
            ok: false,
            status: 500,
            text: async () => "Internal Server Error",
        });

        const result = await searchWorks("test");

        expect(result).toEqual({
            works: [],
            total: 0,
            limit: 20,
            offset: 0,
            query: "test",
        });

        // Restore original NODE_ENV
        Object.defineProperty(process.env, 'NODE_ENV', {
            value: originalEnv,
            writable: true,
            configurable: true
        });
    });

    it("trims whitespace from query", async () => {
        const mockBackendResponse = {
            hits: [],
            estimatedTotalHits: 0,
            processingTimeMs: 5,
            query: "test",
        };

        (fetch as jest.Mock).mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => mockBackendResponse,
        });

        await searchWorks("  test  ");

        expect(fetch).toHaveBeenCalledWith(
            expect.stringContaining("q=test"),
            expect.anything()
        );
    });

    it("includes Accept header in request", async () => {
        const mockBackendResponse = {
            hits: [],
            estimatedTotalHits: 0,
            processingTimeMs: 5,
            query: "test",
        };

        (fetch as jest.Mock).mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => mockBackendResponse,
        });

        await searchWorks("test");

        expect(fetch).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({
                headers: expect.objectContaining({
                    Accept: "application/json",
                }),
            })
        );
    });

    it("handles multiple works in response", async () => {
        const mockBackendResponse = {
            hits: [
                {
                    workId: "1",
                    title: "Work 1",
                    composer: "Composer 1",
                    sourceCount: 1,
                    availableFormats: ["mxl"],
                },
                {
                    workId: "2",
                    title: "Work 2",
                    composer: "Composer 2",
                    sourceCount: 2,
                    availableFormats: ["xml"],
                },
            ],
            estimatedTotalHits: 2,
            processingTimeMs: 10,
            query: "test",
        };

        (fetch as jest.Mock).mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => mockBackendResponse,
        });

        const result = await searchWorks("test");

        expect(result.works).toHaveLength(2);
        expect(result.total).toBe(2);
        expect(result.works[0].workId).toBe("1");
        expect(result.works[1].workId).toBe("2");
    });

    it("preserves query from backend response", async () => {
        const mockBackendResponse = {
            hits: [],
            estimatedTotalHits: 0,
            processingTimeMs: 5,
            query: "normalized query from backend",
        };

        (fetch as jest.Mock).mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => mockBackendResponse,
        });

        const result = await searchWorks("test");

        expect(result.query).toBe("normalized query from backend");
    });
});
