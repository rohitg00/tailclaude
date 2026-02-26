import { readFileSync, statSync } from "node:fs";
import { Logger } from "iii-sdk";
import { state } from "./state.js";
import { getSessionIndex, type SessionIndexEntry } from "./sessions.js";

const logger = new Logger(undefined, "tailclaude-session-costs");

const TRACE_SCOPE = "traces";
const USAGE_SCOPE = "usage_daily";
const BACKFILL_SCOPE = "backfill_state";

const PRICING: Record<
  string,
  { input: number; output: number; cacheRead: number; cacheWrite: number }
> = {
  "claude-opus-4-6": {
    input: 15,
    output: 75,
    cacheRead: 1.5,
    cacheWrite: 18.75,
  },
  "claude-sonnet-4-6": {
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite: 3.75,
  },
  "claude-haiku-4-5-20251001": {
    input: 0.8,
    output: 4,
    cacheRead: 0.08,
    cacheWrite: 1,
  },
};

function modelShortName(model: string): string {
  if (model.includes("opus")) return "opus";
  if (model.includes("sonnet")) return "sonnet";
  if (model.includes("haiku")) return "haiku";
  return model;
}

function getPricing(model: string) {
  if (PRICING[model]) return PRICING[model];
  if (model.includes("opus")) return PRICING["claude-opus-4-6"];
  if (model.includes("haiku")) return PRICING["claude-haiku-4-5-20251001"];
  return PRICING["claude-sonnet-4-6"];
}

function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number,
): number {
  const p = getPricing(model);
  return (
    (inputTokens / 1_000_000) * p.input +
    (outputTokens / 1_000_000) * p.output +
    (cacheReadTokens / 1_000_000) * p.cacheRead +
    (cacheWriteTokens / 1_000_000) * p.cacheWrite
  );
}

interface SessionCostData {
  sessionId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
  messageCount: number;
  firstTimestamp: string;
  lastTimestamp: string;
  durationSeconds: number;
}

function parseSessionFile(
  filePath: string,
  sessionId: string,
): SessionCostData | null {
  try {
    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n");

    let totalInput = 0;
    let totalOutput = 0;
    let totalCacheRead = 0;
    let totalCacheWrite = 0;
    let messageCount = 0;
    let model = "";
    let firstTs = "";
    let lastTs = "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        const msg = entry.message;
        if (!msg || typeof msg !== "object") continue;

        const ts = entry.timestamp || msg.timestamp;
        if (ts) {
          if (!firstTs) firstTs = ts;
          lastTs = ts;
        }

        if (msg.role === "user" || msg.role === "assistant") messageCount++;

        if (msg.role === "assistant" && msg.usage) {
          const u = msg.usage;
          totalInput += u.input_tokens || 0;
          totalOutput += u.output_tokens || 0;
          totalCacheRead += u.cache_read_input_tokens || 0;
          totalCacheWrite += u.cache_creation_input_tokens || 0;

          if (msg.model && !model) model = msg.model;
        }
      } catch {}
    }

    if (
      totalInput === 0 &&
      totalOutput === 0 &&
      totalCacheRead === 0 &&
      totalCacheWrite === 0
    ) {
      return null;
    }

    if (!model) model = "claude-sonnet-4-6";

    const cost = calculateCost(
      model,
      totalInput,
      totalOutput,
      totalCacheRead,
      totalCacheWrite,
    );

    let durationSeconds = 0;
    if (firstTs && lastTs) {
      durationSeconds = Math.max(
        0,
        (new Date(lastTs).getTime() - new Date(firstTs).getTime()) / 1000,
      );
    }

    return {
      sessionId,
      model,
      inputTokens: totalInput,
      outputTokens: totalOutput,
      cacheReadTokens: totalCacheRead,
      cacheWriteTokens: totalCacheWrite,
      cost,
      messageCount,
      firstTimestamp: firstTs,
      lastTimestamp: lastTs,
      durationSeconds,
    };
  } catch {
    return null;
  }
}

export async function getSessionCost(
  sessionId: string,
): Promise<number | null> {
  try {
    const data = await state.get<{ cost?: number }>({
      scope: TRACE_SCOPE,
      key: sessionId,
    });
    return data?.cost ?? null;
  } catch {
    return null;
  }
}

export async function getSessionCosts(
  sessionIds: string[],
): Promise<Record<string, number>> {
  const costs: Record<string, number> = {};
  const CHUNK = 20;
  for (let i = 0; i < sessionIds.length; i += CHUNK) {
    await Promise.all(
      sessionIds.slice(i, i + CHUNK).map(async (id) => {
        const cost = await getSessionCost(id);
        if (cost !== null) costs[id] = cost;
      }),
    );
  }
  return costs;
}

export async function backfillSessionCosts(): Promise<{
  sessions: number;
  totalCost: number;
}> {
  let lastBackfill = "";
  try {
    const bs = await state.get<{ lastRun: string }>({
      scope: BACKFILL_SCOPE,
      key: "session_costs",
    });
    if (bs?.lastRun) lastBackfill = bs.lastRun;
  } catch {}

  const sessions = await getSessionIndex();
  let processed = 0;
  let totalCost = 0;
  const dailyAgg: Record<
    string,
    { requests: number; cost: number; input: number; output: number }
  > = {};

  for (const session of sessions) {
    try {
      const existing = await state.get<{ _key: string }>({
        scope: TRACE_SCOPE,
        key: session.id,
      });
      if (existing) continue;

      let mtime: string;
      try {
        mtime = statSync(session.filePath).mtime.toISOString();
      } catch {
        continue;
      }

      if (lastBackfill && mtime < lastBackfill) continue;

      const data = parseSessionFile(session.filePath, session.id);
      if (!data) continue;

      await state.set({
        scope: TRACE_SCOPE,
        key: session.id,
        data: {
          _key: session.id,
          requestId: session.id,
          sessionId: session.id,
          model: modelShortName(data.model),
          cost: data.cost,
          inputTokens:
            data.inputTokens + data.cacheReadTokens + data.cacheWriteTokens,
          outputTokens: data.outputTokens,
          duration: data.durationSeconds * 1000,
          exitCode: 0,
          timestamp: data.lastTimestamp || session.lastModified,
          source: "terminal",
        },
      });

      const day = (data.lastTimestamp || session.lastModified).slice(0, 10);
      if (!dailyAgg[day])
        dailyAgg[day] = { requests: 0, cost: 0, input: 0, output: 0 };
      dailyAgg[day].requests++;
      dailyAgg[day].cost += data.cost;
      dailyAgg[day].input +=
        data.inputTokens + data.cacheReadTokens + data.cacheWriteTokens;
      dailyAgg[day].output += data.outputTokens;

      totalCost += data.cost;
      processed++;
    } catch {}
  }

  for (const [day, agg] of Object.entries(dailyAgg)) {
    try {
      const existing = await state.get<{
        _key: string;
        requestCount: number;
        totalCost: number;
        totalInputTokens: number;
        totalOutputTokens: number;
      }>({ scope: USAGE_SCOPE, key: day });

      if (existing) {
        await state.set({
          scope: USAGE_SCOPE,
          key: day,
          data: {
            _key: day,
            date: day,
            requestCount: existing.requestCount + agg.requests,
            totalCost: existing.totalCost + agg.cost,
            totalInputTokens: existing.totalInputTokens + agg.input,
            totalOutputTokens: existing.totalOutputTokens + agg.output,
          },
        });
      } else {
        await state.set({
          scope: USAGE_SCOPE,
          key: day,
          data: {
            _key: day,
            date: day,
            requestCount: agg.requests,
            totalCost: agg.cost,
            totalInputTokens: agg.input,
            totalOutputTokens: agg.output,
          },
        });
      }
    } catch {}
  }

  try {
    await state.set({
      scope: BACKFILL_SCOPE,
      key: "session_costs",
      data: { lastRun: new Date().toISOString() },
    });
  } catch {}

  if (processed > 0) {
    logger.info("Session cost backfill complete", {
      processed,
      totalCost: totalCost.toFixed(4),
    });
  }

  return { sessions: processed, totalCost };
}
