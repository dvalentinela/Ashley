import { processRun, dueRunIds } from "./agent/runtime";
import { config, type Env } from "./env";
import { deliverNotification, dueNotificationIds } from "./notify/outbox";

/**
 * Processes due notifications and Catherine runs. Called by the cron trigger
 * every minute and, for low latency, after requests that create work. All
 * state lives in D1, so closing the browser tab loses nothing.
 */
export async function runDueWork(env: Env, now = Date.now()): Promise<{ notifications: Record<string, number>; runs: Record<string, number> }> {
  const notifications: Record<string, number> = {};
  for (const id of await dueNotificationIds(env, now)) {
    const result = (await deliverNotification(env, id, now)) ?? "skipped";
    notifications[result] = (notifications[result] ?? 0) + 1;
  }
  const runs: Record<string, number> = {};
  for (const id of await dueRunIds(env, now)) {
    const result = (await processRun(env, id, now)) ?? "skipped";
    runs[result] = (runs[result] ?? 0) + 1;
  }
  return { notifications, runs };
}

export function kick(env: Env, ctx: { waitUntil(promise: Promise<unknown>): void } | undefined): void {
  if (!ctx || !config(env).dispatchImmediate) return;
  ctx.waitUntil(
    runDueWork(env).catch((err) => {
      console.error("background work failed", err instanceof Error ? err.message : err);
    }),
  );
}
