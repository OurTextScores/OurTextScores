import { render, screen, act } from "@testing-library/react";
import { ElapsedTime, formatElapsed } from "./elapsed-time";

describe("formatElapsed", () => {
  it("reads as a reader would say it", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(9_000)).toBe("0:09");
    expect(formatElapsed(62_000)).toBe("1:02");
    expect(formatElapsed(59 * 60_000 + 59_000)).toBe("59:59");
    // Past an hour the hours appear rather than the minutes running past sixty.
    expect(formatElapsed(3_600_000)).toBe("1:00:00");
    expect(formatElapsed(3_723_000)).toBe("1:02:03");
  });

  it("floors to the second and never goes negative", () => {
    expect(formatElapsed(1_999)).toBe("0:01");
    // A clock a little behind the server's must not show a countdown.
    expect(formatElapsed(-5_000)).toBe("0:00");
  });
});

describe("ElapsedTime", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-09-10T12:00:30Z"));
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it("counts up once a second from the given start", () => {
    render(<ElapsedTime since="2026-09-10T12:00:00Z" />);
    expect(screen.getByTestId("elapsed-time")).toHaveTextContent("0:30");

    act(() => {
      jest.advanceTimersByTime(5_000);
    });
    expect(screen.getByTestId("elapsed-time")).toHaveTextContent("0:35");
  });

  it("renders nothing without a usable start", () => {
    const { rerender } = render(<ElapsedTime since={undefined} />);
    expect(screen.queryByTestId("elapsed-time")).not.toBeInTheDocument();
    // A run that never began, or a value the server did not send as a date.
    rerender(<ElapsedTime since="not a date" />);
    expect(screen.queryByTestId("elapsed-time")).not.toBeInTheDocument();
  });

  it("stops ticking when it goes away", () => {
    const clear = jest.spyOn(window, "clearInterval");
    const { unmount } = render(<ElapsedTime since="2026-09-10T12:00:00Z" />);
    unmount();
    expect(clear).toHaveBeenCalled();
    clear.mockRestore();
  });
});
