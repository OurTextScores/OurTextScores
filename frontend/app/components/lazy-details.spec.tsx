import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import LazyDetails from "./lazy-details";
import "@testing-library/jest-dom";

describe("LazyDetails", () => {
    it("does not render children initially", () => {
        render(
            <LazyDetails summary={<summary>Summary</summary>}>
                <div data-testid="content">Content</div>
            </LazyDetails>
        );

        expect(screen.getByText("Summary")).toBeInTheDocument();
        expect(screen.queryByTestId("content")).not.toBeInTheDocument();
    });

    it("renders children when opened", () => {
        render(
            <LazyDetails summary={<summary>Summary</summary>}>
                <div data-testid="content">Content</div>
            </LazyDetails>
        );

        const details = screen.getByText("Summary").closest("details")!;
        fireEvent.toggle(details);

        expect(screen.getByTestId("content")).toBeInTheDocument();
    });

    it("keeps children rendered after closing", () => {
        render(
            <LazyDetails summary={<summary>Summary</summary>}>
                <div data-testid="content">Content</div>
            </LazyDetails>
        );

        const details = screen.getByText("Summary").closest("details")!;

        // Open
        fireEvent.toggle(details);
        expect(screen.getByTestId("content")).toBeInTheDocument();

        // Close (manually set open to false and fire toggle, mimicking browser behavior)
        details.open = false;
        fireEvent.toggle(details);

        // Content should still be in the DOM (just hidden by details behavior, but rendered by React)
        expect(screen.getByTestId("content")).toBeInTheDocument();
    });
});
