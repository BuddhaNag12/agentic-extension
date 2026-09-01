import type { GateId } from '@agentflow/protocol';
import type { GateAdapter, RepoContext } from './adapter.js';
import { NODE_ADAPTERS } from './adapters/node.js';

/**
 * Adapter registry. Detection runs once per repo and the result is written to
 * `.agentflow/gates.yaml`, which is then hand-editable and always wins —
 * auto-detection that cannot be overridden is worse than none (§12.2).
 */
export class GateRegistry {
  private readonly adapters = new Map<GateId, GateAdapter>();

  constructor(adapters: GateAdapter[] = NODE_ADAPTERS) {
    for (const a of adapters) this.adapters.set(a.id, a);
  }

  register(adapter: GateAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  get(id: GateId): GateAdapter | undefined {
    return this.adapters.get(id);
  }

  detect(repo: RepoContext): GateAdapter[] {
    return [...this.adapters.values()].filter((a) => a.detect(repo)).sort(byCost);
  }

  /** Resolve requested gate ids to adapters, reporting which are unknown. */
  resolve(ids: readonly GateId[]): { adapters: GateAdapter[]; missing: GateId[] } {
    const adapters: GateAdapter[] = [];
    const missing: GateId[] = [];
    for (const id of ids) {
      const adapter = this.adapters.get(id);
      if (adapter) adapters.push(adapter);
      else missing.push(id);
    }
    return { adapters: adapters.sort(byCost), missing };
  }
}

/** Cheapest first, so the ladder fails fast (§12.1). */
function byCost(a: GateAdapter, b: GateAdapter): number {
  if (a.level !== b.level) return a.level - b.level;
  return (a.estimatedMs?.({ files: [] }) ?? 0) - (b.estimatedMs?.({ files: [] }) ?? 0);
}
