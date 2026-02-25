import { Logger } from "iii-sdk";
import { state } from "./state.js";
import { getMetrics } from "./metrics.js";
import { emit } from "./hooks.js";
import { pushActivity } from "./activity.js";

const logger = new Logger(undefined, "tailclaude-metrics-timeline");

const SCOPE = "metrics_timeline";
const COOLDOWN_SCOPE = "alert_cooldowns";
const ALERTS_SCOPE = "alerts";
const MAX_SNAPSHOTS = 60;
const COOLDOWN_MS = 5 * 60 * 1000;

export interface MetricsSnapshot {
  _key: string;
  ts: string;
  memory_rss: number;
  cpu_percent: number;
  event_loop_lag_ms: number;
  active_chats: number;
}

interface AlertCooldown {
  lastFired: number;
}

interface AlertState {
  _key: string;
  active: boolean;
  value: number;
  threshold: number;
  timestamp: string;
}

const THRESHOLDS = {
  high_cpu: { metric: "cpu_percent" as const, threshold: 80 },
  high_memory: { metric: "memory_rss" as const, threshold: 500 * 1024 * 1024 },
  high_lag: { metric: "event_loop_lag_ms" as const, threshold: 100 },
  high_concurrency: { metric: "active_chats" as const, threshold: 3 },
};

async function getActiveChatCount(): Promise<number> {
  try {
    const chats = await state.list({ scope: "active_chats" });
    return chats.length;
  } catch {
    return 0;
  }
}

async function checkCooldown(alertType: string): Promise<boolean> {
  try {
    const cd = await state.get<AlertCooldown>({
      scope: COOLDOWN_SCOPE,
      key: alertType,
    });
    if (!cd) return true;
    return Date.now() - cd.lastFired > COOLDOWN_MS;
  } catch {
    return true;
  }
}

async function setCooldown(alertType: string): Promise<void> {
  try {
    await state.set({
      scope: COOLDOWN_SCOPE,
      key: alertType,
      data: { lastFired: Date.now() },
    });
  } catch {}
}

async function fireAlert(
  alertType: string,
  value: number,
  threshold: number,
): Promise<void> {
  const canFire = await checkCooldown(alertType);
  if (!canFire) return;

  await setCooldown(alertType);

  const timestamp = new Date().toISOString();
  try {
    await state.set({
      scope: ALERTS_SCOPE,
      key: alertType,
      data: {
        _key: alertType,
        active: true,
        value,
        threshold,
        timestamp,
      } as AlertState,
    });
  } catch {}

  const label = alertType.replace("_", " ").replace("high ", "High ");

  let unit: string;
  switch (alertType) {
    case "high_memory":
      unit = `${(value / (1024 * 1024)).toFixed(0)}MB`;
      break;
    case "high_lag":
      unit = `${value.toFixed(0)}ms`;
      break;
    case "high_concurrency":
      unit = `${value} active chats`;
      break;
    default:
      unit = `${value.toFixed(1)}%`;
  }

  let thresholdStr: string;
  switch (alertType) {
    case "high_memory":
      thresholdStr = `${(threshold / (1024 * 1024)).toFixed(0)}MB`;
      break;
    case "high_lag":
      thresholdStr = `${threshold}ms`;
      break;
    case "high_concurrency":
      thresholdStr = `${threshold}`;
      break;
    default:
      thresholdStr = `${threshold}%`;
  }

  pushActivity("alert", `${label}: ${unit} (threshold: ${thresholdStr})`, {
    alertType,
    value,
    threshold,
  });

  emit(`alert::${alertType}`, { value, threshold, timestamp }).catch(() => {});
  logger.warn("Alert fired", { alertType, value, threshold });
}

async function clearAlert(alertType: string): Promise<void> {
  try {
    const existing = await state.get<AlertState>({
      scope: ALERTS_SCOPE,
      key: alertType,
    });
    if (existing?.active) {
      await state.set({
        scope: ALERTS_SCOPE,
        key: alertType,
        data: {
          _key: alertType,
          active: false,
          value: 0,
          threshold: 0,
          timestamp: new Date().toISOString(),
        } as AlertState,
      });
    }
  } catch {}
}

export async function snapshotMetrics(): Promise<void> {
  const metrics = getMetrics();
  const activeChats = await getActiveChatCount();
  const ts = new Date().toISOString();
  const key = ts.replace(/[:.]/g, "-");

  const memRss = metrics.memory_rss ?? 0;
  const cpuPct = metrics.cpu_percent ?? 0;
  const lagMs = metrics.event_loop_lag_ms ?? 0;

  const snapshot: MetricsSnapshot = {
    _key: key,
    ts,
    memory_rss: memRss,
    cpu_percent: cpuPct,
    event_loop_lag_ms: lagMs,
    active_chats: activeChats,
  };

  try {
    await state.set({ scope: SCOPE, key, data: snapshot });
  } catch (e) {
    logger.error("Failed to save metrics snapshot", {
      error: (e as Error)?.message,
    });
  }

  try {
    const all = await state.list<MetricsSnapshot>({ scope: SCOPE });
    if (all.length > MAX_SNAPSHOTS) {
      const sorted = all.sort((a, b) => a.ts.localeCompare(b.ts));
      const toRemove = sorted.slice(0, all.length - MAX_SNAPSHOTS);
      for (const entry of toRemove) {
        await state.delete({ scope: SCOPE, key: entry._key });
      }
    }
  } catch {}

  const values: Record<string, number> = {
    cpu_percent: cpuPct,
    memory_rss: memRss,
    event_loop_lag_ms: lagMs,
    active_chats: activeChats,
  };

  for (const [alertType, config] of Object.entries(THRESHOLDS)) {
    const value = values[config.metric];
    if (value > config.threshold) {
      await fireAlert(alertType, value, config.threshold);
    } else {
      await clearAlert(alertType);
    }
  }
}

export async function getTimeline(): Promise<MetricsSnapshot[]> {
  try {
    const all = await state.list<MetricsSnapshot>({ scope: SCOPE });
    return all.sort((a, b) => a.ts.localeCompare(b.ts));
  } catch {
    return [];
  }
}

export async function getActiveAlerts(): Promise<
  Array<{ type: string } & AlertState>
> {
  try {
    const all = await state.list<AlertState>({ scope: ALERTS_SCOPE });
    return all
      .filter((a) => a.active)
      .map((a) => ({ ...a, type: a._key || "unknown" }));
  } catch {
    return [];
  }
}
