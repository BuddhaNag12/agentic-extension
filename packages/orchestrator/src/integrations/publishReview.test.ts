import { describe, expect, it } from 'vitest';
import type { ReviewFinding } from '@agentflow/agent-runtime';
import { GitHubError, type ExistingReview, type ReviewComment } from './github.js';
import {
  DEDUPE_WINDOW, ReviewPublisher, alreadyPublished, chooseEvent, commentBody,
  composeBody, marker, overlapsHuman, select,
  type Poster, type TriagedFinding,
} from './publishReview.js';

/**
 * This is the only module that can write to someone else's pull request, so
 * most of what is worth testing here is what it refuses to do: approve, post
 * twice, repeat a person, or post at all without having been handed a
 * decision.
 */

const repo = { owner: 'BuddhaNag12', name: 'agentic-extension' };

function finding(over: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    id: 'f1',
    severity: 'major',
    category: 'correctness',
    file: 'src/a.ts',
    line: 42,
    title: 'Unchecked index access',
    evidence: 'Line 42 indexes `items[i]` after the loop bound was widened.',
    suggestedFix: 'Guard the access or narrow the bound.',
    confidence: 0.8,
    ...over,
  };
}

const accept = (over: Partial<ReviewFinding> = {}): TriagedFinding => ({
  finding: finding(over),
  triage: { kind: 'accept' },
});

const human = (over: Partial<ReviewComment> = {}): ReviewComment => ({
  path: 'src/a.ts',
  line: 42,
  author: 'someone',
  authorIsBot: false,
  body: 'I think this is fine actually',
  ...over,
});

/** Records every request and replies with a canned body. */
function fakePost(body: unknown, status = 200): Poster & { calls: { url: string; body: any }[] } {
  const calls: { url: string; body: any }[] = [];
  const f = (async (url: string, init: { body: string }) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    };
  }) as Poster & { calls: { url: string; body: any }[] };
  f.calls = calls;
  return f;
}

const publisher = (fetcher: Poster) =>
  new ReviewPublisher({ token: 't', api: 'https://api.github.test', fetcher });

const summaryFor = (selection: ReturnType<typeof select>) => ({ headSha: 'abc123', selection });

describe('never approving (§7.5 hard rule 1)', () => {
  it('only ever chooses COMMENT or REQUEST_CHANGES', () => {
    expect(chooseEvent([accept({ severity: 'blocker' })])).toBe('REQUEST_CHANGES');
    expect(chooseEvent([accept({ severity: 'nit' })])).toBe('COMMENT');
    expect(chooseEvent([])).toBe('COMMENT');
  });

  it('refuses an APPROVE even when one is forced past the type', async () => {
    const post = fakePost({ html_url: 'u' });
    const selection = select({ triaged: [accept()] });
    await expect(
      publisher(post).publish({
        repo, number: 7, headSha: 'abc123', selection,
        event: 'APPROVE' as never,
        summary: summaryFor(selection),
      }),
    ).rejects.toThrow(/never submits an approving review/);
    // And nothing reached GitHub on the way to that refusal.
    expect(post.calls).toHaveLength(0);
  });

  it('requests changes only for what survived triage, not what was found', () => {
    // A blocker the human dismissed must not escalate the review it is not in.
    const dismissed: TriagedFinding = {
      finding: finding({ severity: 'blocker' }),
      triage: { kind: 'dismiss', reason: 'intentional, see the ticket' },
    };
    const s = select({ triaged: [dismissed, accept({ severity: 'nit' })] });
    expect(chooseEvent([...s.inline, ...s.unanchored])).toBe('COMMENT');
  });
});

describe('one review, not a comment per finding (§7.5)', () => {
  it('posts every finding in a single request', async () => {
    const post = fakePost({ html_url: 'https://github.test/pr/7#review-1' });
    const selection = select({
      triaged: [accept({ id: 'a', line: 1 }), accept({ id: 'b', line: 2 }), accept({ id: 'c', line: 3 })],
    });
    const res = await publisher(post).publish({
      repo, number: 7, headSha: 'abc123', selection, summary: summaryFor(selection),
    });

    expect(post.calls).toHaveLength(1);
    expect(post.calls[0]!.url).toBe('https://api.github.test/repos/BuddhaNag12/agentic-extension/pulls/7/reviews');
    expect(post.calls[0]!.body.comments).toHaveLength(3);
    expect(post.calls[0]!.body.commit_id).toBe('abc123');
    expect(res.inlineComments).toBe(3);
    expect(res.degraded).toBe(false);
  });
});

describe('not repeating a person (§7.5 dedupe)', () => {
  it('drops a finding on the lines a human already commented on', () => {
    const s = select({ triaged: [accept()], existingComments: [human({ line: 42 })] });
    expect(s.duplicates).toHaveLength(1);
    expect(s.inline).toHaveLength(0);
  });

  it('treats nearby lines in the same hunk as the same place', () => {
    expect(overlapsHuman(finding({ line: 42 }), [human({ line: 42 + DEDUPE_WINDOW })])).toBe(true);
    expect(overlapsHuman(finding({ line: 42 }), [human({ line: 42 + DEDUPE_WINDOW + 1 })])).toBe(false);
  });

  it('lets a bot comment through, because the rule is about people', () => {
    // Otherwise our own previous review would suppress the next one, and the
    // head-sha guard is what handles that.
    const s = select({ triaged: [accept()], existingComments: [human({ authorIsBot: true })] });
    expect(s.inline).toHaveLength(1);
  });

  it('treats a file-level human comment as covering the file', () => {
    expect(overlapsHuman(finding({ line: 42 }), [human({ line: undefined })])).toBe(true);
  });

  it('does not dedupe across files', () => {
    expect(overlapsHuman(finding({ file: 'src/a.ts' }), [human({ path: 'src/b.ts' })])).toBe(false);
  });
});

describe('not reviewing the same commit twice (§7.5)', () => {
  const reviewed = (body: string): ExistingReview => ({
    author: 'agentflow', body, state: 'COMMENTED', commitSha: 'abc123', submittedAt: '',
  });

  it('recognises its own review of a sha by the marker it left', () => {
    expect(alreadyPublished('abc123', [reviewed(`Some body\n${marker('abc123')}`)])).toBe(true);
  });

  it('treats a new head sha as unreviewed, so a force-push can be re-reviewed', () => {
    expect(alreadyPublished('def456', [reviewed(`Some body\n${marker('abc123')}`)])).toBe(false);
  });

  it('is not fooled by a human review that happens to mention the sha', () => {
    expect(alreadyPublished('abc123', [reviewed('looks good at abc123')])).toBe(false);
  });
});

describe('triage decides what is posted', () => {
  it('never posts a dismissed finding', async () => {
    const post = fakePost({ html_url: 'u' });
    const selection = select({
      triaged: [{ finding: finding(), triage: { kind: 'dismiss', reason: 'false positive' } }],
    });
    await publisher(post).publish({
      repo, number: 7, headSha: 'abc123', selection, summary: summaryFor(selection),
    });
    expect(post.calls[0]!.body.comments).toHaveLength(0);
    // Counted in the body, though — a reader should know filtering happened.
    expect(post.calls[0]!.body.body).toContain('1 further finding was dismissed');
  });

  it('uses an edited comment verbatim, without the generated scaffolding', () => {
    const body = commentBody({ finding: finding(), triage: { kind: 'edit', body: 'Can you guard this?' } });
    expect(body).toBe('Can you guard this?');
    expect(body).not.toContain('Suggested fix');
  });

  it('keeps evidence and the suggested fix on an accepted finding', () => {
    const body = commentBody(accept());
    expect(body).toContain('Major · correctness');
    expect(body).toContain('widened');
    expect(body).toContain('Suggested fix');
  });
});

describe('anchoring comments to the diff', () => {
  it('moves a finding with no line into the body', () => {
    const s = select({ triaged: [accept({ line: undefined })] });
    expect(s.inline).toHaveLength(0);
    expect(s.unanchored).toHaveLength(1);
    expect(composeBody(summaryFor(s))).toContain('Findings without a line in this diff');
  });

  it('moves a finding whose line is outside the diff into the body', () => {
    // One unanchorable comment 422s the entire review, so it must not be sent.
    const s = select({
      triaged: [accept({ id: 'in', line: 10 }), accept({ id: 'out', line: 900 })],
      commentable: (_p, line) => line === 10,
    });
    expect(s.inline.map((t) => t.finding.id)).toEqual(['in']);
    expect(s.unanchored.map((t) => t.finding.id)).toEqual(['out']);
  });

  it('falls back to a body-only review when GitHub rejects the anchors', async () => {
    let attempt = 0;
    const post = (async (url: string, init: { body: string }) => {
      attempt += 1;
      const parsed = JSON.parse(init.body);
      calls.push({ url, body: parsed });
      return attempt === 1
        ? { ok: false, status: 422, json: async () => ({}), text: async () => 'line must be part of the diff' }
        : { ok: true, status: 200, json: async () => ({ html_url: 'u' }), text: async () => '' };
    }) as Poster;
    const calls: { url: string; body: any }[] = [];

    const selection = select({ triaged: [accept()] });
    const res = await publisher(post).publish({
      repo, number: 7, headSha: 'abc123', selection, summary: summaryFor(selection),
    });

    expect(res.degraded).toBe(true);
    expect(res.inlineComments).toBe(0);
    expect(calls[1]!.body.comments).toHaveLength(0);
    // The finding survived the fallback rather than being silently dropped.
    expect(calls[1]!.body.body).toContain('Unchecked index access');
  });
});

describe('the review body says what was done', () => {
  it('names the gates that ran and how they came out', () => {
    const s = select({ triaged: [accept()] });
    const body = composeBody({
      ...summaryFor(s),
      gatesRun: [{ gate: 'unit', ok: true }, { gate: 'compile', ok: false }],
      filesReviewed: 4,
    });
    expect(body).toContain('`unit` passed');
    expect(body).toContain('`compile` failed');
    expect(body).toContain('4 changed files');
  });

  it('says a person triaged it, and that it is not an approval', () => {
    const body = composeBody(summaryFor(select({ triaged: [accept()] })));
    expect(body).toContain('reviewed by a person before posting');
    expect(body).toContain('Not an approval');
  });

  it('carries the sha marker that stops a second review of the same commit', () => {
    const body = composeBody(summaryFor(select({ triaged: [accept()] })));
    expect(alreadyPublished('abc123', [{ author: 'a', body, state: '', commitSha: '', submittedAt: '' }])).toBe(true);
  });
});

describe('failures a person can act on', () => {
  it('points at the write permission on a 403, not the read one', async () => {
    const post = fakePost('no', 403);
    const selection = select({ triaged: [accept()] });
    await expect(
      publisher(post).publish({ repo, number: 7, headSha: 'abc123', selection, summary: summaryFor(selection) }),
    ).rejects.toThrow(/Pull requests: write/);
  });

  it('reports a rejected review as a GitHubError carrying the status', async () => {
    const post = fakePost('nope', 404);
    const selection = select({ triaged: [accept()] });
    await publisher(post)
      .publish({ repo, number: 7, headSha: 'abc123', selection, summary: summaryFor(selection) })
      .then(
        () => expect.unreachable('should have thrown'),
        (err) => {
          expect(err).toBeInstanceOf(GitHubError);
          expect((err as GitHubError).status).toBe(404);
        },
      );
  });
});
