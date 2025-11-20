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

import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import SearchBox from "./SearchBox";
import "@testing-library/jest-dom";

describe("SearchBox", () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.runOnlyPendingTimers();
        jest.useRealTimers();
    });

    it("renders with placeholder text", () => {
        const onSearch = jest.fn();
        render(<SearchBox onSearch={onSearch} placeholder="Search works..." />);

        expect(screen.getByPlaceholderText("Search works...")).toBeInTheDocument();
    });

    it("renders with default placeholder", () => {
        const onSearch = jest.fn();
        render(<SearchBox onSearch={onSearch} />);

        expect(screen.getByPlaceholderText("Search...")).toBeInTheDocument();
    });

    it("displays search icon", () => {
        const onSearch = jest.fn();
        render(<SearchBox onSearch={onSearch} />);

        const svg = screen.getByRole("textbox").parentElement?.querySelector("svg");
        expect(svg).toBeInTheDocument();
    });

    it("calls onSearch after debounce period", async () => {
        const onSearch = jest.fn();
        const debounceMs = 300;
        render(<SearchBox onSearch={onSearch} debounceMs={debounceMs} />);

        const input = screen.getByRole("textbox");
        fireEvent.change(input, { target: { value: "Bach" } });

        // Should not call immediately
        expect(onSearch).not.toHaveBeenCalled();

        // Fast-forward time
        jest.advanceTimersByTime(debounceMs);

        await waitFor(() => {
            expect(onSearch).toHaveBeenCalledWith("Bach");
            expect(onSearch).toHaveBeenCalledTimes(1);
        });
    });

    it("debounces multiple rapid changes", async () => {
        const onSearch = jest.fn();
        const debounceMs = 300;
        render(<SearchBox onSearch={onSearch} debounceMs={debounceMs} />);

        const input = screen.getByRole("textbox");

        // Type multiple characters rapidly
        fireEvent.change(input, { target: { value: "B" } });
        jest.advanceTimersByTime(100);
        fireEvent.change(input, { target: { value: "Ba" } });
        jest.advanceTimersByTime(100);
        fireEvent.change(input, { target: { value: "Bac" } });
        jest.advanceTimersByTime(100);
        fireEvent.change(input, { target: { value: "Bach" } });

        // Should still not have called yet
        expect(onSearch).not.toHaveBeenCalled();

        // Fast-forward past debounce period
        jest.advanceTimersByTime(debounceMs);

        await waitFor(() => {
            // Should only call once with final value
            expect(onSearch).toHaveBeenCalledWith("Bach");
            expect(onSearch).toHaveBeenCalledTimes(1);
        });
    });

    it("shows clear button when input has value", () => {
        const onSearch = jest.fn();
        render(<SearchBox onSearch={onSearch} />);

        const input = screen.getByRole("textbox");

        // Initially no clear button
        expect(screen.queryByLabelText("Clear search")).not.toBeInTheDocument();

        // Add text
        fireEvent.change(input, { target: { value: "test" } });

        // Clear button should appear
        expect(screen.getByLabelText("Clear search")).toBeInTheDocument();
    });

    it("clears input when clear button is clicked", async () => {
        const onSearch = jest.fn();
        const debounceMs = 300;
        render(<SearchBox onSearch={onSearch} debounceMs={debounceMs} />);

        const input = screen.getByRole("textbox") as HTMLInputElement;

        // Add text
        fireEvent.change(input, { target: { value: "test" } });
        expect(input.value).toBe("test");

        // Click clear button
        const clearButton = screen.getByLabelText("Clear search");
        fireEvent.click(clearButton);

        // Input should be cleared
        expect(input.value).toBe("");

        // Should trigger search with empty string after debounce
        jest.advanceTimersByTime(debounceMs);
        await waitFor(() => {
            expect(onSearch).toHaveBeenCalledWith("");
        });
    });

    it("uses custom debounce time", async () => {
        const onSearch = jest.fn();
        const customDebounce = 500;
        render(<SearchBox onSearch={onSearch} debounceMs={customDebounce} />);

        const input = screen.getByRole("textbox");
        fireEvent.change(input, { target: { value: "test" } });

        // Should not call before custom debounce period
        jest.advanceTimersByTime(300);
        expect(onSearch).not.toHaveBeenCalled();

        // Should call after custom debounce period
        jest.advanceTimersByTime(200);
        await waitFor(() => {
            expect(onSearch).toHaveBeenCalledWith("test");
        });
    });

    it("updates input value controlled by component", () => {
        const onSearch = jest.fn();
        render(<SearchBox onSearch={onSearch} initialValue="initial" />);

        const input = screen.getByRole("textbox") as HTMLInputElement;
        expect(input.value).toBe("initial");

        fireEvent.change(input, { target: { value: "updated" } });
        expect(input.value).toBe("updated");
    });

    it("handles empty string input", async () => {
        const onSearch = jest.fn();
        const debounceMs = 300;
        render(<SearchBox onSearch={onSearch} debounceMs={debounceMs} initialValue="test" />);

        const input = screen.getByRole("textbox");
        fireEvent.change(input, { target: { value: "" } });

        jest.advanceTimersByTime(debounceMs);

        await waitFor(() => {
            expect(onSearch).toHaveBeenCalledWith("");
        });
    });
});
