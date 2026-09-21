import { describe, expect, it } from 'vitest';
import {
  GitHubClient, GitHubError, buildSearchQuery, parseRemote,
  type Fetcher, type PrQuery,
} from './github.js';
import { detectRepo, resolveGitHubToken, tokenSetupHint } from './githubAuth.js';

/**
 * The label filter is the point of this module: "show me PRs tagged X" and
 * "show me the ones nobody has triaged" are the two ways a review queue gets
 * looked at, and they are different queries rather than one list filtered
 * twice.
 */

const repo = { owner: 'BuddhaNag12', name: 'agentic-extension' };
const q = (over: Partial<PrQuery> = {}): PrQuery => ({ repo, ...over });

/** Records the URLs asked for and replies with a canned body. */
function fakeFetch(body: unknown, status = 200): Fetcher & { urls: string[] } {
  const urls: string[] = [];
  const f = (async (url: string) => {
    urls.push(url);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    };
  }) as Fetcher & { urls: string[] };
  f.urls = urls;
  return f;
}

const decoded = (url: string) => decodeURIComponent(new URL(url).searchParams.get('q') ?? '');

describe('the label filter', () => {
  it('asks for PRs carrying every named label', () => {
    const search = buildSearchQuery(q({ labels: { kind: 'tagged', labels: ['bug', 'needs review'] } }));
    expect(search).toContain('label:"bug"');
    // Quoted, because labels routinely contain spaces.
    expect(search).toContain('label:"needs review"');
  });

  it('asks for PRs carrying none at all', () => {
    // A distinct query, not the absence of one: "untriaged" is the thing
    // someone actually wants to see.
    expect(buildSearchQuery(q({ labels: { kind: 'untagged' } }))).toContain('no:label');
  });

  it('filters on neither by default', () => {
    const search = buildSearchQuery(q());
    expect(search).not.toContain('label');
    expect(search).toContain('repo:BuddhaNag12/agentic-extension');
    expect(search).toContain('is:pr');
    expect(search).toContain('is:open');
  });

  it('drops the state qualifier only when every state is wanted', () => {
    expect(buildSearchQuery(q({ state: 'all' }))).not.toContain('is:open');
    expect(buildSearchQuery(q({ state: 'closed' }))).toContain('is:closed');
  });

  it('combines a review queue with a label', () => {
    const search = buildSearchQuery(q({
      reviewRequested: true,
      labels: { kind: 'tagged', labels: ['backend'] },
    }));
    expect(search).toContain('review-requested:@me');
    expect(search).toContain('label:"backend"');
  });
});

describe('listing pull requests', () => {
  const item = {
    number: 42, title: 'Fix the cart total', html_url: 'https://github.com/x/y/pull/42',
    user: { login: 'someone' }, labels: [{ name: 'bug' }, { name: 'needs review' }],
    draft: false, updated_at: '2026-09-20T10:00:00Z',
  };

  it('returns what a picker needs', async () => {
    const fetcher = fakeFetch({ items: [item] });
    const prs = await new GitHubClient({ token: 't', fetcher }).listPullRequests(q());

    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({
      number: 42, title: 'Fix the cart total', author: 'someone', draft: false,
      labels: ['bug', 'needs review'],
    });
  });

  it('sends the label filter to the server, not to a local filter', async () => {
    // A busy repo's open PRs run to hundreds; paginating all of them to show a
    // handful is the difference between an inbox that opens and one nobody waits for.
    const fetcher = fakeFetch({ items: [] });
    await new GitHubClient({ token: 't', fetcher })
      .listPullRequests(q({ labels: { kind: 'untagged' } }));

    expect(decoded(fetcher.urls[0]!)).toContain('no:label');
  });

  it('caps the page size rather than asking for more than GitHub allows', async () => {
    const fetcher = fakeFetch({ items: [] });
    await new GitHubClient({ token: 't', fetcher }).listPullRequests(q({ limit: 5_000 }));
    expect(fetcher.urls[0]).toContain('per_page=100');
  });

  it('survives a response missing the fields it hoped for', async () => {
    // A field that moved should degrade the row, not throw away the list.
    const fetcher = fakeFetch({ items: [{ number: 7 }] });
    const prs = await new GitHubClient({ token: 't', fetcher }).listPullRequests(q());
    expect(prs[0]).toMatchObject({ number: 7, author: 'unknown', labels: [] });
  });

  it('sends the token and the API version', async () => {
    let headers: Record<string, string> = {};
    const fetcher: Fetcher = async (_u, init) => {
      headers = init.headers;
      return { ok: true, status: 200, json: async () => ({ items: [] }), text: async () => '' };
    };
    await new GitHubClient({ token: 'secret-token', fetcher }).listPullRequests(q());

    expect(headers['authorization']).toBe('Bearer secret-token');
    expect(headers['x-github-api-version']).toBe('2022-11-28');
  });
});

describe('failures say what to do', () => {
  const failing = (status: number, body = '') =>
    new GitHubClient({ token: 't', fetcher: fakeFetch(body, status) }).listPullRequests(q());

  it('calls a 404 what it usually is on a private repo', async () => {
    // "GitHub returned 404" sends someone hunting a missing PR when the real
    // problem is a token that cannot see the repository.
    await expect(failing(404)).rejects.toThrow(/token cannot see it/);
  });

  it('separates a bad token from a missing scope', async () => {
    await expect(failing(401)).rejects.toThrow(/rejected the token/);
    await expect(failing(403)).rejects.toThrow(/missing the repository scope/);
  });

  it('names a rate limit as a rate limit', async () => {
    await expect(failing(403, 'API rate limit exceeded')).rejects.toThrow(/rate limit/);
  });

  it('carries the status for a caller that wants to branch on it', async () => {
    await expect(failing(500)).rejects.toBeInstanceOf(GitHubError);
  });
});

describe('finding the repository', () => {
  it('reads an ssh remote', () => {
    expect(parseRemote('git@github.com:BuddhaNag12/agentic-extension.git')).toEqual(repo);
  });

  it('reads an https remote', () => {
    expect(parseRemote('https://github.com/BuddhaNag12/agentic-extension.git')).toEqual(repo);
  });

  it('reads an ssh:// remote, and tolerates a missing .git', () => {
    expect(parseRemote('ssh://git@github.com/BuddhaNag12/agentic-extension')).toEqual(repo);
  });

  it('returns nothing for something that is not a remote', () => {
    expect(parseRemote('not a url')).toBeUndefined();
  });

  it('prefers origin but will look past it', async () => {
    // A fork workflow points origin at the fork and upstream at the repo whose
    // PRs you review; refusing to look past origin hides the list that matters.
    const only = async () => 'upstream\tgit@github.com:acme/thing.git (fetch)\n';
    expect(await detectRepo('/x', only)).toEqual({ owner: 'acme', name: 'thing' });

    const both = async () =>
      'origin\tgit@github.com:me/fork.git (fetch)\nupstream\tgit@github.com:acme/thing.git (fetch)\n';
    expect(await detectRepo('/x', both)).toEqual({ owner: 'me', name: 'fork' });
  });

  it('returns nothing outside a repository rather than throwing', async () => {
    const boom = async () => { throw new Error('not a git repository'); };
    expect(await detectRepo('/x', boom)).toBeUndefined();
  });
});

describe('finding a token', () => {
  const noGh = async () => { throw new Error('gh: not found'); };

  it('prefers an explicitly stored token over the environment', async () => {
    const r = await resolveGitHubToken({
      stored: 'from-secret-storage',
      env: { GITHUB_TOKEN: 'from-env' },
      exec: noGh,
    });
    expect(r).toEqual({ token: 'from-secret-storage', from: 'VS Code SecretStorage' });
  });

  it('takes the AgentFlow variable ahead of the generic ones', async () => {
    const r = await resolveGitHubToken({
      env: { AGENTFLOW_GITHUB_TOKEN: 'ours', GITHUB_TOKEN: 'theirs' },
      exec: noGh,
    });
    expect(r?.token).toBe('ours');
  });

  it('falls back to the gh CLI so a signed-in developer needs no second token', async () => {
    const r = await resolveGitHubToken({ env: {}, exec: async () => 'gho_fromcli\n' });
    expect(r).toEqual({ token: 'gho_fromcli', from: 'the gh CLI' });
  });

  it('reports absence rather than throwing — not every workspace uses GitHub', async () => {
    expect(await resolveGitHubToken({ env: {}, exec: noGh })).toBeUndefined();
  });

  it('tells the human every way to supply one', () => {
    const hint = tokenSetupHint();
    expect(hint).toContain('AGENTFLOW_GITHUB_TOKEN');
    expect(hint).toContain('gh auth login');
    expect(hint).toMatch(/Pull requests: Read/);
  });
});

describe('whose pull requests count as yours', () => {
  it('asks for everything you are involved in, which includes your own', () => {
    // `review-requested:@me` by definition never matches a PR you opened, so
    // on a repo where you are the author the inbox was permanently empty.
    expect(buildSearchQuery(q({ involves: true }))).toContain('involves:@me');
  });

  it('can narrow to reviews actually requested from you', () => {
    expect(buildSearchQuery(q({ reviewRequested: true }))).toContain('review-requested:@me');
  });

  it('can narrow to what you opened', () => {
    expect(buildSearchQuery(q({ authored: true }))).toContain('author:@me');
  });

  it('asks for every open PR when nothing narrows it', () => {
    const search = buildSearchQuery(q());
    expect(search).toContain('is:pr');
    expect(search).toContain('is:open');
    for (const narrowing of ['involves:@me', 'review-requested:@me', 'author:']) {
      expect(search).not.toContain(narrowing);
    }
  });
});

describe('the reads that dedupe depends on (§7.5)', () => {
  it('keeps the position of a comment on an outdated line', async () => {
    // GitHub moves the position to `original_line` once the line has been
    // rewritten. Without the fallback these read as file-level comments and
    // suppress every finding in the file.
    const f = fakeFetch([
      { path: 'src/a.ts', line: 42, user: { login: 'ana', type: 'User' }, body: 'x' },
      { path: 'src/a.ts', line: null, original_line: 17, user: { login: 'bo', type: 'User' }, body: 'y' },
    ]);
    const got = await new GitHubClient({ token: 't', fetcher: f }).listReviewComments(repo, 7);
    expect(got.map((c) => c.line)).toEqual([42, 17]);
  });

  it('marks bot comments, so our own review does not suppress the next one', async () => {
    const f = fakeFetch([
      { path: 'a', line: 1, user: { login: 'ana', type: 'User' }, body: '' },
      { path: 'a', line: 2, user: { login: 'agentflow', type: 'Bot' }, body: '' },
    ]);
    const got = await new GitHubClient({ token: 't', fetcher: f }).listReviewComments(repo, 7);
    expect(got.map((c) => c.authorIsBot)).toEqual([false, true]);
  });

  it('reads submitted reviews with the commit each one judged', async () => {
    const f = fakeFetch([
      { user: { login: 'ana' }, body: 'lgtm', state: 'APPROVED', commit_id: 'abc', submitted_at: 't' },
    ]);
    const got = await new GitHubClient({ token: 't', fetcher: f }).listReviews(repo, 7);
    expect(got[0]).toMatchObject({ author: 'ana', state: 'APPROVED', commitSha: 'abc' });
  });
});
