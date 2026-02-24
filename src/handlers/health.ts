import type { ApiRequest, ApiResponse } from "iii-sdk";
import { getEngineConnectionState } from "../iii.js";
import { state } from "../state.js";
import { getSessionIndex } from "../sessions.js";
import { metricsCollector } from "../metrics.js";

type TailscaleState = {
  ip: string | null;
  connectedAt: string | null;
  error?: string;
};

type PublishedState = {
  url: string;
  publishedAt: string;
};

export const handleHealth = async (_req: ApiRequest): Promise<ApiResponse> => {
  let tailscale: TailscaleState | null = null;
  let published: PublishedState | null = null;
  let activeChats: unknown[] = [];
  let sessionCount = 0;

  try {
    [tailscale, published, activeChats, sessionCount] = await Promise.all([
      state.get<TailscaleState>({ scope: "config", key: "tailscale" }),
      state.get<PublishedState>({ scope: "config", key: "published_url" }),
      state.list({ scope: "active_chats" }),
      getSessionIndex().then((s) => s.length),
    ]);
  } catch {
    // state store unavailable
  }

  const connectionState = getEngineConnectionState();
  const workerMetrics = metricsCollector.collect();

  return {
    status_code: 200,
    headers: { "content-type": "application/json" },
    body: {
      status: "ok",
      service: "tailclaude",
      timestamp: new Date().toISOString(),
      engine: {
        connected: connectionState === "connected",
        state: connectionState,
      },
      tailscale: {
        connected: !!tailscale?.ip,
        ip: tailscale?.ip ?? null,
        connectedAt: tailscale?.connectedAt ?? null,
      },
      publishedUrl: published?.url ?? null,
      sessions: {
        active: activeChats.length,
        total: sessionCount,
      },
      worker: {
        memory_heap_used: workerMetrics.memory_heap_used,
        memory_rss: workerMetrics.memory_rss,
        cpu_percent: workerMetrics.cpu_percent,
        event_loop_lag_ms: workerMetrics.event_loop_lag_ms,
        uptime_seconds: workerMetrics.uptime_seconds,
      },
    },
  };
};
