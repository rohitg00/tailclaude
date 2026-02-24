import type { ApiRequest, ApiResponse } from "iii-sdk";
import { state } from "../state.js";

type TailscaleState = {
  ip: string | null;
  connectedAt: string | null;
  error?: string;
};

type PublishedState = {
  url: string;
  publishedAt: string;
};

type Session = {
  id: string;
  model: string;
  createdAt: string;
  lastUsed: string;
  messageCount: number;
};

export const handleHealth = async (_req: ApiRequest): Promise<ApiResponse> => {
  let tailscale: TailscaleState | null = null;
  let published: PublishedState | null = null;
  let sessions: Session[] = [];

  try {
    [tailscale, published, sessions] = await Promise.all([
      state.get<TailscaleState>({ scope: "config", key: "tailscale" }),
      state.get<PublishedState>({ scope: "config", key: "published_url" }),
      state.list<Session>({ scope: "sessions" }),
    ]);
  } catch {
    // state store unavailable — return defaults
  }

  return {
    status_code: 200,
    headers: { "content-type": "application/json" },
    body: {
      status: "ok",
      service: "tailclaude",
      timestamp: new Date().toISOString(),
      tailscale: {
        connected: !!tailscale?.ip,
        ip: tailscale?.ip ?? null,
        connectedAt: tailscale?.connectedAt ?? null,
      },
      publishedUrl: published?.url ?? null,
      sessions: {
        active: sessions.length,
      },
    },
  };
};
