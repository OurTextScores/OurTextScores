import { fireEvent, render, screen } from "@testing-library/react";
import ScorePlayerPreview from "./score-player-preview";
import {
  trackScorePlayerEngagedClient,
  trackScorePlayerIframeLoadedClient,
} from "../../lib/analytics";

jest.mock("../../lib/analytics", () => ({
  trackScorePlayerEngagedClient: jest.fn(),
  trackScorePlayerIframeLoadedClient: jest.fn(),
}));

const mockedTrackEngaged = jest.mocked(trackScorePlayerEngagedClient);
const mockedTrackLoaded = jest.mocked(trackScorePlayerIframeLoadedClient);

describe("ScorePlayerPreview", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("loads the dedicated player and records iframe readiness", () => {
    render(
      <ScorePlayerPreview
        scoreUrl="http://localhost:4000/api/works/work-1/sources/source-1/canonical.xml"
        sourceId="source-1"
        title="Playback of Full score"
      />,
    );

    const frame = screen.getByTitle("Playback of Full score");
    const src = new URL(frame.getAttribute("src") || "", window.location.origin);
    expect(src.searchParams.get("embed")).toBe("player");
    expect(src.searchParams.get("playerId")).toBe("source-preview-source-1");
    expect(frame).toHaveAttribute("allow", "autoplay");

    fireEvent.load(frame);
    expect(mockedTrackLoaded).toHaveBeenCalledWith({ loadMs: expect.any(Number) });
  });

  it("records the first valid playing event and rejects other messages", () => {
    render(
      <ScorePlayerPreview
        scoreUrl="/api/works/work-1/sources/source-1/canonical.xml"
        sourceId="source-1"
        title="Playback of Full score"
      />,
    );
    const frame = screen.getByTitle("Playback of Full score") as HTMLIFrameElement;
    const playingEvent = {
      type: "ots-player:event",
      version: 1,
      playerId: "source-preview-source-1",
      event: "statechange",
      detail: { state: "playing" },
    };

    window.dispatchEvent(new MessageEvent("message", {
      data: { ...playingEvent, playerId: "another-player" },
      origin: window.location.origin,
      source: frame.contentWindow,
    }));
    window.dispatchEvent(new MessageEvent("message", {
      data: playingEvent,
      origin: "https://attacker.example",
      source: frame.contentWindow,
    }));
    expect(mockedTrackEngaged).not.toHaveBeenCalled();

    window.dispatchEvent(new MessageEvent("message", {
      data: playingEvent,
      origin: window.location.origin,
      source: frame.contentWindow,
    }));
    window.dispatchEvent(new MessageEvent("message", {
      data: playingEvent,
      origin: window.location.origin,
      source: frame.contentWindow,
    }));
    expect(mockedTrackEngaged).toHaveBeenCalledTimes(1);
  });
});
