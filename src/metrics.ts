import { WorkerMetricsCollector } from "iii-sdk/telemetry";

export const metricsCollector = new WorkerMetricsCollector();

let cachedMetrics: ReturnType<WorkerMetricsCollector["collect"]> | null = null;
let cacheTimestamp = 0;
const CACHE_TTL = 5000;

export function getMetrics(): ReturnType<WorkerMetricsCollector["collect"]> {
  const now = Date.now();
  if (!cachedMetrics || now - cacheTimestamp > CACHE_TTL) {
    cachedMetrics = metricsCollector.collect();
    cacheTimestamp = now;
  }
  return cachedMetrics;
}
