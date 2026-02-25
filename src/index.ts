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
  }) => {
    if (!data.sessionId) return;
    try {
      await state.update({
        scope: "session_index",
        key: data.sessionId,
        ops: [
          { type: "set", path: "lastModified", value: new Date().toISOString() },
          { type: "increment", path: "messageCount", by: 2 },
        ],
      });
    } catch {
      // session might not be indexed yet
    }
  },
  "Update session index on chat completion",
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
  },
  "Re-index terminal sessions every 5 minutes",
);

indexSessions().catch((err) => {
  logger.warn("Initial session indexing failed", { error: err?.message });
});

registerShutdownHandlers();

logger.info("TailClaude v0.1 worker registered — waiting for iii engine connection");
