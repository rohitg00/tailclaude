import "./iii.js";
import { useApi, useEvent, useCron } from "./hooks.js";
import { handleHealth } from "./handlers/health.js";
import { handleEngineStarted } from "./handlers/setup.js";
import { handleCleanup } from "./handlers/cleanup.js";
import { registerShutdownHandlers } from "./handlers/shutdown.js";
import { startProxy } from "./proxy.js";

startProxy().catch((err) => {
  console.error(`Failed to start UI proxy: ${err.message}`);
});

useApi(
  { api_path: "health", http_method: "GET", description: "Health check" },
  handleHealth,
);

useEvent("engine::started", handleEngineStarted, "Check Tailscale and publish");

useCron(
  "0 */30 * * * *",
  handleCleanup,
  "Cleanup stale sessions every 30 minutes",
);

registerShutdownHandlers();

console.log(
  "TailClaude v0.1 worker registered — waiting for iii engine connection",
);
