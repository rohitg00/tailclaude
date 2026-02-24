import {
  createServer,
  request as httpRequest,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import QRCode from "qrcode";
import { Logger } from "iii-sdk";
import { withSpan } from "iii-sdk/telemetry";
import {
  getEngineConnectionState,
  onEngineConnectionStateChange,
} from "./iii.js";
import { state } from "./state.js";
import { emit } from "./hooks.js";
import { writeChatEvent, deleteChatGroup } from "./streams.js";
import { getSessionIndex, getSessionFilePath } from "./sessions.js";
import { metricsCollector } from "./metrics.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const III_PORT = 3111;
const PROXY_PORT = 3110;
const isProduction = process.env.NODE_ENV === "production";
const API_TOKEN = process.env.TAILCLAUDE_TOKEN || null;
const MAX_BODY_BYTES = 1_000_000;

const logger = new Logger(undefined, "tailclaude-proxy");

let cachedHtml: string | null = null;

const CLAUDE_PATH =
  process.platform === "darwin"
    ? `${process.env.HOME}/.local/bin/claude`
    : "claude";

const TAILSCALE_CLI =
  process.platform === "darwin"
    ? "/Applications/Tailscale.app/Contents/MacOS/Tailscale"
    : "tailscale";

const ALLOWED_MODELS = new Set(["sonnet", "opus", "haiku"]);
const ALLOWED_MODES = new Set([
  "default",
  "plan",
  "acceptEdits",
  "bypassPermissions",
  "dontAsk",
]);
const ALLOWED_EFFORTS = new Set(["low", "medium", "high"]);

let engineConnected = false;
let engineConnectionState = "disconnected";

onEngineConnectionStateChange((s) => {
  engineConnected = s === "connected";
  engineConnectionState = s;
  logger.info("Engine connection state changed", { state: s });
});

function loadHtml(): string {
  if (!cachedHtml || !isProduction) {
    cachedHtml = readFileSync(resolve(__dirname, "ui.html"), "utf-8");
  }
  return cachedHtml;
}

async function getTailscaleUrl(): Promise<string> {
  try {
    const published = await state.get<{ url: string }>({
      scope: "config",
      key: "published_url",
    });
    if (published?.url) return published.url;
  } catch {
    // state unavailable, fall through
  }

  return new Promise((resolve) => {
    execFile(
      TAILSCALE_CLI,
      ["status", "--json"],
      { timeout: 5000 },
      (err, stdout) => {
        if (err) {
          resolve("https://tailclaude.local");
          return;
        }
        try {
          const parsed = JSON.parse(stdout);
          const dnsName = parsed.Self?.DNSName?.replace(/\.$/, "");
          const hostname = parsed.Self?.HostName ?? "unknown";
          resolve(
            dnsName ? `https://${dnsName}` : `https://${hostname}.ts.net`,
          );
        } catch {
          resolve("https://tailclaude.local");
        }
      },
    );
  });
}

function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, val] of Object.entries(process.env)) {
    if (
      val &&
      !key.startsWith("CLAUDE") &&
      !key.startsWith("III_") &&
      key !== "TAILCLAUDE_TOKEN"
    ) {
      env[key] = val;
    }
  }
  return env;
}

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, authorization",
  };
}

function checkAuth(req: IncomingMessage, res: ServerResponse): boolean {
  if (!API_TOKEN) return true;
  const auth = req.headers["authorization"] || "";
  if (auth !== `Bearer ${API_TOKEN}`) {
    res.writeHead(401, {
      ...corsHeaders(),
      "content-type": "application/json",
    });
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return false;
  }
  return true;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      data += chunk.toString();
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function jsonError(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, {
    ...corsHeaders(),
    "content-type": "application/json",
  });
  res.end(JSON.stringify({ error: message }));
}

const activeProcesses = new Map<string, ChildProcess>();

function handleChat(req: IncomingMessage, res: ServerResponse): void {
  readBody(req)
    .then((rawBody) => {
      let body: {
        sessionId?: string;
        message: string;
        model?: string;
        mode?: string;
        effort?: string;
        maxBudget?: number;
        systemPrompt?: string;
      };

      try {
        body = JSON.parse(rawBody);
      } catch {
        jsonError(res, 400, "Invalid JSON body");
        return;
      }

      if (!body.message) {
        jsonError(res, 400, "Missing message");
        return;
      }

      if (body.model && !ALLOWED_MODELS.has(body.model)) {
        jsonError(res, 400, "Invalid model");
        return;
      }
      if (body.mode && !ALLOWED_MODES.has(body.mode)) {
        jsonError(res, 400, "Invalid permission mode");
        return;
      }
      if (body.effort && !ALLOWED_EFFORTS.has(body.effort)) {
        jsonError(res, 400, "Invalid effort level");
        return;
      }
      if (body.sessionId && !/^[\w-]{1,128}$/.test(body.sessionId)) {
        jsonError(res, 400, "Invalid session ID format");
        return;
      }
      if (body.maxBudget !== undefined) {
        const budget = Number(body.maxBudget);
        if (!isFinite(budget) || budget < 0 || budget > 100) {
          jsonError(res, 400, "Invalid budget (0-100)");
          return;
        }
      }
      if (body.systemPrompt && body.systemPrompt.length > 10_000) {
        jsonError(res, 400, "System prompt too long (max 10000 chars)");
        return;
      }

      const requestId = randomUUID();
      const model = body.model || "sonnet";
      const mode = body.mode || "default";
      const effort = body.effort || "medium";

      withSpan("chat.request", { kind: 1 }, async (span) => {
        span.setAttribute("chat.request_id", requestId);
        span.setAttribute("chat.model", model);
        span.setAttribute("chat.session_id", body.sessionId || "new");
        span.setAttribute("chat.mode", mode);
        span.setAttribute("chat.effort", effort);

        logger.info("Chat started", {
          requestId,
          model,
          sessionId: body.sessionId,
          mode,
          effort,
        });

        await emit("chat::started", {
          requestId,
          sessionId: body.sessionId || null,
          model,
          mode,
          effort,
        });

        await state.set({
          scope: "active_chats",
          key: requestId,
          data: {
            sessionId: body.sessionId || null,
            model,
            startedAt: new Date().toISOString(),
            pid: null as number | null,
          },
        });

        res.writeHead(200, {
          ...corsHeaders(),
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });

        const args: string[] = [
          "-p",
          body.message,
          "--output-format",
          "stream-json",
          "--verbose",
        ];

        if (body.sessionId) args.push("--resume", body.sessionId);
        if (body.model) args.push("--model", body.model);
        if (body.mode) args.push("--permission-mode", body.mode);
        if (body.effort) args.push("--effort", body.effort);
        if (body.maxBudget !== undefined && body.maxBudget !== null) {
          args.push("--max-budget-usd", String(body.maxBudget));
        }
        if (body.systemPrompt) {
          args.push("--append-system-prompt", body.systemPrompt);
        }

        const env = cleanEnv();
        const child = spawn(CLAUDE_PATH, args, {
          env,
          cwd: "/tmp",
          stdio: ["ignore", "pipe", "pipe"],
        });

        activeProcesses.set(requestId, child);

        state
          .update({
            scope: "active_chats",
            key: requestId,
            ops: [{ type: "set", path: "pid", value: child.pid ?? null }],
          })
          .catch(() => {});

        const startTime = Date.now();

        res.write(
          `data: ${JSON.stringify({ type: "request_id", requestId })}\n\n`,
        );

        let lastSessionId: string | null = body.sessionId || null;
        let lineBuffer = "";
        let eventIndex = 0;
        let totalCost = 0;
        let inputTokens = 0;
        let outputTokens = 0;

        child.stdout.on("data", (chunk: Buffer) => {
          lineBuffer += chunk.toString();
          const lines = lineBuffer.split("\n");
          lineBuffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            try {
              const event = JSON.parse(trimmed);
              if (event.session_id) lastSessionId = event.session_id;

              if (event.type === "result") {
                totalCost = event.cost_usd ?? event.total_cost_usd ?? totalCost;
                inputTokens = event.input_tokens ?? inputTokens;
                outputTokens = event.output_tokens ?? outputTokens;
              }

              writeChatEvent(requestId, eventIndex++, event);
              res.write(`data: ${JSON.stringify(event)}\n\n`);
            } catch {
              // skip unparseable lines
            }
          }
        });

        child.stderr.on("data", (chunk: Buffer) => {
          const text = chunk.toString().trim();
          if (text) {
            const errEvent = { type: "error", error: text };
            writeChatEvent(requestId, eventIndex++, errEvent);
            res.write(`data: ${JSON.stringify(errEvent)}\n\n`);
          }
        });

        child.on("close", (code) => {
          activeProcesses.delete(requestId);

          if (lineBuffer.trim()) {
            try {
              const event = JSON.parse(lineBuffer.trim());
              if (event.session_id) lastSessionId = event.session_id;
              if (event.type === "result") {
                totalCost = event.cost_usd ?? event.total_cost_usd ?? totalCost;
                inputTokens = event.input_tokens ?? inputTokens;
                outputTokens = event.output_tokens ?? outputTokens;
              }
              writeChatEvent(requestId, eventIndex++, event);
              res.write(`data: ${JSON.stringify(event)}\n\n`);
            } catch {
              // skip
            }
          }

          const duration = Date.now() - startTime;

          span.setAttribute("chat.cost_usd", totalCost);
          span.setAttribute("chat.tokens.input", inputTokens);
          span.setAttribute("chat.tokens.output", outputTokens);
          span.setAttribute("chat.duration_ms", duration);
          span.setAttribute("chat.exit_code", code ?? -1);

          logger.info("Chat completed", {
            requestId,
            sessionId: lastSessionId,
            model,
            cost: totalCost,
            inputTokens,
            outputTokens,
            duration,
            exitCode: code,
          });

          state.delete({ scope: "active_chats", key: requestId });

          emit("chat::completed", {
            requestId,
            sessionId: lastSessionId,
            model,
            cost: totalCost,
            inputTokens,
            outputTokens,
            duration,
          });

          deleteChatGroup(requestId);

          res.write(
            `event: done\ndata: ${JSON.stringify({
              sessionId: lastSessionId,
              duration,
              exitCode: code,
            })}\n\n`,
          );
          res.end();
        });

        child.on("error", (err) => {
          activeProcesses.delete(requestId);
          state.delete({ scope: "active_chats", key: requestId });

          span.setAttribute("chat.error", err.message);
          logger.error("Chat failed", { requestId, error: err.message });

          res.write(
            `data: ${JSON.stringify({ type: "error", error: err.message })}\n\n`,
          );
          res.write(
            `event: done\ndata: ${JSON.stringify({ error: err.message })}\n\n`,
          );
          res.end();
        });

        req.on("close", () => {
          if (!child.killed && child.exitCode === null) {
            child.kill("SIGTERM");
            activeProcesses.delete(requestId);
            state.delete({ scope: "active_chats", key: requestId });

            logger.info("Chat stopped (client disconnect)", { requestId });
            emit("chat::stopped", { requestId, reason: "client_disconnect" });
          }
        });
      }).catch((err) => {
        logger.error("Chat span error", { error: err?.message });
        if (!res.headersSent) jsonError(res, 500, "Internal error");
      });
    })
    .catch(() => {
      if (!res.headersSent) {
        jsonError(res, 400, "Failed to read request body");
      }
    });
}

function handleStopChat(req: IncomingMessage, res: ServerResponse): void {
  readBody(req)
    .then((rawBody) => {
      try {
        const { requestId } = JSON.parse(rawBody);
        if (typeof requestId !== "string") {
          jsonError(res, 400, "Invalid requestId");
          return;
        }
        const child = activeProcesses.get(requestId);
        if (child && !child.killed) {
          child.kill("SIGTERM");
          activeProcesses.delete(requestId);
          state.delete({ scope: "active_chats", key: requestId });

          logger.info("Chat stopped by user", { requestId });
          emit("chat::stopped", { requestId, reason: "user" });

          res.writeHead(200, {
            ...corsHeaders(),
            "content-type": "application/json",
          });
          res.end(JSON.stringify({ stopped: true }));
        } else {
          jsonError(res, 404, "No active process found");
        }
      } catch {
        jsonError(res, 400, "Invalid request");
      }
    })
    .catch(() => {
      if (!res.headersSent) {
        jsonError(res, 400, "Failed to read request body");
      }
    });
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  tools?: string[];
}

async function handleSessions(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const indexed = await getSessionIndex();
  const terminalSessions = indexed.slice(0, 50).map((s) => ({
    id: s.id,
    source: "terminal" as const,
    lastUsed: s.lastModified,
    project: s.project,
    messageCount: s.messageCount || undefined,
    slug: s.slug,
  }));

  let webSessions: Array<{
    id: string;
    source: "web";
    model: string;
    createdAt: string;
    lastUsed: string;
    messageCount: number;
  }> = [];

  try {
    const raw = await fetchFromEngine("/sessions");
    const parsed = JSON.parse(raw);
    if (parsed.sessions) {
      webSessions = parsed.sessions.map((s: Record<string, unknown>) => ({
        ...s,
        source: "web",
      }));
    }
  } catch {
    // iii engine unavailable
  }

  const all = [...webSessions, ...terminalSessions].sort(
    (a, b) => new Date(b.lastUsed).getTime() - new Date(a.lastUsed).getTime(),
  );

  res.writeHead(200, {
    ...corsHeaders(),
    "content-type": "application/json",
  });
  res.end(JSON.stringify({ sessions: all, count: all.length }));
}

function fetchFromEngine(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { hostname: "127.0.0.1", port: III_PORT, path, method: "GET" },
      (response) => {
        let data = "";
        response.on("data", (chunk: Buffer) => {
          data += chunk.toString();
        });
        response.on("end", () => resolve(data));
      },
    );
    req.on("error", reject);
    req.setTimeout(3000, () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    req.end();
  });
}

async function handleSessionHistory(
  _req: IncomingMessage,
  res: ServerResponse,
  sessionId: string,
): Promise<void> {
  if (!/^[a-f0-9-]{36}$/.test(sessionId)) {
    jsonError(res, 400, "Invalid session ID");
    return;
  }

  let filePath = await getSessionFilePath(sessionId);

  if (!filePath) {
    const projectsDir = join(homedir(), ".claude", "projects");
    try {
      const projects = readdirSync(projectsDir, { withFileTypes: true });
      for (const proj of projects) {
        if (!proj.isDirectory()) continue;
        const candidate = join(projectsDir, proj.name, `${sessionId}.jsonl`);
        try {
          statSync(candidate);
          filePath = candidate;
          break;
        } catch {
          // not in this project
        }
      }
    } catch {
      // projects dir unreadable
    }
  }

  if (!filePath) {
    jsonError(res, 404, "Session not found");
    return;
  }

  const messages: ChatMessage[] = [];

  try {
    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim());

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        const msg = entry.message;
        if (!msg || typeof msg !== "object") continue;

        const role = msg.role;
        if (role !== "user" && role !== "assistant") continue;

        const rawContent = msg.content;
        let text = "";
        const tools: string[] = [];

        if (typeof rawContent === "string") {
          text = rawContent;
        } else if (Array.isArray(rawContent)) {
          for (const block of rawContent) {
            if (block.type === "text" && block.text) {
              text += (text ? "\n" : "") + block.text;
            } else if (block.type === "tool_use" && block.name) {
              tools.push(block.name);
            }
          }
        }

        if (!text && tools.length === 0) continue;

        if (
          role === "assistant" &&
          messages.length > 0 &&
          messages[messages.length - 1].role === "assistant"
        ) {
          const prev = messages[messages.length - 1];
          if (text) prev.content += (prev.content ? "\n" : "") + text;
          if (tools.length > 0) {
            prev.tools = [...(prev.tools || []), ...tools];
          }
          continue;
        }

        if (role === "user" && tools.length > 0 && !text) continue;

        messages.push({
          role,
          content: text,
          ...(tools.length > 0 ? { tools } : {}),
        });
      } catch {
        // skip unparseable lines
      }
    }
  } catch {
    jsonError(res, 500, "Failed to read session");
    return;
  }

  res.writeHead(200, {
    ...corsHeaders(),
    "content-type": "application/json",
  });
  res.end(JSON.stringify({ sessionId, messages, count: messages.length }));
}

async function handleQr(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const host = req.headers.host;
  const url = host ? `https://${host}` : await getTailscaleUrl();

  try {
    const svg = await QRCode.toString(url, { type: "svg", margin: 2 });
    res.writeHead(200, {
      ...corsHeaders(),
      "content-type": "image/svg+xml",
    });
    res.end(svg);
  } catch {
    jsonError(res, 500, "Failed to generate QR code");
  }
}

async function handleSettings(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let mcpServers: unknown = [];

  try {
    const result = await new Promise<string>((resolve, reject) => {
      execFile(
        CLAUDE_PATH,
        ["mcp", "list", "--json"],
        { timeout: 10_000, env: cleanEnv() },
        (err, stdout) => {
          if (err) {
            reject(err);
            return;
          }
          resolve(stdout);
        },
      );
    });
    mcpServers = JSON.parse(result);
  } catch {
    // no MCP servers or command failed
  }

  res.writeHead(200, {
    ...corsHeaders(),
    "content-type": "application/json",
  });
  res.end(JSON.stringify({ mcpServers }));
}

async function handleHealth(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const tsUrl = await getTailscaleUrl();

  let activeChats: unknown[] = [];
  let sessionCount = 0;
  try {
    [activeChats, sessionCount] = await Promise.all([
      state.list({ scope: "active_chats" }),
      getSessionIndex().then((s) => s.length),
    ]);
  } catch {
    // state unavailable
  }

  const workerMetrics = metricsCollector.collect();

  res.writeHead(200, {
    ...corsHeaders(),
    "content-type": "application/json",
  });
  res.end(
    JSON.stringify({
      status: "ok",
      version: "0.1.0",
      uptime: process.uptime(),
      publishedUrl: tsUrl.includes("tailclaude.local") ? null : tsUrl,
      engine: {
        connected: engineConnected,
        state: engineConnectionState,
      },
      sessions: {
        active: activeProcesses.size,
        activeFromState: activeChats.length,
        total: sessionCount,
      },
      worker: {
        memory_heap_used: workerMetrics.memory_heap_used,
        memory_rss: workerMetrics.memory_rss,
        cpu_percent: workerMetrics.cpu_percent,
        event_loop_lag_ms: workerMetrics.event_loop_lag_ms,
        uptime_seconds: workerMetrics.uptime_seconds,
      },
    }),
  );
}

let server: Server | null = null;

export function startProxy(): Promise<void> {
  if (!API_TOKEN) {
    logger.warn("No TAILCLAUDE_TOKEN set — proxy is open to all tailnet peers");
  }

  return new Promise((resolve, reject) => {
    server = createServer((req, res) => {
      const url = req.url || "";
      const method = req.method || "GET";

      if (method === "GET" && (url === "/" || url === "")) {
        const html = loadHtml();
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          ...corsHeaders(),
          "cache-control": isProduction
            ? "public, max-age=300"
            : "no-cache, no-store",
        });
        res.end(html);
        return;
      }

      if (method === "OPTIONS") {
        res.writeHead(204, {
          ...corsHeaders(),
          "access-control-max-age": "86400",
        });
        res.end();
        return;
      }

      if (!checkAuth(req, res)) return;

      if (method === "GET" && url === "/health") {
        handleHealth(req, res).catch(() => {
          if (!res.headersSent) {
            jsonError(res, 500, "Health check failed");
          }
        });
        return;
      }

      if (method === "POST" && url === "/chat") {
        handleChat(req, res);
        return;
      }

      if (method === "POST" && url === "/chat/stop") {
        handleStopChat(req, res);
        return;
      }

      if (method === "GET" && url === "/sessions") {
        handleSessions(req, res).catch(() => {
          if (!res.headersSent) {
            jsonError(res, 500, "Failed to list sessions");
          }
        });
        return;
      }

      const sessionMatch =
        method === "GET" && url.match(/^\/sessions\/([a-f0-9-]{36})$/);
      if (sessionMatch) {
        handleSessionHistory(req, res, sessionMatch[1]).catch(() => {
          if (!res.headersSent) {
            jsonError(res, 500, "Failed to load session");
          }
        });
        return;
      }

      if (method === "GET" && url === "/qr") {
        handleQr(req, res).catch(() => {
          if (!res.headersSent) {
            jsonError(res, 500, "Failed to generate QR");
          }
        });
        return;
      }

      if (method === "GET" && url === "/settings") {
        handleSettings(req, res).catch(() => {
          if (!res.headersSent) {
            jsonError(res, 500, "Failed to fetch settings");
          }
        });
        return;
      }

      const proxyReq = httpRequest(
        {
          hostname: "127.0.0.1",
          port: III_PORT,
          path: url,
          method,
          headers: req.headers,
        },
        (proxyRes) => {
          res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
          proxyRes.pipe(res, { end: true });
        },
      );

      proxyReq.on("error", () => {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "iii engine unavailable" }));
      });

      req.pipe(proxyReq, { end: true });
    });

    server.listen(PROXY_PORT, "127.0.0.1", () => {
      logger.info("UI proxy listening", { port: PROXY_PORT });
      resolve();
    });

    server.on("error", reject);
  });
}

export function stopProxy(): Promise<void> {
  return new Promise((resolve) => {
    metricsCollector.stopMonitoring();
    if (server) {
      server.close(() => resolve());
    } else {
      resolve();
    }
  });
}
