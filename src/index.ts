import "./iii.js";
import { Logger } from "iii-sdk";
import { useApi, useEvent, useCron } from "./hooks.js";
import { handleHealth } from "./handlers/health.js";
import { handleEngineStarted } from "./handlers/setup.js";
import { handleCleanup } from "./handlers/cleanup.js";
import { registerShutdownHandlers } from "./handlers/shutdown.js";
import { startProxy } from "./proxy.js";
import { registerChatStream } from "./streams.js";
import { indexSessions } from "./sessions.js";
import { state } from "./state.js";
import { pushActivity } from "./activity.js";
import { incrementUsage, cleanupOldUsage } from "./usage.js";
import { snapshotMetrics } from "./metrics-timeline.js";
import {
  writeCompletedTrace,
  writeStoppedTrace,
  cleanupOldTraces,
} from "./traces.js";
import { backfillSessionCosts } from "./session-costs.js";

const logger = new Logger(undefined, "tailclaude");

registerChatStream();

startProxy().catch((err) => {
  logger.error("Failed to start UI proxy", { error: err.message });
});

useApi(
  { api_path: "health", http_method: "GET", description: "Health check" },
  handleHealth,
);

useEvent("engine::started", handleEngineStarted, "Check Tailscale and publish");

useEvent(
  "chat::completed",
  async (data: {
    requestId: string;
    sessionId: string | null;
    model: string;
    cost: number;
    inputTokens: number;
    outputTokens: number;
    duration: number;
    exitCode?: number | null;
  }) => {
    if (!data.sessionId) return;
    try {
      await state.update({
        scope: "session_index",
        key: data.sessionId,
        ops: [
          {
            type: "set",
            path: "lastModified",
            value: new Date().toISOString(),
          },
          { type: "increment", path: "messageCount", by: 2 },
        ],
      });
    } catch {}
  },
  "Update session index on chat completion",
);

useEvent(
  "chat::started",
  async (data: {
    requestId: string;
    sessionId: string | null;
    model: string;
    mode: string;
    effort: string;
  }) => {
    pushActivity("chat_started", `Chat started (${data.model})`, {
      requestId: data.requestId,
      sessionId: data.sessionId,
      model: data.model,
    });
  },
  "Activity feed: chat started",
);

useEvent(
  "chat::completed",
  async (data: {
    requestId: string;
    sessionId: string | null;
    model: string;
    cost: number;
    inputTokens: number;
    outputTokens: number;
    duration: number;
    exitCode?: number | null;
  }) => {
    pushActivity(
      "chat_completed",
      `Chat completed — $${data.cost.toFixed(4)} in ${(data.duration / 1000).toFixed(1)}s`,
      {
        requestId: data.requestId,
        cost: data.cost,
        duration: data.duration,
        model: data.model,
      },
    );
  },
  "Activity feed: chat completed",
);

useEvent(
  "chat::completed",
  async (data: {
    requestId: string;
    sessionId: string | null;
    model: string;
    cost: number;
    inputTokens: number;
    outputTokens: number;
    duration: number;
  }) => {
    await incrementUsage(data.cost, data.inputTokens, data.outputTokens);
  },
  "Usage: increment daily stats on chat completion",
);

useEvent(
  "chat::completed",
  async (data: {
    requestId: string;
    sessionId: string | null;
    model: string;
    cost: number;
    inputTokens: number;
    outputTokens: number;
    duration: number;
    exitCode?: number | null;
  }) => {
    await writeCompletedTrace(data);
  },
  "Traces: write completed trace",
);

useEvent(
  "chat::stopped",
  async (data: { requestId: string; reason: string }) => {
    pushActivity("chat_stopped", `Chat stopped (${data.reason})`, {
      requestId: data.requestId,
      reason: data.reason,
    });
    await writeStoppedTrace(data);
  },
  "Activity feed + traces: chat stopped",
);

let lastSessionTotal = 0;

useEvent(
  "session::indexed",
  async (data: { total: number; added: number }) => {
    if (data.total !== lastSessionTotal) {
      pushActivity(
        "session_indexed",
        `Sessions indexed: ${data.total} found, ${data.added} new`,
        { total: data.total, added: data.added },
      );
      lastSessionTotal = data.total;
    }
  },
  "Activity feed: session indexed (only on change)",
);

useEvent(
  "cleanup::completed",
  async (data: Record<string, unknown>) => {
    pushActivity("cleanup", "Cleanup completed", data);
  },
  "Activity feed: cleanup completed",
);

useCron(
  "0 */30 * * * *",
  handleCleanup,
  "Cleanup stale sessions and orphaned state every 30 minutes",
);

useCron(
  "0 */5 * * * *",
  async () => {
    logger.info("Re-indexing sessions");
    await indexSessions();
    await backfillSessionCosts();
  },
  "Re-index terminal sessions and backfill costs every 5 minutes",
);

useCron(
  "0 */1 * * * *",
  async () => {
    await snapshotMetrics();
  },
  "Snapshot metrics and check overload thresholds every minute",
);

useCron(
  "0 0 */6 * * *",
  async () => {
    const [usageRemoved, tracesRemoved] = await Promise.all([
      cleanupOldUsage(),
      cleanupOldTraces(),
    ]);
    logger.info("Data cleanup", { usageRemoved, tracesRemoved });
  },
  "Cleanup old usage and trace data every 6 hours",
);

indexSessions()
  .then(() => backfillSessionCosts())
  .then((result) => {
    if (result.sessions > 0) {
      pushActivity(
        "session_indexed",
        `Backfilled ${result.sessions} sessions — $${result.totalCost.toFixed(2)} total cost`,
        { sessions: result.sessions, totalCost: result.totalCost },
      );
    }
  })
  .catch((err) => {
    logger.warn("Session indexing/backfill failed", { error: err?.message });
  });

registerShutdownHandlers();

logger.info(
  "TailClaude v0.2 worker registered — waiting for iii engine connection",
);
