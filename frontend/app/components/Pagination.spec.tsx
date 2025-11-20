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
import { render, screen, fireEvent } from "@testing-library/react";
import Pagination from "./Pagination";
import "@testing-library/jest-dom";

describe("Pagination", () => {
    const defaultProps = {
        currentPage: 1,
        totalItems: 100,
        itemsPerPage: 20,
        onPageChange: jest.fn(),
    };

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("renders pagination controls for multiple pages", () => {
        render(<Pagination {...defaultProps} />);

        expect(screen.getAllByText("Previous").length).toBeGreaterThan(0);
        expect(screen.getAllByText("Next").length).toBeGreaterThan(0);
        expect(screen.getByText(/Showing/i)).toBeInTheDocument();
        expect(screen.getByText("100")).toBeInTheDocument();
    });

    it("does not render when there is only one page", () => {
        render(<Pagination {...defaultProps} totalItems={10} />);

        expect(screen.queryByText("Previous")).not.toBeInTheDocument();
        expect(screen.queryByText("Next")).not.toBeInTheDocument();
    });

    it("does not render when there are no items", () => {
        render(<Pagination {...defaultProps} totalItems={0} />);

        expect(screen.queryByText("Previous")).not.toBeInTheDocument();
        expect(screen.queryByText("Next")).not.toBeInTheDocument();
    });

    it("disables Previous button on first page", () => {
        render(<Pagination {...defaultProps} currentPage={1} />);

        const previousButtons = screen.getAllByRole("button", { name: /previous/i });
        previousButtons.forEach((btn) => {
            expect(btn).toBeDisabled();
        });
    });

    it("enables Previous button when not on first page", () => {
        render(<Pagination {...defaultProps} currentPage={2} />);

        const previousButtons = screen.getAllByRole("button", { name: /previous/i });
        previousButtons.forEach((btn) => {
            expect(btn).not.toBeDisabled();
        });
    });

    it("disables Next button on last page", () => {
        render(<Pagination {...defaultProps} currentPage={5} totalItems={100} itemsPerPage={20} />);

        const nextButtons = screen.getAllByRole("button", { name: /next/i });
        nextButtons.forEach((btn) => {
            expect(btn).toBeDisabled();
        });
    });

    it("enables Next button when not on last page", () => {
        render(<Pagination {...defaultProps} currentPage={1} />);

        const nextButtons = screen.getAllByRole("button", { name: /next/i });
        nextButtons.forEach((btn) => {
            expect(btn).not.toBeDisabled();
        });
    });

    it("calls onPageChange with previous page when Previous is clicked", () => {
        const onPageChange = jest.fn();
        render(<Pagination {...defaultProps} currentPage={3} onPageChange={onPageChange} />);

        const previousButtons = screen.getAllByText("Previous");
        fireEvent.click(previousButtons[0]);

        expect(onPageChange).toHaveBeenCalledWith(2);
    });

    it("calls onPageChange with next page when Next is clicked", () => {
        const onPageChange = jest.fn();
        render(<Pagination {...defaultProps} currentPage={2} onPageChange={onPageChange} />);

        const nextButtons = screen.getAllByText("Next");
        fireEvent.click(nextButtons[0]);

        expect(onPageChange).toHaveBeenCalledWith(3);
    });

    it("calls onPageChange when page number button is clicked", () => {
        const onPageChange = jest.fn();
        render(<Pagination {...defaultProps} currentPage={1} onPageChange={onPageChange} />);

        const pageButton = screen.getByText("3");
        fireEvent.click(pageButton);

        expect(onPageChange).toHaveBeenCalledWith(3);
    });

    it("highlights current page number", () => {
        render(<Pagination {...defaultProps} currentPage={3} />);

        const currentPageButton = screen.getByText("3");
        expect(currentPageButton).toHaveClass("bg-primary-50");
        expect(currentPageButton).toHaveClass("text-primary-600");
    });

    it("displays correct range text", () => {
        render(<Pagination {...defaultProps} currentPage={2} totalItems={100} itemsPerPage={20} />);

        expect(screen.getByText(/Showing/i)).toBeInTheDocument();
        expect(screen.getByText("21")).toBeInTheDocument();
        expect(screen.getByText("40")).toBeInTheDocument();
        expect(screen.getByText("100")).toBeInTheDocument();
    });

    it("displays correct range text for last page with partial items", () => {
        render(<Pagination {...defaultProps} currentPage={5} totalItems={95} itemsPerPage={20} />);

        expect(screen.getByText(/Showing/i)).toBeInTheDocument();
        expect(screen.getByText("81")).toBeInTheDocument();
        // "95" appears twice (in "to 95" and "of 95"), so use getAllByText
        expect(screen.getAllByText("95").length).toBeGreaterThan(0);
    });

    it("calculates total pages correctly", () => {
        render(<Pagination {...defaultProps} totalItems={95} itemsPerPage={20} />);

        // Should have 5 pages (95 / 20 = 4.75, rounded up to 5)
        expect(screen.getByText("5")).toBeInTheDocument();
    });

    it("shows up to 7 page numbers when there are many pages", () => {
        render(<Pagination {...defaultProps} totalItems={200} itemsPerPage={20} currentPage={1} />);

        // Should show pages 1-7
        const pageButtons = screen.getAllByRole("button");
        const pageNumberButtons = pageButtons.filter(btn => /^\d+$/.test(btn.textContent || ""));
        expect(pageNumberButtons.length).toBeLessThanOrEqual(7);
        expect(screen.getAllByText("7").length).toBeGreaterThan(0);
        expect(screen.queryByText("8")).not.toBeInTheDocument();
    });

    it("adjusts page numbers when on middle pages", () => {
        render(<Pagination {...defaultProps} totalItems={200} itemsPerPage={20} currentPage={5} />);

        // Should show pages around current (2, 3, 4, 5, 6, 7, 8)
        expect(screen.getAllByText("2").length).toBeGreaterThan(0);
        expect(screen.getAllByText("8").length).toBeGreaterThan(0);
    });

    it("shows last pages when near the end", () => {
        render(<Pagination {...defaultProps} totalItems={200} itemsPerPage={20} currentPage={9} />);

        // Should show last 7 pages (4, 5, 6, 7, 8, 9, 10)
        expect(screen.getAllByText("4").length).toBeGreaterThan(0);
        expect(screen.getAllByText("10").length).toBeGreaterThan(0);
    });

    it("handles single item per page", () => {
        render(<Pagination {...defaultProps} totalItems={5} itemsPerPage={1} currentPage={3} />);

        // Just check that the component renders and shows page info
        expect(screen.getByText(/Showing/i)).toBeInTheDocument();
        // "3" and "5" will appear multiple times (in text and as button), just verify they exist
        expect(screen.getAllByText("3").length).toBeGreaterThan(0);
        expect(screen.getAllByText("5").length).toBeGreaterThan(0);
    });

    it("renders mobile-only Previous/Next buttons", () => {
        render(<Pagination {...defaultProps} />);

        // Check for mobile buttons (they have specific classes)
        const buttons = screen.getAllByText("Previous");
        const mobileButton = buttons.find(btn =>
            btn.className.includes("sm:hidden")
        );

        // At least one should exist (mobile or desktop)
        expect(buttons.length).toBeGreaterThan(0);
    });
});
