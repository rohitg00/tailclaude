import { Logger } from "iii-sdk";
import { state } from "./state.js";

const logger = new Logger(undefined, "tailclaude-traces");

const SCOPE = "traces";
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface TraceRecord {
  _key: string;
  requestId: string;
  sessionId?: string | null;
  model?: string;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  duration: number;
  exitCode?: number | null;
  reason?: string;
  timestamp: string;
}

export async function writeCompletedTrace(data: {
  requestId: string;
  sessionId: string | null;
  model: string;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  duration: number;
  exitCode?: number | null;
}): Promise<void> {
  try {
    await state.set({
      scope: SCOPE,
      key: data.requestId,
      data: {
        _key: data.requestId,
        requestId: data.requestId,
        sessionId: data.sessionId,
        model: data.model,
        cost: data.cost,
        inputTokens: data.inputTokens,
        outputTokens: data.outputTokens,
        duration: data.duration,
        exitCode: data.exitCode ?? null,
        timestamp: new Date().toISOString(),
      } as TraceRecord,
    });
  } catch (e) {
    logger.error("Failed to write completed trace", {
      error: (e as Error)?.message,
    });
  }
}

export async function writeStoppedTrace(data: {
  requestId: string;
  reason: string;
}): Promise<void> {
  try {
    const existing = await state.get<TraceRecord>({
      scope: SCOPE,
      key: data.requestId,
    });
    if (existing) return;
    await state.set({
      scope: SCOPE,
      key: data.requestId,
      data: {
        _key: data.requestId,
        requestId: data.requestId,
        reason: data.reason,
        cost: 0,
        inputTokens: 0,
        outputTokens: 0,
        duration: 0,
        timestamp: new Date().toISOString(),
      } as TraceRecord,
    });
  } catch (e) {
    logger.error("Failed to write stopped trace", {
      error: (e as Error)?.message,
    });
  }
}

export async function getTraces(limit = 100): Promise<TraceRecord[]> {
  try {
    const all = await state.list<TraceRecord>({ scope: SCOPE });
    return all
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .slice(0, limit);
  } catch {
    return [];
  }
}

export async function cleanupOldTraces(): Promise<number> {
  let removed = 0;
  try {
    const cutoff = Date.now() - MAX_AGE_MS;
    const all = await state.list<TraceRecord>({ scope: SCOPE });
    for (const trace of all) {
      if (new Date(trace.timestamp).getTime() < cutoff) {
        await state.delete({ scope: SCOPE, key: trace._key });
        removed++;
      }
    }
  } catch (e) {
    logger.error("Failed to cleanup old traces", {
      error: (e as Error)?.message,
    });
  }
  return removed;
}
