"use client";

import { useEffect, useMemo, useRef } from "react";
import {
  trackScorePlayerEngagedClient,
  trackScorePlayerIframeLoadedClient,
} from "../../lib/analytics";
import { buildScoreEditorLaunchUrl } from "./score-editor-launch";

type PlayerEvent = {
  type: "ots-player:event";
  version: 1;
  playerId: string;
  event: string;
  detail?: Record<string, unknown>;
};

function scorePreviewPlayerId(sourceId: string): string {
  const safeSourceId = sourceId.replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 48);
  return `source-preview-${safeSourceId || "score"}`;
}

function isPlayerEvent(value: unknown, playerId: string): value is PlayerEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<PlayerEvent>;
  return candidate.type === "ots-player:event"
    && candidate.version === 1
    && candidate.playerId === playerId
    && typeof candidate.event === "string";
}

export default function ScorePlayerPreview({
  scoreUrl,
  sourceId,
  title,
}: {
  scoreUrl: string;
  sourceId: string;
  title: string;
}) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const loadStartedAtRef = useRef(Date.now());
  const engagementTrackedRef = useRef(false);
  const playerId = useMemo(() => scorePreviewPlayerId(sourceId), [sourceId]);
  const playerUrl = useMemo(() => buildScoreEditorLaunchUrl({
    scoreUrl,
    embed: true,
    playerId,
  }), [playerId, scoreUrl]);

  useEffect(() => {
    const handleMessage = (message: MessageEvent) => {
      if (message.origin !== window.location.origin
        || message.source !== iframeRef.current?.contentWindow
        || !isPlayerEvent(message.data, playerId)) {
        return;
      }
      if (message.data.event === "statechange"
        && message.data.detail?.state === "playing"
        && !engagementTrackedRef.current) {
        engagementTrackedRef.current = true;
        trackScorePlayerEngagedClient();
      }
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [playerId]);

  return (
    <iframe
      ref={iframeRef}
      data-testid="score-preview-frame"
      src={playerUrl}
      title={title}
      loading="lazy"
      allow="autoplay"
      onLoad={() => trackScorePlayerIframeLoadedClient({
        loadMs: Math.max(0, Date.now() - loadStartedAtRef.current),
      })}
      className="h-[min(70vh,44rem)] min-h-[24rem] w-full rounded-lg border border-slate-200 bg-white dark:border-slate-800"
    />
  );
}
