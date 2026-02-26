import { Logger } from "iii-sdk";
import { state } from "./state.js";

const logger = new Logger(undefined, "tailclaude-usage");

const SCOPE = "usage_daily";
const MAX_DAYS = 30;

export interface DailyUsage {
  _key: string;
  date: string;
  requestCount: number;
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function incrementUsage(
  cost: number,
  inputTokens: number,
  outputTokens: number,
): Promise<void> {
  const today = todayKey();

  try {
    const updated = await state.update({
      scope: SCOPE,
      key: today,
      ops: [
        { type: "increment", path: "requestCount", by: 1 },
        { type: "increment", path: "totalCost", by: cost },
        { type: "increment", path: "totalInputTokens", by: inputTokens },
        { type: "increment", path: "totalOutputTokens", by: outputTokens },
      ],
    });

    if (!updated) {
      await state.set({
        scope: SCOPE,
        key: today,
        data: {
          _key: today,
          date: today,
          requestCount: 1,
          totalCost: cost,
          totalInputTokens: inputTokens,
          totalOutputTokens: outputTokens,
        } as DailyUsage,
      });
    }
  } catch (e) {
    logger.error("Failed to increment usage", {
      error: (e as Error)?.message,
    });
  }
}

export async function getUsageStats(days = 7): Promise<DailyUsage[]> {
  try {
    const all = await state.list<DailyUsage>({ scope: SCOPE });
    return all.sort((a, b) => b.date.localeCompare(a.date)).slice(0, days);
  } catch {
    return [];
  }
}

export interface PaceStats {
  dailyAvgCost: number;
  projectedMonthlyCost: number;
  daysRemaining: number | null;
  monthSpent: number;
}

export async function getPaceStats(budgetUsd?: number): Promise<PaceStats> {
  const usage = await getUsageStats(7);
  const weekCost = usage.reduce((sum, d) => sum + (d.totalCost || 0), 0);
  const daysWithData = usage.length || 1;
  const dailyAvgCost = weekCost / daysWithData;
  const projectedMonthlyCost = dailyAvgCost * 30;

  const allUsage = await getUsageStats(30);
  const monthSpent = allUsage.reduce((sum, d) => sum + (d.totalCost || 0), 0);

  let daysRemaining: number | null = null;
  if (budgetUsd && budgetUsd > 0 && dailyAvgCost > 0) {
    const remaining = Math.max(0, budgetUsd - monthSpent);
    daysRemaining = Math.floor(remaining / dailyAvgCost);
  }

  return { dailyAvgCost, projectedMonthlyCost, daysRemaining, monthSpent };
}

export async function cleanupOldUsage(): Promise<number> {
  let removed = 0;
  try {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - MAX_DAYS);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    const all = await state.list<DailyUsage>({ scope: SCOPE });
    for (const entry of all) {
      if (entry.date < cutoffStr) {
        await state.delete({ scope: SCOPE, key: entry._key });
        removed++;
      }
    }
  } catch (e) {
    logger.error("Failed to cleanup old usage", {
      error: (e as Error)?.message,
    });
  }
  return removed;
}
