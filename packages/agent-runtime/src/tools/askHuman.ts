import { z } from 'zod';

/**
 * The only channel through which an agent may ask a human (§7.2). Free-text
 * questions in assistant prose are ignored by the orchestrator and the UI does
 * not render them — otherwise a run can appear to be waiting when nothing is.
 */

export const AskHumanInput = z.object({
  question: z.string().max(280),
  whyItMatters: z.string().max(200),
  /**
   * Required and non-empty. Forces an evidence attempt before asking, and
   * reviewing these entries is how you discover the agent is asking things the
   * repo already answers — a prompt problem, not a user problem.
   */
  alreadyChecked: z.array(z.string()).min(1),
  options: z.array(z.object({ label: z.string(), implication: z.string() })).max(4).optional(),
  allowFreeText: z.boolean().default(true),
  blocking: z.boolean(),
  defaultIfUnanswered: z.string().optional(),
  confidenceWithoutAnswer: z.number().min(0).max(1),
});
export type AskHumanInput = z.infer<typeof AskHumanInput>;

export const ASK_HUMAN_DESCRIPTION =
  'Ask the human a blocking or non-blocking clarifying question. Use only after attempting to ' +
  'answer from the repository, the ticket, and the designs. State what you already checked.';

/** The error returned once a phase's budget is spent, written for the agent. */
export function budgetExhaustedError(phase: string, cap: number): string {
  return (
    `Question budget for phase ${phase} is spent (${cap}). Proceed with your best assumption ` +
    'and record it in assumptions[] with its impact if wrong. Do not ask again this phase.'
  );
}
