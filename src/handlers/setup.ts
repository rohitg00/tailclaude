import { execFile } from "node:child_process";
import type { Context } from "iii-sdk";
import QRCode from "qrcode";
import { state } from "../state.js";

const TAILSCALE_CLI =
  process.platform === "darwin"
    ? "/Applications/Tailscale.app/Contents/MacOS/Tailscale"
    : "tailscale";

const TARGET = "http://127.0.0.1:3110";

export const handleEngineStarted = async (
  _data: unknown,
  ctx: Context,
): Promise<void> => {
  ctx.logger.info("Engine started — checking Tailscale status");

  try {
    const ip = await runCommand("tailscale", ["ip", "-4"]);
    ctx.logger.info(`Tailscale IP: ${ip.trim()}`);

    await state.set({
      scope: "config",
      key: "tailscale",
      data: { ip: ip.trim(), connectedAt: new Date().toISOString() },
    });

    await publishToTailscale(ctx);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.logger.warn(`Tailscale not available: ${msg}`);
    ctx.logger.info("Running in local-only mode at http://127.0.0.1:3110");

    await state.set({
      scope: "config",
      key: "tailscale",
      data: { ip: null, connectedAt: null, error: msg },
    });
  }
};

async function publishToTailscale(ctx: Context): Promise<void> {
  const existing = await checkExistingServe();
  if (existing) {
    ctx.logger.info(
      "Tailscale serve already active, reusing existing listener",
    );
  } else {
    await attemptServe(ctx);
  }

  const verified = await verifyServeStatus(ctx);
  if (!verified) {
    ctx.logger.warn(
      "Tailscale serve status verification failed — proxy may not be active",
    );
  }

  const statusJson = await runCommand("tailscale", ["status", "--json"]);
  const parsed = JSON.parse(statusJson);
  const hostname = parsed.Self?.HostName ?? "unknown";
  const dnsName = parsed.Self?.DNSName?.replace(/\.$/, "");
  const url = dnsName ? `https://${dnsName}` : `https://${hostname}.ts.net`;

  await state.set({
    scope: "config",
    key: "published_url",
    data: { url, publishedAt: new Date().toISOString() },
  });

  ctx.logger.info(`Published to Tailscale: ${url}`);
  ctx.logger.info("Access TailClaude from any device on your tailnet");

  try {
    const qr = await QRCode.toString(url, { type: "terminal", small: true });
    console.log("\n" + qr);
    console.log(`  Scan to open: ${url}\n`);
  } catch {
    // QR generation is best-effort
  }
}

function matchesProxyTarget(json: string): boolean {
  return (
    json.includes("3110") || json.includes("3111") || json.includes(TARGET)
  );
}

async function checkExistingServe(): Promise<boolean> {
  try {
    const raw = await runCommand("tailscale", ["serve", "status", "--json"]);
    const status = JSON.parse(raw);
    const tcp = status?.TCP ?? status?.Web;
    if (!tcp) return false;
    return matchesProxyTarget(JSON.stringify(tcp));
  } catch {
    return false;
  }
}

async function attemptServe(ctx: Context): Promise<void> {
  try {
    await runCommand("tailscale", [
      "serve",
      "--bg",
      "--yes",
      "--https=443",
      TARGET,
    ]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("already") || msg.includes("listener")) {
      ctx.logger.warn("Port conflict detected, clearing and retrying");
      try {
        await runCommand("tailscale", ["serve", "--https=443", "off"]);
      } catch {
        // ignore cleanup errors
      }
      await runCommand("tailscale", [
        "serve",
        "--bg",
        "--yes",
        "--https=443",
        TARGET,
      ]);
    } else {
      throw err;
    }
  }
}

async function verifyServeStatus(ctx: Context): Promise<boolean> {
  for (let i = 0; i < 3; i++) {
    try {
      const raw = await runCommand("tailscale", ["serve", "status", "--json"]);
      const status = JSON.parse(raw);
      if (matchesProxyTarget(JSON.stringify(status))) {
        ctx.logger.info("Tailscale serve status verified");
        return true;
      }
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

function runCommand(cmd: string, args: string[]): Promise<string> {
  const bin = cmd === "tailscale" ? TAILSCALE_CLI : cmd;
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 15_000 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr || err.message));
        return;
      }
      resolve(stdout);
    });
  });
}
