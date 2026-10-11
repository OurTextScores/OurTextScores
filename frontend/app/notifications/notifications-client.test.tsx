import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";

import { hydrationProblems } from "../test-utils";
import NotificationsClient from "./notifications-client";

const notifications = [
  {
    notificationId: "n1",
    type: "new_revision" as const,
    workId: "12745",
    sourceId: "source-1",
    payload: {},
    actorUsername: "felix",
    read: false,
    // The server component passes what the API sent: a string, though the type says Date.
    createdAt: "2026-03-07T16:05:00.000Z" as unknown as Date,
  },
];

describe("NotificationsClient", () => {
  it("hydrates cleanly for a reader whose locale is not the server's", async () => {
    // Each notification's time used to be written in the reader's locale while rendering,
    // which did not match the server's HTML on a direct load of the page.
    expect(await hydrationProblems(<NotificationsClient initialNotifications={notifications} />)).toEqual([]);
  });

  it("shows when each notification happened, in the reader's form", () => {
    jest.spyOn(Date.prototype, "toLocaleString").mockReturnValue("7 Mar 2026, 08:05");

    render(<NotificationsClient initialNotifications={notifications} />);

    expect(screen.getByText("7 Mar 2026, 08:05")).toBeInTheDocument();
    jest.restoreAllMocks();
  });
});
