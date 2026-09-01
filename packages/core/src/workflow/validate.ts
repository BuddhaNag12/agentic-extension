import {
  AUTONOMY_GATES, FORBIDDEN_ROLES, MODEL_CATALOGUE,
  type OrgPolicy, type WorkflowDefinition, type WorkflowIssue,
} from '@agentflow/protocol';
import { PHASE_ORDER } from '../fsm/profiles.js';

/**
 * Workflow validation, rules W1–W8 (§21.5).
 *
 * W5–W7 are the load-bearing ones: a workflow may only be **stricter** than the
 * org policy, never looser. Without that the whole configuration surface
 * becomes a way to opt out of the controls in §14.
 */

/** Phases that carry a human gate; skipping one must also drop its gate (W8). */
const GATED_PHASES = { clarify: 'G1', plan: 'G2', human_review: 'G3' } as const;

export function validateWorkflow(
  wf: WorkflowDefinition,
  policy: OrgPolicy,
  known: ReadonlySet<string>,
): WorkflowIssue[] {
  const issues: WorkflowIssue[] = [];
  const reject = (rule: WorkflowIssue['rule'], message: string, path?: string) =>
    issues.push({ rule, severity: 'reject', message, ...(path ? { path } : {}) });

  // W2 — `extends` must resolve. Cycles are detected during resolution.
  if (wf.extends && !known.has(wf.extends)) {
    reject('W2', `extends "${wf.extends}", which is not a known workflow`, 'extends');
  }
  if (wf.extends === wf.name) {
    reject('W2', 'a workflow cannot extend itself', 'extends');
  }

  // W3 — every alias must resolve. Blocks the workflow rather than rejecting
  // it, so an unknown model does not delete a definition from the user's disk.
  // The schema's enum rejects a bad alias first; the catalogue check below
  // exists so that enum and catalogue drifting apart is caught rather than
  // producing a workflow bound to a model with no price and no ID.
  for (const [role, binding] of Object.entries(wf.agents)) {
    if (!binding) continue;
    if (!(binding.model in MODEL_CATALOGUE)) {
      issues.push({
        rule: 'W3', severity: 'block', path: `agents.${role}.model`,
        message: `unknown model alias "${binding.model}"`,
      });
    }
    if (policy.forbiddenModels.includes(binding.model)) {
      issues.push({
        rule: 'W3', severity: 'block', path: `agents.${role}.model`,
        message: `model "${binding.model}" is forbidden by org policy`,
      });
    }
    if (binding.escalateTo && policy.forbiddenModels.includes(binding.escalateTo)) {
      issues.push({
        rule: 'W3', severity: 'block', path: `agents.${role}.escalateTo`,
        message: `escalation model "${binding.escalateTo}" is forbidden by org policy`,
      });
    }
  }

  // W4 — the verifier has no model and cannot be given one (§21.3).
  for (const forbidden of FORBIDDEN_ROLES) {
    if (forbidden in wf.agents) {
      reject('W4',
        `"${forbidden}" cannot be bound to a model: verification is deterministic, ` +
        'and a model in that seat would let a workflow assert its own correctness',
        `agents.${forbidden}`);
    }
  }

  // W5 — every policy-required gate must be present.
  const missingGates = policy.requiredGates.filter((g) => !wf.pipeline.gates.required.includes(g));
  if (missingGates.length > 0) {
    reject('W5', `missing gates required by org policy: ${missingGates.join(', ')}`, 'pipeline.gates.required');
  }

  // W6 — human gates must be a superset of what the autonomy level demands.
  const requiredHumanGates = AUTONOMY_GATES[policy.maxAutonomy];
  const missingHuman = requiredHumanGates.filter((g) => !wf.hitl.gates.includes(g));
  if (missingHuman.length > 0) {
    reject('W6',
      `org policy autonomy "${policy.maxAutonomy}" requires human gates ${requiredHumanGates.join(', ')}; ` +
      `missing ${missingHuman.join(', ')}`,
      'hitl.gates');
  }

  // W7 — forbidden paths must be a superset, and a workflow cannot re-enable
  // dependency changes that policy forbids.
  const droppedPaths = policy.forbiddenPaths.filter((p) => !wf.guardrails.forbiddenPaths.includes(p));
  if (droppedPaths.length > 0) {
    reject('W7', `drops paths the org policy forbids: ${droppedPaths.join(', ')}`, 'guardrails.forbiddenPaths');
  }
  if (wf.guardrails.allowDependencyChanges && !policy.allowDependencyChanges) {
    reject('W7', 'org policy forbids dependency changes', 'guardrails.allowDependencyChanges');
  }
  if (policy.maxPerRunUsd !== undefined && wf.budgets.perRunUsd > policy.maxPerRunUsd) {
    reject('W7',
      `perRunUsd ${wf.budgets.perRunUsd} exceeds the org policy maximum of ${policy.maxPerRunUsd}`,
      'budgets.perRunUsd');
  }

  // W8 — the remaining pipeline must be coherent.
  for (const phase of wf.pipeline.skip) {
    if (!PHASE_ORDER.includes(phase)) {
      reject('W8', `cannot skip "${phase}": it is not a pipeline phase`, 'pipeline.skip');
      continue;
    }
    if (phase === 'intake' || phase === 'done') {
      reject('W8', `"${phase}" cannot be skipped`, 'pipeline.skip');
    }
    const gate = GATED_PHASES[phase as keyof typeof GATED_PHASES];
    if (gate && wf.hitl.gates.includes(gate)) {
      reject('W8',
        `skips "${phase}" but still requires gate ${gate}, which is decided in that phase`,
        'pipeline.skip');
    }
  }
  // Verification without implementation, or review without either, is incoherent.
  const skipped = new Set(wf.pipeline.skip);
  if (skipped.has('implement') && !skipped.has('verify')) {
    reject('W8', 'skips "implement" but keeps "verify": there would be nothing to verify', 'pipeline.skip');
  }
  if (skipped.has('verify') && !skipped.has('ship')) {
    reject('W8', 'skips "verify" but still ships: nothing would machine-check the change', 'pipeline.skip');
  }

  return issues;
}

export function isRunnable(issues: readonly WorkflowIssue[]): boolean {
  return issues.length === 0;
}

export function rejections(issues: readonly WorkflowIssue[]): WorkflowIssue[] {
  return issues.filter((i) => i.severity === 'reject');
}
