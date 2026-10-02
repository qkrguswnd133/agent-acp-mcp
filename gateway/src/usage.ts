import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { runCommand, type LaunchCommand } from "./process.js";

const BILLING_MESSAGE = "billing: fetched credits config";

export type UsagePeriod = {
  type: string;
  start: string;
  end: string;
};

export type WeeklyUsage = {
  status: "available";
  subscriptionTier: string | Unavailable;
  creditUsagePercent: number | Unavailable;
  remainingPercent: number | Unavailable;
  currentPeriod: UsagePeriod | Unavailable;
  /** Compatibility alias for consumers using the earlier name. */
  period: UsagePeriod | Unavailable;
  timestamp: string;
  fresh: boolean;
};

export type SessionUsage = {
  status: "available";
  sessionId: string;
  inputTokens: number | Unavailable;
  outputTokens: number | Unavailable;
  reasoningTokens: number | Unavailable;
  totalTokens: number | Unavailable;
  primaryModelId?: string;
  costUsdTicks?: number;
};

export type Unavailable = "unavailable";

export type WeeklyDelta = {
  status: "available";
  usedDeltaPercent: number;
  remainingPercent: number;
  subscriptionTier: string;
  period: UsagePeriod;
  note: string;
} | Unavailable;

function unavailable(): Unavailable {
  return "unavailable";
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function timestampOf(value: Record<string, unknown>): number | undefined {
  for (const key of ["timestamp", "ts", "time"]) {
    const raw = value[key];
    const parsed = typeof raw === "number" ? raw : typeof raw === "string" ? Date.parse(raw) : NaN;
    if (Number.isFinite(parsed)) return parsed < 10_000_000_000 ? parsed * 1000 : parsed;
  }
  return undefined;
}

function periodOf(ctx: Record<string, unknown>): UsagePeriod | undefined {
  const candidate = ((ctx.config as Record<string, unknown> | undefined)?.currentPeriod) as Record<string, unknown> | undefined;
  if (!candidate || typeof candidate !== "object") return undefined;
  if (typeof candidate.type !== "string" || typeof candidate.start !== "string" || typeof candidate.end !== "string") return undefined;
  if (!Number.isFinite(Date.parse(candidate.start)) || !Number.isFinite(Date.parse(candidate.end))) return undefined;
  return { type: candidate.type, start: candidate.start, end: candidate.end };
}

/** Reads the most recent billing configuration from Grok's local JSONL log. */
export async function readWeeklyUsage(logPath?: string): Promise<WeeklyUsage | Unavailable> {
  try {
    const resolved = logPath ?? join(process.env.USERPROFILE || homedir(), ".grok", "logs", "unified.jsonl");
    const lines = await readFile(resolved, "utf8");
    let best: { timestamp: number; row: Record<string, unknown> } | undefined;
    for (const line of lines.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as Record<string, unknown>;
        const ctx = row.ctx as Record<string, unknown> | undefined;
        const ts = timestampOf(row);
        // Select the latest billing row before validating fields: a newer partial
        // record must not silently backfill its usage from an older record.
        if (row.msg !== BILLING_MESSAGE || ts === undefined) continue;
        if (!best || ts >= best.timestamp) best = { timestamp: ts, row };
      } catch { /* malformed log records are expected and ignored */ }
    }
    if (!best) return unavailable();
    const row = best.row;
    const ctx = (row.ctx ?? {}) as Record<string, unknown>;
    const config = ctx.config as Record<string, unknown> | undefined;
    const period = periodOf(ctx);
    const timestamp = new Date(best.timestamp).toISOString();
    const now = Date.now();
    const usage = config && finiteNumber(config.creditUsagePercent) && config.creditUsagePercent >= 0 && config.creditUsagePercent <= 100 ? config.creditUsagePercent : unavailable();
    const fresh = !!period && best.timestamp <= now && now - best.timestamp <= 5 * 60_000 && best.timestamp >= Date.parse(period.start) && best.timestamp <= Date.parse(period.end);
    return { status: "available", subscriptionTier: typeof ctx.subscriptionTier === "string" ? ctx.subscriptionTier : unavailable(), creditUsagePercent: usage, remainingPercent: typeof usage === "number" ? 100 - usage : unavailable(), currentPeriod: period ?? unavailable(), period: period ?? unavailable(), timestamp, fresh };
  } catch {
    return unavailable();
  }
}

/** Fetches and sanitizes the JSON usage response for one local Grok session. */
export async function getSessionUsage(sessionId: string, executable: LaunchCommand, baseArgs: string[], env: NodeJS.ProcessEnv): Promise<SessionUsage | Unavailable> {
  try {
    const result = await runCommand(executable, [...baseArgs, "usage", sessionId], { env, timeoutMs: 20_000 });
    if (result.code !== 0 || result.stdout.length > 2 * 1024 * 1024) return unavailable();
    const parsed = parseJsonOutput(result.stdout);
    const session = parsed?.session as Record<string, unknown> | undefined;
    if (!session || (typeof session.sessionId==='string'&&session.sessionId!==sessionId) || (typeof session.id==='string'&&session.id!==sessionId)) return unavailable();
    return { status: "available", sessionId, inputTokens: finiteNumber(session.inputTokens) ? session.inputTokens : unavailable(), outputTokens: finiteNumber(session.outputTokens) ? session.outputTokens : unavailable(), reasoningTokens: finiteNumber(session.reasoningTokens) ? session.reasoningTokens : unavailable(), totalTokens: finiteNumber(session.totalTokens) ? session.totalTokens : unavailable(), ...(typeof session.primaryModelId === "string" ? { primaryModelId: session.primaryModelId } : {}), ...(finiteNumber(session.costUsdTicks) ? { costUsdTicks: session.costUsdTicks } : {}) };
  } catch {
    return unavailable();
  }
}

function parseJsonOutput(stdout: string): Record<string, unknown> | undefined {
  try { return JSON.parse(stdout) as Record<string, unknown>; } catch {
    const start = stdout.indexOf("{");
    const end = stdout.lastIndexOf("}");
    if (start < 0 || end <= start) return undefined;
    try { return JSON.parse(stdout.slice(start, end + 1)) as Record<string, unknown>; } catch { return undefined; }
  }
}

export function weeklyDelta(before: WeeklyUsage | Unavailable, after: WeeklyUsage | Unavailable, startedAt: Date | number | string): WeeklyDelta {
  if (before === "unavailable" || after === "unavailable") return unavailable();
  const rawStart = startedAt instanceof Date ? startedAt.getTime() : typeof startedAt === "number" ? startedAt : Date.parse(startedAt);
  const start = typeof startedAt === "number" && startedAt < 10_000_000_000 ? startedAt * 1000 : rawStart;
  if (!Number.isFinite(start) || !after.fresh || typeof before.creditUsagePercent !== "number" || typeof after.creditUsagePercent !== "number" || typeof before.remainingPercent !== "number" || typeof after.remainingPercent !== "number" || before.subscriptionTier === "unavailable" || after.subscriptionTier === "unavailable" || before.currentPeriod === "unavailable" || after.currentPeriod === "unavailable" || Date.parse(after.timestamp) <= start || before.subscriptionTier !== after.subscriptionTier || before.currentPeriod.type !== after.currentPeriod.type || before.currentPeriod.start !== after.currentPeriod.start || before.currentPeriod.end !== after.currentPeriod.end) return unavailable();
  return { status: "available", usedDeltaPercent: after.creditUsagePercent - before.creditUsagePercent, remainingPercent: after.remainingPercent, subscriptionTier: after.subscriptionTier, period: after.currentPeriod, note: "Delta uses the last-known baseline; other concurrent sessions may also contribute to account usage." };
}
