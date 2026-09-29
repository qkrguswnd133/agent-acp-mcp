import type {McpServer} from '@modelcontextprotocol/server';
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

export function detectHost(server:McpServer):HostDetection {
  const info=(server.server as any).getClientVersion?.() as {name?:string;title?:string;version?:string}|undefined;
  const clientName=String(info?.name??'unknown');
  const clientTitle=info?.title?String(info.title):undefined;
  return {host:normalizeHost(clientName,clientTitle),clientName,clientTitle,clientVersion:info?.version?String(info.version):undefined};
}
