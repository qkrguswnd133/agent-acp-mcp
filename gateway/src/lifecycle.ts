export type LifecycleErrorKind = 'cancelled' | 'deadline_exceeded';

export interface TimerDriver {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

const systemTimer: TimerDriver = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: handle => clearTimeout(handle as NodeJS.Timeout),
};

export interface LifecycleControllerOptions {
  deadlineMs: number;
  graceMs?: number;
  timer?: TimerDriver;
  onCancel?: (kind: LifecycleErrorKind) => void | Promise<void>;
  onForce?: (kind: LifecycleErrorKind) => void | Promise<void>;
}

/**
 * Owns a single task deadline. Activity is observable but deliberately never
 * resets the deadline: a busy agent must still finish within the requested
 * task-wide runtime.
 */
export class LifecycleController {
  readonly signal: AbortSignal;
  private readonly abortController = new AbortController();
  private readonly timer: TimerDriver;
  private readonly graceMs: number;
  private deadlineTimer: unknown;
  private forceTimer: unknown;
  private abortListener?: () => void;
  private _reason?: LifecycleErrorKind;
  private _forced = false;
  private _lastActivityAt?: number;
  private settle!: () => void;
  private readonly stopOutcome = new Promise<void>(resolve => { this.settle = resolve; });

  constructor(private readonly options: LifecycleControllerOptions) {
    if (!Number.isFinite(options.deadlineMs) || options.deadlineMs <= 0) throw Error('deadlineMs must be positive');
    this.timer = options.timer ?? systemTimer;
    this.graceMs = options.graceMs ?? 30_000;
    this.signal = this.abortController.signal;
  }

  get reason(): LifecycleErrorKind | undefined { return this._reason; }
  get forced(): boolean { return this._forced; }
  get lastActivityAt(): number | undefined { return this._lastActivityAt; }

  /** Resolves when cancellation is acknowledged or the grace period escalates. */
  waitForStopOutcome(): Promise<void> { return this.stopOutcome; }

  startDeadline(): void {
    if (this._reason || this.deadlineTimer !== undefined) return;
    this.deadlineTimer = this.timer.setTimeout(() => this.requestStop('deadline_exceeded'), this.options.deadlineMs);
  }

  attach(signal?: AbortSignal): void {
    if (!signal) return;
    this.abortListener = () => this.requestStop('cancelled');
    signal.addEventListener('abort', this.abortListener, {once: true});
    if (signal.aborted) this.requestStop('cancelled');
  }

  recordActivity(): void {
    this._lastActivityAt = this.timer.now();
  }

  requestStop(kind: LifecycleErrorKind): void {
    if (this._reason) return;
    this._reason = kind;
    this.clearDeadline();
    this.abortController.abort();
    void this.options.onCancel?.(kind);
    this.forceTimer = this.timer.setTimeout(() => {
      if (!this._reason || this._forced) return;
      this._forced = true;
      void this.options.onForce?.(this._reason);
      this.settle();
    }, this.graceMs);
  }

  /** Call after the agent has acknowledged cancellation or completed normally. */
  complete(): void {
    this.clearDeadline();
    if (this.forceTimer !== undefined) {
      this.timer.clearTimeout(this.forceTimer);
      this.forceTimer = undefined;
    }
    this.settle();
  }

  dispose(signal?: AbortSignal): void {
    this.complete();
    if (signal && this.abortListener) signal.removeEventListener('abort', this.abortListener);
    this.abortListener = undefined;
  }

  private clearDeadline(): void {
    if (this.deadlineTimer !== undefined) {
      this.timer.clearTimeout(this.deadlineTimer);
      this.deadlineTimer = undefined;
    }
  }
}
