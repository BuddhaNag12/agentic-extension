import { describe, expect, it } from 'vitest';
import { Spec, validateSpec, type Spec as SpecType } from './spec.js';
import type { ContextDigest } from './harvest.js';

const TICKET = `
Users on the checkout screen see a blank panel when their cart is empty.
We should show an empty state with an illustration and a "Browse products"
button. The button must route to the catalogue. Do not change the cart badge.
`.trim();

const digest: ContextDigest = {
  modules: [{ path: 'src/checkout', purpose: 'checkout flow' }],
  entryPoints: ['src/main.ts'],
  likelyTouchSet: ['src/checkout/EmptyState.tsx'],
  conventions: ['components live beside their tests'],
  testLayout: { framework: 'vitest', location: 'colocated' },
  precedent: { found: false, reason: 'greenfield, no precedent' },
  risks: ['checkout is covered by screenshot tests'],
};

const base = (over: Partial<SpecType> = {}): SpecType => Spec.parse({
  problem: 'The checkout screen renders a blank panel when the cart is empty.',
  inScope: ['an empty state on the checkout screen'],
  outOfScope: ['the cart badge'],
  acceptanceCriteria: [{
    id: 'AC1',
    statement: 'An empty cart shows an empty state with a Browse products button',
    source: { kind: 'ticket', ref: 'description', quote: 'show an empty state with an illustration' },
    checkable: true,
  }],
  affectedSurfaces: { modules: ['src/checkout'], apis: [], screens: ['Checkout'], flags: [] },
  assumptions: [],
  openQuestions: [],
  nonFunctional: { perf: 'none', security: 'none', accessibility: 'button must be focusable', telemetry: 'none' },
  rollback: 'revert the commit; the empty state is additive',
  ...over,
});

describe('SPEC_VALID: provenance (§5 Stage 2)', () => {
  it('accepts a criterion whose quote is really in the ticket', () => {
    expect(validateSpec(base(), { ticket: TICKET, digest })).toEqual([]);
  });

  it('rejects an invented requirement, however plausible', () => {
    const invented = base({
      acceptanceCriteria: [{
        id: 'AC1',
        statement: 'The empty state must be localized into French and German',
        source: { kind: 'ticket', ref: 'description', quote: 'localized into French and German' },
        checkable: true,
      }],
    });
    const issues = validateSpec(invented, { ticket: TICKET, digest });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ rule: 'S1', path: 'AC1' });
  });

  it('matches quotes despite whitespace and case differences', () => {
    const spaced = base({
      acceptanceCriteria: [{
        id: 'AC1',
        statement: 'The button routes to the catalogue',
        source: { kind: 'ticket', ref: 'description', quote: 'The  Button   MUST route\nto the catalogue' },
        checkable: true,
      }],
    });
    expect(validateSpec(spaced, { ticket: TICKET, digest })).toEqual([]);
  });

  it('checks quotes attributed to the harvest context too', () => {
    const good = base({
      acceptanceCriteria: [{
        id: 'AC1', statement: 'The new component is colocated with its test',
        source: { kind: 'context', ref: 'conventions', quote: 'components live beside their tests' },
        checkable: true,
      }],
    });
    expect(validateSpec(good, { ticket: TICKET, digest })).toEqual([]);

    const bad = base({
      acceptanceCriteria: [{
        id: 'AC1', statement: 'The component uses the shared design system',
        source: { kind: 'context', ref: 'conventions', quote: 'all components use the design system' },
        checkable: true,
      }],
    });
    expect(validateSpec(bad, { ticket: TICKET, digest })[0]).toMatchObject({ rule: 'S2' });
  });

  it('does not check design references it has no source for', () => {
    const design = base({
      acceptanceCriteria: [{
        id: 'AC1', statement: 'Spacing matches the frame',
        source: { kind: 'design', ref: 'figma:12:345', quote: 'padding of 16 on all sides' },
        checkable: true,
      }],
    });
    expect(validateSpec(design, { ticket: TICKET, digest })).toEqual([]);
  });
});

describe('SPEC_VALID: the rest of the gate', () => {
  it('rejects a spec nothing can verify', () => {
    const unverifiable = base({
      acceptanceCriteria: [{
        id: 'AC1', statement: 'The empty state should feel polished',
        source: { kind: 'ticket', ref: 'description', quote: 'show an empty state' },
        checkable: false,
      }],
    });
    expect(validateSpec(unverifiable, { ticket: TICKET, digest })[0]).toMatchObject({ rule: 'S3' });
  });

  it('rejects a high-impact assumption that asks nothing', () => {
    const silent = base({
      assumptions: [{
        id: 'A1', statement: 'The catalogue route is /products', confidence: 0.5, impactIfWrong: 'high',
      }],
    });
    const issues = validateSpec(silent, { ticket: TICKET, digest });
    expect(issues[0]).toMatchObject({ rule: 'S4', path: 'A1' });
    expect(issues[0]?.message).toContain('open question');
  });

  it('accepts a high-impact assumption paired with a question', () => {
    const paired = base({
      assumptions: [{
        id: 'A1', statement: 'The catalogue route is /products', confidence: 0.5,
        impactIfWrong: 'high', questionId: 'Q1',
      }],
      openQuestions: [{
        id: 'Q1', question: 'Which route does "Browse products" go to?',
        whyItMatters: 'a wrong route ships a dead button', alreadyChecked: ['grepped the router'],
        blocking: true,
      }],
    });
    expect(validateSpec(paired, { ticket: TICKET, digest })).toEqual([]);
  });

  it('rejects a dangling question reference', () => {
    const dangling = base({
      assumptions: [{
        id: 'A1', statement: 'the catalogue route is /products', confidence: 0.5,
        impactIfWrong: 'high', questionId: 'Q9',
      }],
    });
    expect(validateSpec(dangling, { ticket: TICKET, digest })[0]?.message).toContain('Q9');
  });

  it('leaves low-impact assumptions alone', () => {
    const low = base({
      assumptions: [{ id: 'A1', statement: 'copy can be adjusted later', confidence: 0.9, impactIfWrong: 'low' }],
    });
    expect(validateSpec(low, { ticket: TICKET, digest })).toEqual([]);
  });

  it('rejects scope that contradicts itself', () => {
    const contradictory = base({
      inScope: ['the cart badge'], outOfScope: ['The Cart Badge'],
    });
    expect(validateSpec(contradictory, { ticket: TICKET, digest })[0]).toMatchObject({ rule: 'S5' });
  });

  it('reports every violation at once, not just the first', () => {
    const bad = base({
      acceptanceCriteria: [{
        id: 'AC1', statement: 'Something invented entirely',
        source: { kind: 'ticket', ref: 'description', quote: 'nowhere in the ticket at all' },
        checkable: false,
      }],
      assumptions: [{ id: 'A1', statement: 'a risky guess', confidence: 0.3, impactIfWrong: 'high' }],
    });
    const rules = validateSpec(bad, { ticket: TICKET, digest }).map((i) => i.rule);
    expect(rules).toEqual(expect.arrayContaining(['S1', 'S3', 'S4']));
  });
});

describe('the schema itself refuses malformed specs', () => {
  it('requires a quote long enough to be evidence', () => {
    expect(() => base({
      acceptanceCriteria: [{
        id: 'AC1', statement: 'something reasonable here',
        source: { kind: 'ticket', ref: 'description', quote: 'short' },
        checkable: true,
      }],
    })).toThrow();
  });

  it('requires at least one acceptance criterion', () => {
    expect(() => base({ acceptanceCriteria: [] })).toThrow();
  });

  it('requires questions to say what was already checked', () => {
    expect(() => base({
      openQuestions: [{
        id: 'Q1', question: 'Which route should this use?',
        whyItMatters: 'it decides the destination', alreadyChecked: [], blocking: true,
      }],
    })).toThrow();
  });
});
