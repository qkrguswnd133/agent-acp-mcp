/** A normalized description of a provider-side limit response. */
export interface LimitClassification {
  errorKind: string;
  limitKind?: 'quota_exhausted' | 'rate_limited';
  /** An explicitly supplied reset instant, normalized to ISO-8601. */
  resetsAt?: string | null;
  /** An explicitly supplied retry instant, normalized to ISO-8601. */
  retryAfter?: string | null;
}

type ErrorRecord = Record<string, unknown>;

function isRecord(value: unknown): value is ErrorRecord {
  return !!value && typeof value === 'object';
}

function asText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isoAt(value: unknown, now: number, relativeSeconds = false): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const milliseconds = relativeSeconds ? now + value * 1000 : value < 100_000_000_000 ? value * 1000 : value;
    return Number.isFinite(milliseconds) && Math.abs(milliseconds) <= 8.64e15 ? new Date(milliseconds).toISOString() : undefined;
  }
  const text = asText(value);
  if (!text) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const numeric = Number(text);
    const milliseconds = relativeSeconds ? now + numeric * 1000 : numeric < 100_000_000_000 ? numeric * 1000 : numeric;
    return Number.isFinite(milliseconds) && Math.abs(milliseconds) <= 8.64e15 ? new Date(milliseconds).toISOString() : undefined;
  }
  // Date.parse treats timezone-free timestamps as local time. Only retain dates that
  // say where they are in time, such as an HTTP-date (GMT) or ISO offset.
  if (!/(?:\b(?:GMT|UTC)\b|Z$|[+-]\d\d:?\d\d$)/i.test(text)) return undefined;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function header(record: ErrorRecord, name: string): unknown {
  const headers = record.headers;
  if (!isRecord(headers)) return undefined;
  const expected = name.toLowerCase();
  return Object.entries(headers).find(([key]) => key.toLowerCase() === expected)?.[1];
}

function collect(record: ErrorRecord, depth = 0, seen = new Set<object>()): {text: string; status?: number; records: ErrorRecord[]} {
  if (depth > 5 || seen.has(record)) return {text: '', records: []};
  seen.add(record);
  const text: string[] = [];
  const records: ErrorRecord[] = [record];
  let status: number | undefined;
  for (const key of ['code', 'message', 'type', 'error_description', 'detail', 'reason']) {
    const value = asText(record[key]);
    if (value) text.push(value);
  }
  for (const key of ['status', 'statusCode', 'httpStatus']) {
    const value = record[key];
    const numeric = typeof value === 'number' ? value : Number(value);
    if (Number.isFinite(numeric) && numeric > 0) status = numeric;
  }
  for (const key of ['error', 'errors', 'data', 'response', 'cause', 'details', 'body']) {
    const value = record[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        const inlineItem = asText(item); if (inlineItem) { text.push(inlineItem); continue; }
        if (!isRecord(item)) continue;
        const nested = collect(item, depth + 1, seen);
        text.push(nested.text); records.push(...nested.records); status ??= nested.status;
      }
      continue;
    }
    const inline = asText(value); if (inline) { text.push(inline); continue; }
    if (!isRecord(value)) continue;
    const nested = collect(value, depth + 1, seen);
    text.push(nested.text);
    records.push(...nested.records);
    status ??= nested.status;
  }
  return {text: text.filter(Boolean).join(' '), status, records};
}

function evidence(records: ErrorRecord[], now: number): Pick<LimitClassification, 'resetsAt' | 'retryAfter'> {
  let resetsAt: string | undefined;
  let retryAfter: string | undefined;
  for (const record of records) {
    // Retry-After has defined seconds-or-HTTP-date semantics. RateLimit-Reset is
    // conventionally seconds, while x-ratelimit-reset is commonly an epoch.
    retryAfter ??= isoAt(header(record, 'retry-after'), now, true);
    const reset = header(record, 'x-ratelimit-reset') ?? record.resetsAt ?? record.resetAt;
    resetsAt ??= isoAt(reset, now);
    const rateReset = header(record, 'ratelimit-reset') ?? header(record, 'rate-limit-reset');
    resetsAt ??= isoAt(rateReset, now, true);
  }
  return {resetsAt: resetsAt ?? null, retryAfter: retryAfter ?? null};
}

/**
 * Classify a provider error without treating ordinary provider output as an error.
 * It accepts Error instances and structured error payloads; a string is supported
 * for CLI stderr compatibility.
 */
export function classifyProviderError(error: unknown, now = Date.now()): LimitClassification {
  const record: ErrorRecord = error instanceof Error
    ? {...Object.fromEntries(Object.getOwnPropertyNames(error).map(key => [key, (error as unknown as Record<string, unknown>)[key]])), message: error.message}
    : isRecord(error) ? error
    : Array.isArray(error) ? {errors: error}
    : {message: asText(error)};
  const collected = collect(record);
  const text = collected.text.toLowerCase();
  const explicit = evidence(collected.records, now);

  if (/(?:context[_ -]?(?:length|window)|maximum (?:context|input)|input (?:is )?too (?:long|large)|prompt (?:is )?too (?:long|large)|context_length_exceeded)/i.test(text)) {
    return {errorKind: 'context_limit'};
  }
  if (/(?:max(?:imum)?[_ -]?(?:output|completion)|output[_ -]?(?:token|length)|too many output tokens|finish_reason[=: ]+length)/i.test(text)) {
    return {errorKind: 'output_limit'};
  }

  const quota = /(?:subscription|plan|weekly|monthly|daily|usage|credit)s?[^.\n]{0,80}(?:quota|limit|exhausted|remaining)|(?:quota|usage|credit)s?[^.\n]{0,80}(?:exhausted|reached|exceeded)|insufficient[_ -]?(?:quota|credits)|billing[_ -]?hard[_ -]?limit/i.test(text);
  const rate = collected.status === 429 || /(?:rate[_ -]?limit|too many requests|throttl|retry[_ -]?after|request[_ -]?limit)/i.test(text);
  if (quota) return {errorKind: 'quota_exhausted', limitKind: 'quota_exhausted', ...explicit};
  if (rate) return {errorKind: 'rate_limited', limitKind: 'rate_limited', ...explicit};
  return {errorKind: 'task_error'};
}
