import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS, Scheduler, Semaphore, limitsForMachine } from './scheduler.js';

describe('Semaphore', () => {
  it('admits up to capacity and queues the rest', async () => {
    const s = new Semaphore(2, 'test');
    const a = await s.acquire();
    await s.acquire();
    expect(s.inUse).toBe(2);

    let third = false;
    const pending = s.acquire().then(() => { third = true; });
    await Promise.resolve();
    expect(third).toBe(false);
    expect(s.queueDepth).toBe(1);

    a();
    await pending;
    expect(third).toBe(true);
  });

  it('never exceeds capacity under contention', async () => {
    const s = new Semaphore(3, 'test');
    let live = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 30 }, () =>
        s.run(async () => {
          live += 1;
          peak = Math.max(peak, live);
          await new Promise((r) => setTimeout(r, 1));
          live -= 1;
        }),
      ),
    );
    expect(peak).toBeLessThanOrEqual(3);
    expect(s.inUse).toBe(0);
  });

  it('treats a double release as one', async () => {
    const s = new Semaphore(1, 'test');
    const release = await s.acquire();
    release();
    release();
    expect(s.inUse).toBe(0);
    await s.acquire();
    expect(s.inUse).toBe(1);
  });

  it('releases the slot when the task throws', async () => {
    const s = new Semaphore(1, 'test');
    await expect(s.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(s.inUse).toBe(0);
  });
});

describe('Scheduler (§4.3)', () => {
  it('meters gates and model calls independently', async () => {
    const sched = new Scheduler({ ...DEFAULT_LIMITS, maxConcurrentGateJobs: 1, maxConcurrentModelCalls: 4 });
    await sched.gates.acquire();
    // A saturated gate semaphore must not stop agents from thinking.
    await sched.modelCalls.acquire();
    await sched.modelCalls.acquire();
    expect(sched.stats()).toMatchObject({
      gates: { inUse: 1, capacity: 1 },
      modelCalls: { inUse: 2, capacity: 4 },
    });
  });

  it('halves parallelism on a small machine', () => {
    expect(limitsForMachine(8 * 1024 ** 3)).toMatchObject({ maxActiveRuns: 2, maxConcurrentGateJobs: 1 });
    expect(limitsForMachine(32 * 1024 ** 3)).toEqual(DEFAULT_LIMITS);
  });
});
