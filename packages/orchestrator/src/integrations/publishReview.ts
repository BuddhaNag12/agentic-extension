/**
 * Publishing a review to GitHub (§7.5) — the write surface, deliberately its
 * own module.
 *
 * `github.ts` is read-only by construction (D51) and stays that way, so this
 * is the only file in the system that POSTs to GitHub. "What can write?" has
 * a one-file answer, and it is this one.
 *
 * §7.5's two hard rules are enforced here rather than asked for:
 *
 * 1. **Never `APPROVE`.** `ReviewEvent` has two members and `APPROVE` is not
 *    one of them, so an approval is not a thing this code can express. An
 *    approval is your signature on someone else's code.
 * 2. **Nothing posts without an explicit click.** Nothing in this module runs
 *    itself: `publishReview` takes triaged findings, and there is no
 *    confidence threshold, no setting and no caller inside the pipeline that
 *    reaches it.
 */

import { GitHubError, type ExistingReview, type RepoCoordinates, type ReviewComment } from './github.js';
import type { ReviewFinding } from '@agentflow/agent-runtime';

/** §7.5: `COMMENT` or `REQUEST_CHANGES`, and nothing else, ever. */
export type ReviewEvent = 'COMMENT' | 'REQUEST_CHANGES';

/**
 * What the human decided about one finding (§7.5 triage).
 *
 * `dismiss` carries a reason because those reasons are the only honest
 * training signal the eval harness (§18.3) will have about what the reviewer
 * gets wrong.
 */
export type Triage =
  | { kind: 'accept' }
  | { kind: 'edit'; body: string }
  | { kind: 'dismiss'; reason: string };

export interface TriagedFinding {
  finding: ReviewFinding;
  triage: Triage;
}

/**
 * Identifies our own reviews when we read them back.
 *
 * The "already reviewed this sha" guard has to survive a window reload and a
 * different machine, so it cannot live in local state. Stamping the sha into
 * the review body means GitHub itself is the record.
 */
export const MARKER_PREFIX = '<!-- agentflow:review';

export function marker(headSha: string): string {
  return `${MARKER_PREFIX} sha=${headSha} -->`;
}

/**
 * Lines within this many of a human's comment count as the same place.
 *
 * Not an exact line match: a person commenting on line 42 and the reviewer
 * flagging line 44 of the same hunk are talking about the same code, and
 * repeating them is exactly the noise that gets a bot muted. Erring toward
 * suppression is the right direction — a dropped finding is still visible in
 * the triage view, while a duplicate is visible to the whole PR.
 */
export const DEDUPE_WINDOW = 3;

/** Whether we have already published a review for this exact head sha. */
export function alreadyPublished(headSha: string, reviews: readonly ExistingReview[]): boolean {
  return reviews.some((r) => r.body.includes(marker(headSha)));
}

/** Whether a person has already commented on this finding's lines. */
export function overlapsHuman(
  finding: ReviewFinding,
  comments: readonly ReviewComment[],
  window = DEDUPE_WINDOW,
): boolean {
  return comments.some((c) => {
    if (c.authorIsBot) return false;
    if (c.path !== finding.file) return false;
    // A file-level human comment covers anything we would say about the file.
    if (c.line === undefined || finding.line === undefined) return true;
    return Math.abs(c.line - finding.line) <= window;
  });
}

export interface SelectionInput {
  triaged: readonly TriagedFinding[];
  existingComments?: readonly ReviewComment[];
  /**
   * Whether a line can carry an inline comment — true only for lines in the
   * diff. GitHub rejects the *whole* review with a 422 if any one comment is
   * anchored outside it, so an unanchorable finding goes in the body instead
   * of taking the rest down with it.
   */
  commentable?: (path: string, line: number) => boolean;
}

export interface Selection {
  /** Findings that become inline comments. */
  inline: TriagedFinding[];
  /** Accepted, but with nowhere to anchor — these go in the summary body. */
  unanchored: TriagedFinding[];
  dismissed: TriagedFinding[];
  /** Dropped because a person already said it. */
  duplicates: TriagedFinding[];
}

export function select(input: SelectionInput): Selection {
  const existing = input.existingComments ?? [];
  const out: Selection = { inline: [], unanchored: [], dismissed: [], duplicates: [] };

  for (const t of input.triaged) {
    if (t.triage.kind === 'dismiss') {
      out.dismissed.push(t);
      continue;
    }
    if (overlapsHuman(t.finding, existing)) {
      out.duplicates.push(t);
      continue;
    }
    const line = t.finding.line;
    const anchorable =
      line !== undefined && (input.commentable ? input.commentable(t.finding.file, line) : true);
    (anchorable ? out.inline : out.unanchored).push(t);
  }
  return out;
}

const SEVERITY_LABEL: Record<ReviewFinding['severity'], string> = {
  blocker: 'Blocker',
  major: 'Major',
  minor: 'Minor',
  nit: 'Nit',
};

/**
 * One finding as a comment.
 *
 * An `edit` replaces the text wholesale rather than decorating it: the point
 * of editing is to say it in your own voice, and a rewritten comment wearing
 * the generated evidence and confidence underneath is not that.
 */
export function commentBody(t: TriagedFinding): string {
  if (t.triage.kind === 'edit') return t.triage.body;
  const f = t.finding;
  return [
    `**${SEVERITY_LABEL[f.severity]} · ${f.category}** — ${f.title}`,
    '',
    f.evidence,
    '',
    `**Suggested fix.** ${f.suggestedFix}`,
  ].join('\n');
}

/**
 * `REQUEST_CHANGES` once anything blocking survives triage, `COMMENT`
 * otherwise — the same REVIEW_CLEAR line the pipeline uses (§5.7).
 */
export function chooseEvent(published: readonly TriagedFinding[]): ReviewEvent {
  const blocking = published.some(
    (t) => t.finding.severity === 'blocker' || t.finding.severity === 'major',
  );
  return blocking ? 'REQUEST_CHANGES' : 'COMMENT';
}

export interface SummaryInput {
  headSha: string;
  selection: Selection;
  /** Gates that actually ran, and how they came out — "what it ran" (§7.5). */
  gatesRun?: readonly { gate: string; ok: boolean }[];
  filesReviewed?: number;
  /** The reviewer's own prose summary. */
  reviewerSummary?: string;
}

/** The review body: what was checked, what ran, and what was left out. */
export function composeBody(input: SummaryInput): string {
  const { selection: s } = input;
  const posted = s.inline.length + s.unanchored.length;
  const lines: string[] = ['## AgentFlow review', ''];

  if (input.reviewerSummary) lines.push(input.reviewerSummary, '');

  const checked: string[] = [];
  if (input.filesReviewed !== undefined) {
    checked.push(`${input.filesReviewed} changed ${input.filesReviewed === 1 ? 'file' : 'files'}`);
  }
  checked.push(`${posted} ${posted === 1 ? 'finding' : 'findings'} after human triage`);
  lines.push(`**Checked.** ${checked.join(', ')}.`, '');

  if (input.gatesRun?.length) {
    const ran = input.gatesRun.map((g) => `\`${g.gate}\` ${g.ok ? 'passed' : 'failed'}`);
    lines.push(`**Ran.** ${ran.join(', ')}.`, '');
  }

  // Said out loud rather than left implicit: a reader deciding how much weight
  // to give these comments needs to know a person filtered them, and that
  // some were dropped on purpose.
  if (s.dismissed.length) {
    lines.push(`${s.dismissed.length} further ${s.dismissed.length === 1 ? 'finding was' : 'findings were'} dismissed during triage.`, '');
  }
  if (s.duplicates.length) {
    lines.push(`${s.duplicates.length} overlapped comments already on this PR and ${s.duplicates.length === 1 ? 'was' : 'were'} not repeated.`, '');
  }

  if (s.unanchored.length) {
    lines.push('### Findings without a line in this diff', '');
    for (const t of s.unanchored) {
      lines.push(`- \`${t.finding.file}\` — ${commentBody(t).replace(/\n+/g, ' ')}`);
    }
    lines.push('');
  }

  lines.push(
    '_Generated by AgentFlow and reviewed by a person before posting. Not an approval._',
    '',
    marker(input.headSha),
  );
  return lines.join('\n');
}

export interface PublishInput {
  repo: RepoCoordinates;
  number: number;
  /** The commit the review is anchored to. */
  headSha: string;
  selection: Selection;
  /** Defaults to `chooseEvent`; a human may downgrade it, never to APPROVE. */
  event?: ReviewEvent;
  summary: SummaryInput;
}

export interface PublishResult {
  event: ReviewEvent;
  reviewUrl: string;
  inlineComments: number;
  /** True when GitHub refused the anchors and the comments moved to the body. */
  degraded: boolean;
}

export interface PublisherOptions {
  token: string;
  api?: string;
  fetcher?: Poster;
  timeoutMs?: number;
}

export type Poster = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

export const PUBLISH_TIMEOUT_MS = 15_000;

export class ReviewPublisher {
  private readonly api: string;
  private readonly poster: Poster;

  constructor(private readonly opts: PublisherOptions) {
    this.api = opts.api ?? 'https://api.github.com';
    this.poster = opts.fetcher ?? ((url, init) => fetch(url, init));
  }

  /**
   * Post the triaged findings as **one** review (§7.5) — batched, because a
   * comment per finding is how a tool makes a PR unreadable.
   */
  async publish(input: PublishInput): Promise<PublishResult> {
    const published = [...input.selection.inline, ...input.selection.unanchored];
    const event = input.event ?? chooseEvent(published);

    // Belt and braces for hard rule 1. `ReviewEvent` already makes APPROVE
    // unrepresentable, but this module is the one place where being wrong
    // forges someone's signature, so the value is checked as well as typed.
    if ((event as string) === 'APPROVE') {
      throw new Error('AgentFlow never submits an approving review (§7.5).');
    }

    const url = `${this.api}/repos/${input.repo.owner}/${input.repo.name}/pulls/${input.number}/reviews`;
    const comments = input.selection.inline.map((t) => ({
      path: t.finding.file,
      line: t.finding.line!,
      side: 'RIGHT' as const,
      body: commentBody(t),
    }));

    try {
      const res = await this.post(url, {
        commit_id: input.headSha,
        body: composeBody(input.summary),
        event,
        comments,
      });
      return {
        event,
        reviewUrl: String((res as Record<string, unknown>)['html_url'] ?? ''),
        inlineComments: comments.length,
        degraded: false,
      };
    } catch (err) {
      // A 422 is almost always one comment anchored to a line outside the
      // diff, and it fails the entire review. Posting the same findings in
      // the body is worse than inline and far better than nothing, so the
      // retry folds them in and says so rather than reporting a failure the
      // human can do nothing about.
      if (!(err instanceof GitHubError) || err.status !== 422 || comments.length === 0) throw err;

      const folded: Selection = {
        ...input.selection,
        inline: [],
        unanchored: [...input.selection.unanchored, ...input.selection.inline],
      };
      const res = await this.post(url, {
        commit_id: input.headSha,
        body: composeBody({ ...input.summary, selection: folded }),
        event,
        comments: [],
      });
      return {
        event,
        reviewUrl: String((res as Record<string, unknown>)['html_url'] ?? ''),
        inlineComments: 0,
        degraded: true,
      };
    }
  }

  private async post(url: string, body: unknown): Promise<unknown> {
    const timeoutMs = this.opts.timeoutMs ?? PUBLISH_TIMEOUT_MS;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);

    let res: Awaited<ReturnType<Poster>>;
    try {
      res = await this.poster(url, {
        method: 'POST',
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${this.opts.token}`,
          'content-type': 'application/json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'agentflow',
        },
        body: JSON.stringify(body),
        signal: abort.signal,
      });
    } catch (err) {
      if (abort.signal.aborted) {
        throw new GitHubError(0, `GitHub did not respond within ${timeoutMs / 1000}s.`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new GitHubError(res.status, describeWrite(res.status, detail));
    }
    return res.json();
  }
}

/**
 * Write failures read differently from read failures, which is why this is
 * not `github.ts`'s `describe`: a 403 here means the token can *read* the
 * repository it just failed to write to, and saying "missing the repository
 * scope" would send someone to re-check the wrong permission.
 */
function describeWrite(status: number, detail: string): string {
  if (status === 401) return 'GitHub rejected the token (401). It may be expired or malformed.';
  if (status === 403) {
    return detail.includes('rate limit')
      ? 'GitHub rate limit reached (403). Wait, or use a token with a higher limit.'
      : 'GitHub refused to post the review (403). The token can read this repository but needs Pull requests: write.';
  }
  if (status === 404) {
    return 'Pull request not found (404) — for a private repository this usually means the token cannot see it.';
  }
  if (status === 422) {
    return `GitHub rejected the review (422), usually a comment on a line outside the diff${detail ? `: ${detail.slice(0, 200)}` : ''}`;
  }
  return `GitHub returned ${status}${detail ? `: ${detail.slice(0, 200)}` : ''}`;
}
