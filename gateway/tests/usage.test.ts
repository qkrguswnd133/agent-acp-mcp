import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWeeklyUsage, getSessionUsage, weeklyDelta } from "../src/usage.js";

test("readWeeklyUsage selects the latest valid billing record and preserves zero", async () => {
  const dir = await mkdtemp(join(tmpdir(), "grok-usage-"));
  const file = join(dir, "unified.jsonl");
  await writeFile(file, [
    JSON.stringify({ timestamp: "2026-09-15T00:00:00.000Z", msg: "billing: fetched credits config", ctx: { subscriptionTier: "pro", config: { creditUsagePercent: 32, currentPeriod: { type: "weekly", start: "2026-09-14T00:00:00.000Z", end: "2026-09-21T00:00:00.000Z" } } } }),
    "not json",
    JSON.stringify({ timestamp: "2026-09-15T01:00:00.000Z", msg: "billing: fetched credits config", ctx: { subscriptionTier: "pro", config: { creditUsagePercent: 0, currentPeriod: { type: "weekly", start: "2026-09-14T00:00:00.000Z", end: "2026-09-21T00:00:00.000Z" } } } }),
  ].join("\n"));
  const value = await readWeeklyUsage(file);
  assert.notEqual(value, "unavailable");
  if (value !== "unavailable") {
    assert.equal(value.creditUsagePercent, 0);
    assert.equal(value.remainingPercent, 100);
    assert.equal(value.subscriptionTier, "pro");
    assert.equal(value.currentPeriod !== "unavailable" && value.currentPeriod.type, "weekly");
  }
  await rm(dir, { recursive: true, force: true });
});

test("readWeeklyUsage does not infer absent percent as zero", async () => {
  const dir = await mkdtemp(join(tmpdir(), "grok-usage-"));
  const file = join(dir, "unified.jsonl");
  await writeFile(file, [
    JSON.stringify({ timestamp: "2026-09-15T00:00:00.000Z", msg: "billing: fetched credits config", ctx: { subscriptionTier: "pro", config: { creditUsagePercent: 10, currentPeriod: { type: "weekly", start: "2026-09-14T00:00:00.000Z", end: "2026-09-21T00:00:00.000Z" } } } }),
    JSON.stringify({ timestamp: "2026-09-15T01:00:00.000Z", msg: "billing: fetched credits config", ctx: { subscriptionTier: "pro", config: { currentPeriod: { type: "weekly", start: "2026-09-14T00:00:00.000Z", end: "2026-09-21T00:00:00.000Z" } } } }),
  ].join("\n"));
  const partial = await readWeeklyUsage(file);
  assert.notEqual(partial, "unavailable");
  if (partial !== "unavailable") { assert.equal(partial.creditUsagePercent, "unavailable"); assert.equal(partial.subscriptionTier, "pro"); assert.notEqual(partial.currentPeriod, "unavailable"); }
  await rm(dir, { recursive: true, force: true });
});

test("readWeeklyUsage ignores newer nonbilling and malformed billing rows", async () => {
  const dir = await mkdtemp(join(tmpdir(), "grok-usage-"));
  const file = join(dir, "unified.jsonl");
  await writeFile(file, [
    JSON.stringify({ timestamp: "2026-09-15T03:00:00.000Z", msg: "billing: fetched credits config", ctx: { subscriptionTier: "pro", config: { creditUsagePercent: 0, currentPeriod: { type: "weekly", start: "2026-09-14T00:00:00.000Z", end: "2026-09-21T00:00:00.000Z" } } } }),
    JSON.stringify({ timestamp: "2026-09-15T04:00:00.000Z", msg: "session: completed", ctx: { config: { creditUsagePercent: 99 } } }),
    JSON.stringify({ timestamp: "2026-09-15T05:00:00.000Z", msg: "session: failed" }),
  ].join("\n"));
  const value = await readWeeklyUsage(file);
  assert.notEqual(value, "unavailable");
  if (value !== "unavailable") assert.equal(value.creditUsagePercent, 0);
  await rm(dir, { recursive: true, force: true });
});

test("readWeeklyUsage treats newest billing row without ctx as unavailable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "grok-usage-"));
  const file = join(dir, "unified.jsonl");
  await writeFile(file, [
    JSON.stringify({ timestamp: "2026-09-15T03:00:00.000Z", msg: "billing: fetched credits config", ctx: { subscriptionTier: "pro", config: { creditUsagePercent: 0, currentPeriod: { type: "weekly", start: "2026-09-14T00:00:00.000Z", end: "2026-09-21T00:00:00.000Z" } } } }),
    JSON.stringify({ timestamp: "2026-09-15T05:00:00.000Z", msg: "billing: fetched credits config" }),
  ].join("\n"));
  const partial = await readWeeklyUsage(file);
  assert.notEqual(partial, "unavailable");
  if (partial !== "unavailable") { assert.equal(partial.timestamp, "2026-09-15T05:00:00.000Z"); assert.equal(partial.creditUsagePercent, "unavailable"); assert.equal(partial.currentPeriod, "unavailable"); }
  await rm(dir, { recursive: true, force: true });
});

test("getSessionUsage parses sanitized token fields without a live Grok request", async () => {
  const script = "process.stdout.write(JSON.stringify({session:{inputTokens:2,outputTokens:3,reasoningTokens:4,totalTokens:9,primaryModelId:'model',costUsdTicks:7},turns:[]}))";
  const value = await getSessionUsage("session-1", process.execPath, ["-e", script], process.env);
  assert.deepEqual(value, { status: "available", sessionId: "session-1", inputTokens: 2, outputTokens: 3, reasoningTokens: 4, totalTokens: 9, primaryModelId: "model", costUsdTicks: 7 });
});

test("weeklyDelta requires a fresh same-period after sample and explains baseline", () => {
  const period = { type: "weekly", start: "2026-09-14T00:00:00.000Z", end: "2026-09-21T00:00:00.000Z" };
  const before = { status: "available" as const, subscriptionTier: "pro", creditUsagePercent: 20, remainingPercent: 80, currentPeriod: period, period, timestamp: "2026-09-15T00:00:00.000Z", fresh: true };
  const after = { ...before, creditUsagePercent: 35, remainingPercent: 65, timestamp: "2026-09-15T02:00:00.000Z" };
  const delta = weeklyDelta(before, after, "2026-09-15T01:00:00.000Z");
  assert.notEqual(delta, "unavailable");
  if (delta !== "unavailable") { assert.equal(delta.usedDeltaPercent, 15); assert.match(delta.note, /last-known baseline/); }
  assert.equal(weeklyDelta(before, { ...after, fresh: false }, "2026-09-15T01:00:00.000Z"), "unavailable");
});
