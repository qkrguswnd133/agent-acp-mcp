import fs from 'node:fs/promises';
import path from 'node:path';
import type {ProviderName, QuotaStatus} from './types.js';
import {quotaRetryMs} from './config.js';
import type {LimitClassification} from './limits.js';

type LimitKind = NonNullable<LimitClassification['limitKind']>;
interface Entry {quota: QuotaStatus; limitKind?: LimitKind; resetsAt: string | null; retryAfter: number | null; updatedAt: string; observedAt: number;}
interface CacheFile {schemaVersion: 2; providers: Partial<Record<ProviderName, Entry>>;}
export interface QuotaCacheOptions {now?: () => number; quotaRetryMs?: number; rateRetryMs?: number;}

function isoTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || !/(?:Z$|[+-]\d\d:?\d\d$)/i.test(value)) return null;
  const parsed = Date.parse(value); return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}
function isoNumberTimestamp(value: number): string | null {
  const milliseconds = value < 100_000_000_000 ? value * 1000 : value;
  return Number.isFinite(milliseconds) && Math.abs(milliseconds) <= 8.64e15 ? new Date(milliseconds).toISOString() : null;
}
function timestamp(value: unknown, seconds = false): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const milliseconds = seconds ? value * 1000 : value;
    return Number.isFinite(milliseconds) && Math.abs(milliseconds) <= 8.64e15 ? milliseconds : null;
  }
  const parsed = isoTimestamp(value); return parsed ? Date.parse(parsed) : null;
}
function observation(value: number | string | undefined, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return timestamp(value) ?? fallback;
}
function pause(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)); }

/** Durable, process-shared telemetry cache. Each operation locks and re-reads. */
export class QuotaCache {
  private readonly clock: () => number; private readonly quotaDelay: number; private readonly rateDelay: number;
  constructor(private readonly file: string, options: QuotaCacheOptions | (() => number) = {}) {
    const value = typeof options === 'function' ? {now: options} : options;
    this.clock = value.now ?? Date.now; this.quotaDelay = Math.max(1, value.quotaRetryMs ?? quotaRetryMs); this.rateDelay = Math.max(1, value.rateRetryMs ?? 60_000);
  }
  private async read(): Promise<CacheFile> {
    try {
      const raw: unknown = JSON.parse(await fs.readFile(this.file, 'utf8'));
      const isV2 = !!raw && typeof raw === 'object' && (raw as {schemaVersion?: unknown}).schemaVersion === 2;
      const source = isV2 ? (raw as {providers?: unknown}).providers : raw;
      const providers: CacheFile['providers'] = {};
      if (!source || typeof source !== 'object') return {schemaVersion: 2, providers};
      for (const provider of ['grok', 'claude', 'codex'] as const) {
        const candidate = (source as Record<string, unknown>)[provider]; if (!candidate || typeof candidate !== 'object') continue;
        const legacy = candidate as {quota?: unknown; blockedUntil?: unknown; retryAfter?: unknown; resetsAt?: unknown; limitKind?: unknown; updatedAt?: unknown; observedAt?: unknown};
        if (!legacy.quota || typeof legacy.quota !== 'object') continue;
        // v1 used a locally invented fallback as quota.resetsAt; drop all such values.
        const reset = isV2 ? isoTimestamp(legacy.resetsAt) : null;
        const retry = isV2 ? timestamp(legacy.retryAfter) : timestamp(legacy.blockedUntil);
        const quota = {...legacy.quota as QuotaStatus, resetsAt: reset};
        const observedAt = typeof legacy.observedAt === 'number' && Number.isFinite(legacy.observedAt) ? legacy.observedAt : Date.parse(typeof legacy.updatedAt === 'string' ? legacy.updatedAt : '') || 0;
        const limitKind = legacy.limitKind === 'rate_limited' || legacy.limitKind === 'quota_exhausted' ? legacy.limitKind : quota.state === 'exhausted' ? 'quota_exhausted' : undefined;
        quota.limitKind = limitKind; quota.retryAfter = retry ? new Date(retry).toISOString() : null;
        providers[provider] = {quota, limitKind, resetsAt: reset, retryAfter: retry, updatedAt: typeof legacy.updatedAt === 'string' ? legacy.updatedAt : new Date(observedAt || this.clock()).toISOString(), observedAt};
      }
      return {schemaVersion: 2, providers};
    } catch { return {schemaVersion: 2, providers: {}}; }
  }
  private async write(data: CacheFile): Promise<void> {
    const temporary = `${this.file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    try { await fs.mkdir(path.dirname(this.file), {recursive: true}); await fs.writeFile(temporary, JSON.stringify(data, null, 2), 'utf8'); await fs.rename(temporary, this.file); }
    catch { await fs.unlink(temporary).catch(() => undefined); throw new Error('quota cache telemetry write failed'); }
  }
  private async acquire(): Promise<fs.FileHandle | undefined> {
    const lock = `${this.file}.lock`; try { await fs.mkdir(path.dirname(this.file), {recursive: true}); } catch { return undefined; }
    for (let attempt = 0; attempt < 100; attempt++) { try { return await fs.open(lock, 'wx'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return undefined; try { const stat = await fs.stat(lock); if (Date.now() - stat.mtimeMs > 10_000) await fs.unlink(lock); } catch {} await pause(10); } }
    return undefined;
  }
  private async locked<T>(operation: (data: CacheFile) => Promise<{value: T; changed?: boolean}> | {value: T; changed?: boolean}): Promise<T | undefined> {
    const handle = await this.acquire(); if (!handle) return undefined;
    try { const data = await this.read(); const result = await operation(data); if (result.changed) await this.write(data); return result.value; }
    catch { return undefined; }
    finally { await handle.close().catch(() => undefined); await fs.unlink(`${this.file}.lock`).catch(() => undefined); }
  }
  private active(entry: Entry, now: number): boolean { return !!entry.limitKind && !!entry.retryAfter && entry.retryAfter > now; }
  async get(provider: ProviderName): Promise<QuotaStatus | undefined> {
    // Keep expired limit evidence. It is needed to invalidate a status/billing
    // snapshot another process obtained before the limit was observed.
    const result = await this.locked(data => { const entry = data.providers[provider]; if (!entry || (entry.limitKind && !this.active(entry, this.clock()))) return {value: undefined}; return {value: entry.quota}; });
    if (result !== undefined) return result;
    // Lock contention must not turn an active recorded limit into an eligible provider.
    const entry = (await this.read()).providers[provider];
    return entry && this.active(entry, this.clock()) ? entry.quota : undefined;
  }
  /**
   * True when a runtime limit was observed after a caller's provider-status
   * snapshot. This remains true after the cooldown so callers refresh instead
   * of trusting a short-lived in-memory available/billing result.
   */
  async needsRefresh(provider: ProviderName, sinceEpochMs: number): Promise<boolean> {
    const entry = (await this.read()).providers[provider];
    return !!entry?.limitKind && Number.isFinite(sinceEpochMs) && entry.observedAt >= sinceEpochMs;
  }
  async markAvailable(provider: ProviderName, source = 'runtime_success', observedAt?: number | string): Promise<void> {
    await this.locked(data => { const now = this.clock(), observed = observation(observedAt, now); const current = data.providers[provider]; if (current && this.active(current, now) && current.observedAt >= observed) return {value: undefined}; data.providers[provider] = {quota: {state: 'available', source}, resetsAt: null, retryAfter: null, updatedAt: new Date(now).toISOString(), observedAt: observed}; return {value: undefined, changed: true}; });
  }
  async markLimited(provider: ProviderName, classification: LimitClassification, note: string, observedAt?: number | string): Promise<void> {
    if (classification.limitKind !== 'quota_exhausted' && classification.limitKind !== 'rate_limited') return;
    await this.locked(data => { const now = this.clock(), observed = observation(observedAt, now); const reset = isoTimestamp(classification.resetsAt); const retry = isoTimestamp(classification.retryAfter); const preferred = classification.limitKind === 'quota_exhausted' ? reset ?? retry : retry ?? reset; const cooldown = preferred ? Date.parse(preferred) : now + (classification.limitKind === 'rate_limited' ? this.rateDelay : this.quotaDelay); const retryAfter = Math.max(cooldown, now + 1); const current = data.providers[provider]; if (current && current.observedAt > observed && this.active(current, now)) return {value: undefined}; data.providers[provider] = {quota: {state: 'exhausted', source: 'runtime_limit_error', resetsAt: reset, retryAfter: new Date(retryAfter).toISOString(), limitKind: classification.limitKind, note}, limitKind: classification.limitKind, resetsAt: reset, retryAfter, updatedAt: new Date(now).toISOString(), observedAt: observed}; return {value: undefined, changed: true}; });
  }
  /** Backwards-compatible quota-only entry point used by older adapters. */
  async markExhausted(provider: ProviderName, note: string, resetsAt?: string | number | null, observedAt?: number | string): Promise<void> {
    const reset = typeof resetsAt === 'number' ? isoNumberTimestamp(resetsAt) : isoTimestamp(resetsAt);
    await this.markLimited(provider, {errorKind: 'quota_exhausted', limitKind: 'quota_exhausted', resetsAt: reset, retryAfter: reset}, note, observedAt);
  }
  async clear(provider: ProviderName): Promise<void> { await this.locked(data => { if (!data.providers[provider]) return {value: undefined}; delete data.providers[provider]; return {value: undefined, changed: true}; }); }
}
