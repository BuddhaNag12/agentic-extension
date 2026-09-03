import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { ApprovalRequest, HumanGate, Question } from '@agentflow/protocol';

/**
 * The approval and question broker (§7). Questions are batched, never
 * drip-fed: the broker holds them until the phase ends or a quiescence timer
 * fires, then presents them as one form. Approval fatigue kills these tools
 * faster than bad code does.
 */

export const MAX_QUESTIONS_PER_PHASE = 5;
export const QUIESCENCE_MS = 20_000;

export interface PendingQuestion {
  runId: string;
  question: Question;
}

export class HitlBroker extends EventEmitter {
  private readonly questions = new Map<string, PendingQuestion>();
  private readonly approvals = new Map<string, ApprovalRequest>();
  private readonly perPhaseCount = new Map<string, number>();
  private quiescence?: NodeJS.Timeout;

  /**
   * Returns an error string when the phase's question budget is spent — the
   * agent is then expected to proceed on its best assumption and record it,
   * which is the point of the cap (§7.2).
   */
  ask(runId: string, question: Question): { ok: true } | { ok: false; error: string } {
    const key = `${runId}:${question.phase}`;
    const used = this.perPhaseCount.get(key) ?? 0;
    if (used >= MAX_QUESTIONS_PER_PHASE) {
      return {
        ok: false,
        error:
          `Question budget for phase ${question.phase} is spent (${MAX_QUESTIONS_PER_PHASE}). ` +
          'Proceed with your best assumption and record it in assumptions[] instead.',
      };
    }
    if (question.alreadyChecked.length === 0) {
      return { ok: false, error: 'alreadyChecked must list what you checked before asking.' };
    }
    this.perPhaseCount.set(key, used + 1);
    this.questions.set(question.id, { runId, question });
    this.scheduleFlush();
    return { ok: true };
  }

  answer(questionId: string): PendingQuestion | undefined {
    const pending = this.questions.get(questionId);
    this.questions.delete(questionId);
    this.emit('pendingChanged');
    return pending;
  }

  requestApproval(req: Omit<ApprovalRequest, 'id'>): ApprovalRequest {
    const full: ApprovalRequest = { ...req, id: randomUUID() };
    this.approvals.set(full.id, full);
    this.emit('pendingChanged');
    return full;
  }

  decide(approvalId: string): ApprovalRequest | undefined {
    const req = this.approvals.get(approvalId);
    if (!req) return undefined;
    this.approvals.delete(approvalId);
    this.emit('pendingChanged');
    return req;
  }

  pendingApprovalFor(runId: string, gate: HumanGate): ApprovalRequest | undefined {
    return [...this.approvals.values()].find((a) => a.runId === runId && a.gate === gate);
  }

  /**
   * Drop everything pending for a run. Called when a run reaches a terminal
   * state: an approval left in the inbox after the run finished is an offer to
   * decide something that no longer exists, and clicking it produces an error
   * rather than an outcome.
   */
  clearRun(runId: string): { questions: number; approvals: number } {
    let questions = 0;
    for (const [id, pending] of [...this.questions]) {
      if (pending.runId === runId) { this.questions.delete(id); questions += 1; }
    }
    let approvals = 0;
    for (const [id, approval] of [...this.approvals]) {
      if (approval.runId === runId) { this.approvals.delete(id); approvals += 1; }
    }
    for (const key of [...this.perPhaseCount.keys()]) {
      if (key.startsWith(`${runId}:`)) this.perPhaseCount.delete(key);
    }
    if (questions + approvals > 0) this.emit('pendingChanged');
    return { questions, approvals };
  }

  /** A new phase gets a fresh question budget. */
  resetPhase(runId: string, phase: string): void {
    this.perPhaseCount.delete(`${runId}:${phase}`);
  }

  pending(): { questions: PendingQuestion[]; approvals: ApprovalRequest[] } {
    return { questions: [...this.questions.values()], approvals: [...this.approvals.values()] };
  }

  dispose(): void {
    if (this.quiescence) clearTimeout(this.quiescence);
  }

  private scheduleFlush(): void {
    if (this.quiescence) clearTimeout(this.quiescence);
    this.quiescence = setTimeout(() => this.emit('pendingChanged'), QUIESCENCE_MS);
    // Surface immediately too; the timer only bounds how long a straggler waits.
    this.emit('pendingChanged');
  }
}
