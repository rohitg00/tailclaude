import {
  createServer,
  request as httpRequest,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import {
  readFileSync,
  readdirSync,
  statSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import QRCode from "qrcode";

const __dirname = dirname(fileURLToPath(import.meta.url));
const III_PORT = 3111;
const PROXY_PORT = 3110;
const isProduction = process.env.NODE_ENV === "production";
const API_TOKEN = process.env.TAILCLAUDE_TOKEN || null;
const MAX_BODY_BYTES = 1_000_000;

let cachedHtml: string | null = null;

const CLAUDE_PATH =
  process.platform === "darwin"
    ? `${process.env.HOME}/.local/bin/claude`
    : "claude";

const PROJECTS_DIR = join(homedir(), ".claude", "projects");

const ALLOWED_MODELS = new Set(["sonnet", "opus", "haiku"]);
const ALLOWED_MODES = new Set([
  "default",
  "plan",
  "acceptEdits",
  "bypassPermissions",
  "dontAsk",
]);
const ALLOWED_EFFORTS = new Set(["low", "medium", "high"]);

function loadHtml(): string {
  if (!cachedHtml || !isProduction) {
    cachedHtml = readFileSync(resolve(__dirname, "ui.html"), "utf-8");
  }
  return cachedHtml;
}

const TAILSCALE_CLI =
  process.platform === "darwin"
    ? "/Applications/Tailscale.app/Contents/MacOS/Tailscale"
    : "tailscale";

function getTailscaleUrl(): Promise<string> {
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

      if (body.sessionId) {
        args.push("--resume", body.sessionId);
      }
      if (body.model) {
        args.push("--model", body.model);
      }
      if (body.mode) {
        args.push("--permission-mode", body.mode);
      }
      if (body.effort) {
        args.push("--effort", body.effort);
      }
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

      const requestId = randomUUID();
      activeProcesses.set(requestId, child);
      const startTime = Date.now();

      res.write(
        `data: ${JSON.stringify({ type: "request_id", requestId })}\n\n`,
      );

      let lastSessionId: string | null = body.sessionId || null;
      let lineBuffer = "";

      child.stdout.on("data", (chunk: Buffer) => {
        lineBuffer += chunk.toString();
        const lines = lineBuffer.split("\n");
        lineBuffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          try {
            const event = JSON.parse(trimmed);
            if (event.session_id) {
              lastSessionId = event.session_id;
            }
            res.write(`data: ${JSON.stringify(event)}\n\n`);
          } catch {
            // skip unparseable lines
          }
        }
      });

      child.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString().trim();
        if (text) {
          res.write(
            `data: ${JSON.stringify({ type: "error", error: text })}\n\n`,
          );
        }
      });

      child.on("close", (code) => {
        activeProcesses.delete(requestId);

        if (lineBuffer.trim()) {
          try {
            const event = JSON.parse(lineBuffer.trim());
            if (event.session_id) lastSessionId = event.session_id;
            res.write(`data: ${JSON.stringify(event)}\n\n`);
          } catch {
            // skip
          }
        }

        const duration = Date.now() - startTime;
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
        }
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

interface TerminalSession {
  id: string;
  source: "terminal";
  lastUsed: string;
  project?: string;
  messageCount?: number;
  slug?: string;
}

function discoverTerminalSessions(): TerminalSession[] {
  const sessions: TerminalSession[] = [];

  try {
    const projects = readdirSync(PROJECTS_DIR, { withFileTypes: true });
    for (const projEntry of projects) {
      if (!projEntry.isDirectory()) continue;

      const projDir = join(PROJECTS_DIR, projEntry.name);
      const projectName = extractProjectName(projEntry.name);

      try {
        const files = readdirSync(projDir);
        const jsonlFiles = files.filter(
          (f) => f.endsWith(".jsonl") && !f.includes("memory"),
        );

        for (const file of jsonlFiles) {
          const filePath = join(projDir, file);
          try {
            const stat = statSync(filePath);
            if (stat.size < 50) continue;
            const sessionId = file.replace(".jsonl", "");

            let project: string | undefined = projectName;
            let messageCount = 0;
            let slug: string | undefined;

            const fd = openSync(filePath, "r");
            const buf = Buffer.alloc(8192);
            const bytesRead = readSync(fd, buf, 0, 8192, 0);
            closeSync(fd);
            const head = buf.toString("utf-8", 0, bytesRead);
            const lines = head.split("\n").filter((l: string) => l.trim());

            for (const line of lines) {
              try {
                const parsed = JSON.parse(line);
                if (parsed.cwd && !project) {
                  project = parsed.cwd.split("/").pop() || project;
                }
                if (parsed.slug && !slug) {
                  slug = parsed.slug;
                }
                const role = parsed.message?.role;
                if (role === "user" || role === "assistant") {
                  messageCount++;
                }
              } catch {
                // skip
              }
            }

            sessions.push({
              id: sessionId,
              source: "terminal",
              lastUsed: stat.mtime.toISOString(),
              project,
              messageCount: messageCount || undefined,
              slug,
            });
          } catch {
            // skip unreadable files
          }
        }
      } catch {
        // skip unreadable project dirs
      }
    }
  } catch {
    // projects directory doesn't exist
  }

  sessions.sort(
    (a, b) => new Date(b.lastUsed).getTime() - new Date(a.lastUsed).getTime(),
  );

  return sessions.slice(0, 50);
}

function extractProjectName(dirName: string): string {
  const cleaned = dirName.replace(/^-/, "");
  const parts = cleaned.split("-");
  if (parts.length <= 2) return parts.pop() || dirName;
  const meaningful = parts.filter(
    (p) => p !== "Users" && p !== "private" && p !== "tmp" && p.length > 1,
  );
  return meaningful.pop() || parts.pop() || dirName;
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

async function handleSessions(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const terminalSessions = discoverTerminalSessions();

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
    // iii engine unavailable or no web sessions
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

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  tools?: string[];
}

function handleSessionHistory(
  _req: IncomingMessage,
  res: ServerResponse,
  sessionId: string,
): void {
  if (!/^[a-f0-9-]{36}$/.test(sessionId)) {
    jsonError(res, 400, "Invalid session ID");
    return;
  }

  let filePath: string | null = null;
  try {
    const projects = readdirSync(PROJECTS_DIR, { withFileTypes: true });
    for (const proj of projects) {
      if (!proj.isDirectory()) continue;
      const candidate = join(PROJECTS_DIR, proj.name, `${sessionId}.jsonl`);
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
  let url = host ? `https://${host}` : await getTailscaleUrl();

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
  const sessions = discoverTerminalSessions();

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
      sessions: { active: activeProcesses.size, total: sessions.length },
    }),
  );
}

let server: Server | null = null;

export function startProxy(): Promise<void> {
  if (!API_TOKEN) {
    console.warn(
      "WARNING: No TAILCLAUDE_TOKEN set — proxy is open to all tailnet peers",
    );
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
        handleSessionHistory(req, res, sessionMatch[1]);
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
      console.log(`UI proxy listening on http://127.0.0.1:${PROXY_PORT}`);
      resolve();
    });

    server.on("error", reject);
  });
}

export function stopProxy(): Promise<void> {
  return new Promise((resolve) => {
    if (server) {
      server.close(() => resolve());
    } else {
      resolve();
    }
  });
}
