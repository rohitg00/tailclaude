import { execFile } from "node:child_process";
import { stopProxy } from "../proxy.js";

const TAILSCALE_CLI =
  process.platform === "darwin"
    ? "/Applications/Tailscale.app/Contents/MacOS/Tailscale"
    : "tailscale";

const SHUTDOWN_TIMEOUT_MS = 5_000;

let shuttingDown = false;

async function unpublishTailscale(): Promise<void> {
  return new Promise((resolve) => {
    execFile(
      TAILSCALE_CLI,
      ["serve", "--https=443", "off"],
      { timeout: 10_000 },
      (err, _stdout, stderr) => {
        if (err) {
          console.error(`Tailscale cleanup error: ${stderr || err.message}`);
        } else {
          console.log("Tailscale serve unpublished (HTTPS 443)");
        }
        resolve();
      },
    );
  });
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`\n${signal} received — shutting down TailClaude`);

  const forceExit = setTimeout(() => {
    console.error("Graceful shutdown timed out, forcing exit");
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
  console.log("Shutdown handlers registered (SIGINT, SIGTERM)");
}
