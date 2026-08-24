"use client";

import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import PlayerClient, {
  buildStandalonePlayerUrl,
  normalizeRemoteScoreUrl,
} from "./player-client";

const replace = jest.fn();

jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
}));

describe("standalone score player", () => {
  const createObjectURL = jest.fn();
  const revokeObjectURL = jest.fn();

  beforeEach(() => {
    replace.mockReset();
    createObjectURL.mockReset();
    revokeObjectURL.mockReset();
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: createObjectURL,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: revokeObjectURL,
    });
  });

  it("builds the dedicated player URL without changing the score source", () => {
    const src = buildStandalonePlayerUrl(
      "https://raw.githubusercontent.com/OpenScore/StringQuartets/main/score.mxl?download=1",
    );
    const url = new URL(src, "https://www.ourtextscores.com");

    expect(url.pathname).toBe("/score-editor/index.html");
    expect(url.searchParams.get("embed")).toBe("player");
    expect(url.searchParams.get("playerId")).toBe("standalone-player");
    expect(url.searchParams.get("score")).toBe(
      "https://raw.githubusercontent.com/OpenScore/StringQuartets/main/score.mxl?download=1",
    );
  });

  it("accepts http(s) and same-origin paths but rejects unsafe URL schemes", () => {
    expect(normalizeRemoteScoreUrl(" https://example.org/score.mxl ")).toBe(
      "https://example.org/score.mxl",
    );
    expect(normalizeRemoteScoreUrl("/scores/example.musicxml")).toBe(
      "/scores/example.musicxml",
    );
    expect(normalizeRemoteScoreUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeRemoteScoreUrl("//example.org/score.mxl")).toBeNull();
  });

  it("opens the score supplied in the page URL", () => {
    render(<PlayerClient initialScoreUrl="https://example.org/quartet.mxl" />);

    const frame = screen.getByTitle("Playback of quartet.mxl");
    const src = new URL(frame.getAttribute("src")!, "https://www.ourtextscores.com");
    expect(src.searchParams.get("score")).toBe("https://example.org/quartet.mxl");
    expect(screen.getAllByText("Score URL")).toHaveLength(2);
  });

  it("opens a pasted URL and writes a shareable player URL", async () => {
    const user = userEvent.setup();
    render(<PlayerClient initialScoreUrl="" />);

    await user.type(
      screen.getByRole("textbox", { name: "Score URL" }),
      "https://example.org/score.musicxml",
    );
    await user.click(screen.getByRole("button", { name: "Open URL" }));

    expect(screen.getByTitle("Playback of score.musicxml")).toBeInTheDocument();
    expect(replace).toHaveBeenCalledWith(
      "/player?score=https%3A%2F%2Fexample.org%2Fscore.musicxml",
      { scroll: false },
    );
  });

  it("loads local files through revocable browser object URLs", async () => {
    const user = userEvent.setup();
    createObjectURL
      .mockReturnValueOnce("blob:https://www.ourtextscores.com/first")
      .mockReturnValueOnce("blob:https://www.ourtextscores.com/second");
    const view = render(<PlayerClient initialScoreUrl="" />);
    const input = screen.getByLabelText("Load file");

    await user.upload(
      input,
      new File(["<score-partwise />"], "first.musicxml", {
        type: "application/vnd.recordare.musicxml+xml",
      }),
    );
    expect(screen.getByTitle("Playback of first.musicxml")).toHaveAttribute(
      "src",
      expect.stringContaining("blob%3Ahttps%3A%2F%2Fwww.ourtextscores.com%2Ffirst"),
    );
    expect(screen.getByText("Local file")).toBeInTheDocument();
    expect(replace).toHaveBeenLastCalledWith("/player", { scroll: false });

    await user.upload(
      input,
      new File(["<score-partwise />"], "second.xml", {
        type: "application/xml",
      }),
    );
    expect(revokeObjectURL).toHaveBeenCalledWith(
      "blob:https://www.ourtextscores.com/first",
    );

    view.unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith(
      "blob:https://www.ourtextscores.com/second",
    );
  });

  it("rejects unsupported local file types", () => {
    render(<PlayerClient initialScoreUrl="" />);

    fireEvent.change(screen.getByLabelText("Load file"), {
      target: { files: [new File(["PDF"], "score.pdf", { type: "application/pdf" })] },
    });

    expect(screen.getByRole("alert")).toHaveTextContent("Choose a MusicXML");
    expect(createObjectURL).not.toHaveBeenCalled();
  });
});
