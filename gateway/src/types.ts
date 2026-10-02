export type ProviderName = 'grok' | 'claude' | 'codex';
export type HostProvider = ProviderName | 'unknown';
export type AgentKind = 'agent_ask' | 'agent_review' | 'agent_investigate' | 'agent_implement';
export type QuotaState = 'available' | 'exhausted' | 'unknown';

export interface RunInput {
  task: string;
  cwd: string;
  provider?: string;
  allow_self_provider?: boolean;
  model?: string;
  effort?: string;
  selection_reason?: string;
  provider_options?: Partial<Record<ProviderName,{model?:string;effort?:string;selection_reason?:string}>>;
  context?: string;
  completion_criteria?: string;
  allowed_paths?: string[];
  session_id?: string;
  workspace_mode?: 'auto'|'current'|'isolated';
  base_ref?: string;
  max_runtime_minutes?: number;
  /** Internal shared deadline; never accepted as a public MCP argument. */
  deadlineAt?: number;
}

export interface RunHooks {
  onActivity?: (event: Record<string, unknown>) => void;
}

export interface QuotaStatus {
  state: QuotaState;
  source: string;
  usedPercent?: number;
  remainingPercent?: number;
  resetsAt?: string | number | null;
  retryAfter?: string | null;
  limitKind?: 'quota_exhausted' | 'rate_limited';
  note?: string;
  observedAt?: string | null;
  stale?: boolean;
  selectedWindow?: string | null;
  windows?: Array<{id:string;label:string;usedPercent:number;remainingPercent:number;resetsAt:string|null}>;
}

export interface ProviderStatus {
  account?: import('./account.js').AccountStatus;
  provider: ProviderName;
  enabled: boolean;
  available: boolean;
  authenticated: boolean | 'unknown';
  subscriptionAuth?: boolean | 'unknown';
  version: string;
  modelPolicy: string;
  effortPolicy: string;
  resolvedModel?: string;
  resolvedEffort?: string;
  modelCatalog?: import('./model-catalog.js').ModelCatalog;
  quota: QuotaStatus;
  reason?: string;
}

export interface ProviderRunResult {
  selection?: import('./model-settings.js').RunSelection;
  observation?: {model:SettingObservation;effort:SettingObservation};
  provider: ProviderName;
  text: string;
  error?: string | null;
  errorKind?: string | null;
  model?: string;
  effort?: string;
  sessionId?: string;
  handoff?: {
    requiresWorkspaceReview: true;
    cwd: string;
    allowedPaths: string[];
    kind: AgentKind;
    reason: string;
    sessionId: string;
    nextAction: 'review_workspace_before_continuing';
    changes: 'unverified';
  };
  [key: string]: unknown;
}

export interface ProviderAdapter {
  readonly name: ProviderName;
  status(force?: boolean): Promise<ProviderStatus>;
  run(kind: AgentKind, input: RunInput, signal?: AbortSignal, hooks?: RunHooks): Promise<ProviderRunResult>;
  cliStatus(): Promise<ProviderStatus>;
  update(): Promise<unknown>;
  models?(force?:boolean): Promise<import('./model-catalog.js').ModelCatalog>;
}
export interface SettingObservation {value:string;source:string;verified:boolean}

export interface SkippedProvider {
  provider: ProviderName;
  reason: string;
}
