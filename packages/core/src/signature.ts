import { createHash } from 'node:crypto';
import type { Failure } from '@agentflow/protocol';

/**
 * Failure signatures (§9.1). A signature is a hash of the *normalized* failure
 * set, so "the same failure again" is detectable even when line numbers, temp
 * paths, hex ids, durations and ordering shift between attempts.
 *
 * This is what makes repair progress measurable, and it is the cheapest
 * saving in the whole system: thrash is pure waste.
 */

/** Applied to an already-lowercased string, so every pattern here is case-insensitive. */
const NOISE: [RegExp, string][] = [
  [/\b0x[0-9a-f]+\b/gi, '<addr>'],
  [/\b[0-9a-f]{7,40}\b/gi, '<hash>'],
  [/\b\d+(\.\d+)?\s?m?s\b/gi, '<dur>'],
  [/\b\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}:\d{2}\S*/gi, '<ts>'],
  [/(\/tmp|\/var\/folders)\/\S+/g, '<tmp>'],
  [/@[0-9a-f]{6,}/gi, '@<id>'],
  [/\b\d+\b/g, '<n>'],
  [/\s+/g, ' '],
];

export function normalizeMessage(message: string): string {
  let out = message.toLowerCase().trim();
  for (const [re, sub] of NOISE) out = out.replace(re, sub);
  return out.trim();
}

/** One failure reduced to its identity: where, which rule, what (normalized). */
export function normalizeFailure(f: Failure): string {
  return [f.file ?? '<nofile>', f.rule ?? '<norule>', normalizeMessage(f.message)].join('|');
}

/**
 * Signature of a failure set. Line numbers are dropped and order is ignored,
 * so a fix that only shifts code around does not read as progress.
 */
export function failureSignature(failures: readonly Failure[]): string {
  if (failures.length === 0) return 'green';
  const parts = [...new Set(failures.map(normalizeFailure))].sort();
  return createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16);
}

export type ProgressVerdict =
  | { kind: 'progress' }
  | { kind: 'green' }
  /** Identical to the immediately preceding attempt — escalate now (§9.1). */
  | { kind: 'repeat'; signature: string }
  /** Seen before but not last — the agent is toggling between wrong states. */
  | { kind: 'oscillation'; signature: string };

/**
 * Classify an attempt against the history of this task's signatures.
 * `history` is oldest-first and excludes `signature`.
 */
export function classifyAttempt(history: readonly string[], signature: string): ProgressVerdict {
  if (signature === 'green') return { kind: 'green' };
  if (history.at(-1) === signature) return { kind: 'repeat', signature };
  if (history.includes(signature)) return { kind: 'oscillation', signature };
  return { kind: 'progress' };
}

/** Both `repeat` and `oscillation` mean more attempts will not help. */
export function shouldEscalate(v: ProgressVerdict): boolean {
  return v.kind === 'repeat' || v.kind === 'oscillation';
}
