// Circuit breaker (Nygard, "Release It!"): after repeated failures stop calling a sick
// dependency for a cool-down period, then let a single probe request through.

export type BreakerState = 'closed' | 'open' | 'half-open';

export interface BreakerOptions {
  /** Consecutive failures that open the circuit. */
  readonly failureThreshold: number;
  /** How long the circuit stays open before a probe is allowed. */
  readonly cooldownMs: number;
  readonly now: () => number;
}

export class CircuitBreaker {
  private state: BreakerState = 'closed';
  private consecutiveFailures = 0;
  private openedAt = 0;
  private probeInFlight = false;

  constructor(readonly name: string, private readonly opts: BreakerOptions) {}

  /** Returns true if a call may proceed. In half-open state only one probe is admitted. */
  tryAcquire(): boolean {
    if (this.state === 'open') {
      if (this.opts.now() - this.openedAt < this.opts.cooldownMs) return false;
      this.state = 'half-open';
    }
    if (this.state === 'half-open') {
      if (this.probeInFlight) return false;
      this.probeInFlight = true;
    }
    return true;
  }

  onSuccess(): void {
    this.state = 'closed';
    this.consecutiveFailures = 0;
    this.probeInFlight = false;
  }

  onFailure(): void {
    this.probeInFlight = false;
    this.consecutiveFailures += 1;
    if (this.state === 'half-open' || this.consecutiveFailures >= this.opts.failureThreshold) {
      this.state = 'open';
      this.openedAt = this.opts.now();
    }
  }

  /** A failure that says nothing about the dependency's health (e.g. 404) must not trip the breaker. */
  onNeutral(): void {
    this.probeInFlight = false;
    if (this.state === 'half-open') this.state = 'closed';
  }

  snapshot(): { name: string; state: BreakerState; consecutiveFailures: number } {
    // report "open" accurately even if nobody called tryAcquire since the cool-down ended
    const state = this.state === 'open' && this.opts.now() - this.openedAt >= this.opts.cooldownMs ? 'half-open' : this.state;
    return { name: this.name, state, consecutiveFailures: this.consecutiveFailures };
  }
}
