/**
 * The concurrency governor (§4.3). Parallelism is bounded by the scarcest
 * resource, not one number: four agents may think at once while only two run a
 * build. Sharing one limit is what makes N parallel runs slower than serial.
 */

export interface ConcurrencyLimits {
  maxActiveRuns: number;
  maxConcurrentGateJobs: number;
  maxConcurrentModelCalls: number;
  maxWorktrees: number;
}

export const DEFAULT_LIMITS: ConcurrencyLimits = {
  maxActiveRuns: 4,
  maxConcurrentGateJobs: 2,
  maxConcurrentModelCalls: 6,
  maxWorktrees: 8,
};

/** Machines under 16 GB thrash at the default (§19). */
export function limitsForMachine(totalMemoryBytes: number): ConcurrencyLimits {
  const gb = totalMemoryBytes / 1024 ** 3;
  if (gb < 16) return { ...DEFAULT_LIMITS, maxActiveRuns: 2, maxConcurrentGateJobs: 1 };
  return DEFAULT_LIMITS;
}

type Release = () => void;

export class Semaphore {
  private available: number;
  private readonly waiters: ((release: Release) => void)[] = [];

  constructor(readonly capacity: number, readonly name: string) {
    this.available = capacity;
  }

  get inUse(): number {
    return this.capacity - this.available;
  }

  get queueDepth(): number {
    return this.waiters.length;
  }

  acquire(): Promise<Release> {
    if (this.available > 0) {
      this.available -= 1;
      return Promise.resolve(this.releaseOnce());
    }
    return new Promise<Release>((resolve) => this.waiters.push(resolve));
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /** Releasing twice would inflate capacity, so a release is idempotent. */
  private releaseOnce(): Release {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next(this.releaseOnce());
      else this.available += 1;
    };
  }
}

export class Scheduler {
  readonly runs: Semaphore;
  readonly gates: Semaphore;
  readonly modelCalls: Semaphore;
  readonly worktrees: Semaphore;

  constructor(readonly limits: ConcurrencyLimits = DEFAULT_LIMITS) {
    this.runs = new Semaphore(limits.maxActiveRuns, 'runs');
    this.gates = new Semaphore(limits.maxConcurrentGateJobs, 'gates');
    this.modelCalls = new Semaphore(limits.maxConcurrentModelCalls, 'modelCalls');
    this.worktrees = new Semaphore(limits.maxWorktrees, 'worktrees');
  }

  stats(): Record<string, { inUse: number; capacity: number; queued: number }> {
    const of = (s: Semaphore) => ({ inUse: s.inUse, capacity: s.capacity, queued: s.queueDepth });
    return { runs: of(this.runs), gates: of(this.gates), modelCalls: of(this.modelCalls), worktrees: of(this.worktrees) };
  }
}
