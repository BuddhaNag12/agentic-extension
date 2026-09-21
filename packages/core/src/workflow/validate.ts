import {
  FORBIDDEN_ROLES, MODEL_CATALOGUE, PHASE_OF_STEP, requiredHumanGates,
  type OrgPolicy, type Step, type WorkflowDefinition, type WorkflowIssue,
} from '@agentflow/protocol';
import { PHASE_ORDER } from '../fsm/profiles.js';
import { gateFor, gateForStep } from '../fsm/machine.js';

/**
 * Workflow validation, rules W1–W8 (§21.5).
 *
 * W5–W7 are the load-bearing ones: a workflow may only be **stricter** than the
 * org policy, never looser. Without that the whole configuration surface
 * becomes a way to opt out of the controls in §14.
 */

/**
 * Phases a run cannot do without. Intake identifies the work; preflight is the
 * §5.3 safety phase whose whole reason for existing is that skipping it means
 * discovering an environmental failure at minute 25 instead of minute 1.
 */
const UNSKIPPABLE_PHASES = new Set<string>(['intake', 'preflight']);

/**
 * The whole step vocabulary, not just the sequenced part: `repair` and
 * `human_review` are absent from `STEP_ORDER` because a trigger enters them,
 * and naming one in `skipSteps` should be refused for its gate or its loop,
 * not as though the step did not exist.
 */
const ALL_STEPS = new Set<string>(Object.keys(PHASE_OF_STEP));

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
  const demanded = requiredHumanGates(policy.maxAutonomy, wf.kind);
  const missingHuman = demanded.filter((g) => !wf.hitl.gates.includes(g));
  if (missingHuman.length > 0) {
    reject('W6',
      `org policy autonomy "${policy.maxAutonomy}" requires human gates ${demanded.join(', ')} ` +
      `for a ${wf.kind} pipeline; missing ${missingHuman.join(', ')}`,
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
    if (UNSKIPPABLE_PHASES.has(phase)) {
      reject('W8', `"${phase}" cannot be skipped`, 'pipeline.skip');
    }
    const gate = gateFor(phase);
    if (gate && wf.hitl.gates.includes(gate)) {
      reject('W8',
        `skips "${phase}" but still requires gate ${gate}, which is decided in that phase`,
        'pipeline.skip');
    }
  }

  const skippedSteps = new Set<string>(wf.pipeline.skipSteps);
  for (const step of wf.pipeline.skipSteps) {
    if (!ALL_STEPS.has(step)) {
      reject('W8', `cannot skip "${step}": it is not a pipeline step`, 'pipeline.skipSteps');
      continue;
    }
    // Gates hang off step exits, so skipping the step silently removes the
    // gate — which is the D13 contradiction one level down, and the exact way
    // a configuration surface becomes a way to opt out of §9.1's three gates.
    const stepGate = gateForStep(step);
    if (stepGate && wf.hitl.gates.includes(stepGate)) {
      reject('W8',
        `skips "${step}" but still requires gate ${stepGate}, which is decided on that step's exit`,
        'pipeline.skipSteps');
    }
  }
  // Verification without implementation, or shipping without either, is
  // incoherent. A step is gone if it was skipped by name *or* because the
  // phase around it was — skipping `build` takes `verify` with it.
  const skipped = new Set<string>(wf.pipeline.skip);
  const gone = (step: Step) => skippedSteps.has(step) || skipped.has(PHASE_OF_STEP[step]);
  if (gone('implement') && !gone('verify')) {
    reject('W8', 'skips "implement" but keeps "verify": there would be nothing to verify', 'pipeline.skipSteps');
  }
  if (gone('verify') && !skipped.has('ship')) {
    reject('W8', 'skips "verify" but still ships: nothing would machine-check the change', 'pipeline.skipSteps');
  }

  return issues;
}

export function isRunnable(issues: readonly WorkflowIssue[]): boolean {
  return issues.length === 0;
}

export function rejections(issues: readonly WorkflowIssue[]): WorkflowIssue[] {
  return issues.filter((i) => i.severity === 'reject');
}
