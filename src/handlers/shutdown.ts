import { execFile } from "node:child_process";
import { Logger } from "iii-sdk";
import { stopProxy } from "../proxy.js";

const TAILSCALE_CLI =
  process.platform === "darwin"
    ? "/Applications/Tailscale.app/Contents/MacOS/Tailscale"
    : "tailscale";

const SHUTDOWN_TIMEOUT_MS = 5_000;
const logger = new Logger(undefined, "tailclaude-shutdown");

let shuttingDown = false;

async function unpublishTailscale(): Promise<void> {
  return new Promise((resolve) => {
    execFile(
      TAILSCALE_CLI,
      ["serve", "--https=443", "off"],
      { timeout: 10_000 },
      (err, _stdout, stderr) => {
        if (err) {
          logger.error("Tailscale cleanup error", { error: stderr || err.message });
        } else {
          logger.info("Tailscale serve unpublished (HTTPS 443)");
        }
        resolve();
      },
    );
  });
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info("Shutting down TailClaude", { signal });

  const forceExit = setTimeout(() => {
    logger.error("Graceful shutdown timed out, forcing exit");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  try {
    await Promise.all([unpublishTailscale(), stopProxy()]);
  } catch {
    // best-effort cleanup
  }

  clearTimeout(forceExit);
  process.exit(0);
}

export function registerShutdownHandlers(): void {
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  logger.info("Shutdown handlers registered", { signals: ["SIGINT", "SIGTERM"] });
}
