import type { Phase, PipelineProfile } from '@agentflow/protocol';

/**
 * The linear spine of the pipeline (§5). Branching (repair, re-spec, rejection)
 * is expressed as transitions in the machine; this only orders the happy path.
 */
export const PHASE_ORDER: readonly Phase[] = [
  'intake', 'harvest', 'spec', 'clarify', 'plan', 'decompose',
  'implement', 'verify', 'review', 'wait_for_ci', 'human_review', 'ship', 'done',
] as const;

export interface ProfileConfig {
  /** Phases the profile never enters (§5.10). */
  skips: readonly Phase[];
  /** Gates that must pass for this profile even if otherwise optional. */
  requiredGates: readonly string[];
}

export const PROFILES: Record<PipelineProfile, ProfileConfig> = {
  feature: { skips: [], requiredGates: [] },
  bug: { skips: [], requiredGates: ['repro_test'] },
  /** Chore skips clarify unless a blocking question forces it back (§5.10). */
  chore: { skips: ['clarify'], requiredGates: [] },
  refactor: { skips: ['clarify'], requiredGates: ['behaviour_preservation'] },
  spike: { skips: ['implement', 'verify', 'review', 'wait_for_ci', 'ship'], requiredGates: [] },
};

export interface PipelineOptions {
  profile: PipelineProfile;
  /** §20.3: CI is the pre-ship truth. Off until M2 ships a real ship phase. */
  waitForCi: boolean;
  /** Set when clarify raised a blocking question on a profile that skips it. */
  forceClarify?: boolean;
}

function isSkipped(phase: Phase, opts: PipelineOptions): boolean {
  if (phase === 'wait_for_ci') return !opts.waitForCi;
  if (phase === 'clarify' && opts.forceClarify) return false;
  return PROFILES[opts.profile].skips.includes(phase);
}

/** The next phase on the happy path, skipping whatever the profile omits. */
export function nextPhase(current: Phase, opts: PipelineOptions): Phase | undefined {
  let i = PHASE_ORDER.indexOf(current);
  if (i < 0) return undefined;
  for (i += 1; i < PHASE_ORDER.length; i += 1) {
    const candidate = PHASE_ORDER[i]!;
    if (!isSkipped(candidate, opts)) return candidate;
  }
  return undefined;
}

/** The phases a profile will actually visit — used by the UI to draw progress. */
export function plannedPhases(opts: PipelineOptions): Phase[] {
  return PHASE_ORDER.filter((p) => !isSkipped(p, opts));
}
