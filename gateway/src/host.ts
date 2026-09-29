import {CLIENT_INFO_META_KEY,type McpServer,type ServerContext} from '@modelcontextprotocol/server';
import type {HostProvider} from './types.js';

export interface HostDetection {
  host: HostProvider;
  clientName: string;
  clientTitle?: string;
  clientVersion?: string;
}

/**
 * Clients whose identity carries no provider token, mapped only after observing
 * the real client. Exact match on purpose: an unverified generic name must still
 * fall through to 'unknown' so routing fails closed instead of guessing the host.
 *
 * Observed 2026-09-21:
 *   Claude Code (local agent mode) -> name "local-agent-mode-agent", no title
 *   Codex CLI                      -> name "codex-mcp-client", title "Codex" (already matches /codex/)
 */
const VERIFIED_CLIENT_NAMES:Record<string,HostProvider>={
  'local-agent-mode-agent':'claude'
};

export function normalizeHost(name?:string,title?:string):HostProvider {
  const exact=VERIFIED_CLIENT_NAMES[(name??'').trim().toLowerCase()];
  if(exact)return exact;
  const value=`${name??''} ${title??''}`.toLowerCase();
  if(/codex|openai.*codex|codex.*openai/.test(value))return 'codex';
  if(/claude|anthropic/.test(value))return 'claude';
  if(/grok|x\.ai|xai/.test(value))return 'grok';
  return 'unknown';
}

export function detectHost(server:McpServer,context?:ServerContext):HostDetection {
  // The 2026 stdio protocol carries identity per request, without initialize.
  // SDK v2 lifts reserved _meta keys into mcpReq.envelope. Never cache this
  // identity on the server or fall back to another request's initialized client.
  const envelope=context?.mcpReq.envelope;
  const candidate:unknown=envelope!==undefined
    ?(envelope as Record<string,unknown>)[CLIENT_INFO_META_KEY]
    :server.server.getClientVersion?.();
  if(!candidate||typeof candidate!=='object'||Array.isArray(candidate))return {host:'unknown',clientName:'unknown'};
  const info=candidate as Record<string,unknown>;
  if(typeof info.name!=='string'||!info.name.trim())return {host:'unknown',clientName:'unknown'};
  const clientName=info.name;
  const clientTitle=typeof info.title==='string'?info.title:undefined;
  return {host:normalizeHost(clientName,clientTitle),clientName,clientTitle,clientVersion:typeof info.version==='string'?info.version:undefined};
}
