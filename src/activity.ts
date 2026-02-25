import type { ServerResponse } from "node:http";
import { Logger } from "iii-sdk";

const logger = new Logger(undefined, "tailclaude-activity");

export interface ActivityEvent {
  id: string;
  type: string;
  message: string;
  data?: Record<string, unknown>;
  timestamp: string;
}

const MAX_BUFFER = 200;
const REPLAY_COUNT = 50;

const buffer: ActivityEvent[] = [];
const sseClients = new Set<ServerResponse>();

let idCounter = 0;

export function pushActivity(
  type: string,
  message: string,
  data?: Record<string, unknown>,
): void {
  const event: ActivityEvent = {
    id: String(++idCounter),
    type,
    message,
    data,
    timestamp: new Date().toISOString(),
  };

  buffer.push(event);
  if (buffer.length > MAX_BUFFER) buffer.shift();

  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of sseClients) {
    try {
      if (!client.writableEnded && !client.destroyed) {
        client.write(payload);
      } else {
        sseClients.delete(client);
      }
    } catch {
      sseClients.delete(client);
    }
  }
}

export function handleActivitySSE(res: ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "access-control-allow-origin": "*",
  });

  const replay = buffer.slice(-REPLAY_COUNT);
  for (const event of replay) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  sseClients.add(res);

  res.on("close", () => {
    sseClients.delete(res);
  });

  logger.info("Activity SSE client connected", { total: sseClients.size });
}

export function getRecentActivity(count = 50): ActivityEvent[] {
  return buffer.slice(-count);
}

export function getSSEClientCount(): number {
  return sseClients.size;
}

setInterval(() => {
  for (const client of sseClients) {
    try {
      if (!client.writableEnded && !client.destroyed) {
        client.write(": heartbeat\n\n");
      } else {
        sseClients.delete(client);
      }
    } catch {
      sseClients.delete(client);
    }
  }
}, 30_000);
