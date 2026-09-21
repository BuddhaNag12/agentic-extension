import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  JiraClient, MY_OPEN_ISSUES_JQL, RESOLVED_WINDOW_DAYS, jiraSetupHint, plainText,
  resolveJiraConfig, type JiraFetcher,
} from './jira.js';
import { WorkInbox, mergedItems, type WorkItem } from './workInbox.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'agentflow-inbox-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

// --- Jira -------------------------------------------------------------------

const issue = {
  key: 'PAY-1423',
  fields: {
    summary: 'Checkout empty state',
    status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
    issuetype: { name: 'Story' },
    priority: { name: 'High' },
    labels: ['checkout-v2'],
    assignee: { displayName: 'Buddha Nag' },
    updated: '2026-09-20T09:00:00.000+0000',
  },
};

function jiraFetch(body: unknown, status = 200): JiraFetcher & { urls: string[]; auth: string[] } {
  const urls: string[] = [];
  const auth: string[] = [];
  const f = (async (url: string, init: { headers: Record<string, string> }) => {
    urls.push(url);
    auth.push(init.headers['authorization'] ?? '');
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    };
  }) as JiraFetcher & { urls: string[]; auth: string[] };
  f.urls = urls; f.auth = auth;
  return f;
}

const config = { host: 'https://acme.atlassian.net', email: 'me@acme.com', token: 'tok' };

describe('Jira: what is assigned to me', () => {
  it('asks for unresolved work assigned to the caller', async () => {
    const f = jiraFetch({ issues: [issue] });
    await new JiraClient(config, f).search();

    const jql = decodeURIComponent(new URL(f.urls[0]!).searchParams.get('jql')!);
    expect(jql).toBe(MY_OPEN_ISSUES_JQL);
    expect(jql).toContain('assignee = currentUser()');
    // Resolved tickets are not work; without this the list never shrinks.
    expect(jql).toContain('resolution = Unresolved');
  });

  it('asks for recently resolved work too, or the Done tab can never fill', async () => {
    const f = jiraFetch({ issues: [] });
    await new JiraClient(config, f).search();
    const jql = decodeURIComponent(new URL(f.urls[0]!).searchParams.get('jql')!);
    expect(jql).toContain(`resolved >= -${RESOLVED_WINDOW_DAYS}d`);
  });

  it('bounds how far back resolved work reaches', () => {
    // Unbounded, this pulls an entire history into a 200-item cap and
    // truncates current work behind tickets closed years ago.
    expect(MY_OPEN_ISSUES_JQL).toMatch(/resolved >= -\d+d/);
  });

  it('flattens the fields a list needs, and builds the browse URL', async () => {
    const [i] = await new JiraClient(config, jiraFetch({ issues: [issue] })).search();
    expect(i).toMatchObject({
      key: 'PAY-1423', summary: 'Checkout empty state', status: 'In Progress',
      issueType: 'Story', priority: 'High', labels: ['checkout-v2'], assignee: 'Buddha Nag',
      url: 'https://acme.atlassian.net/browse/PAY-1423',
    });
  });

  it('buckets on the status category, not the status name', async () => {
    // Status names are per-project and renamed freely; the category is the
    // only stable thing to tab on.
    const of = async (status: unknown) => {
      const [i] = await new JiraClient(config, jiraFetch({ issues: [{ key: 'X-1', fields: { status } }] })).search();
      return i!.statusCategory;
    };
    expect(await of({ name: 'Selected for Development', statusCategory: { key: 'new' } })).toBe('new');
    expect(await of({ name: 'Code Review', statusCategory: { key: 'indeterminate' } })).toBe('indeterminate');
    expect(await of({ name: 'Shipped', statusCategory: { key: 'done' } })).toBe('done');
  });

  it('calls an unrecognised category unknown rather than guessing a bucket', async () => {
    const [i] = await new JiraClient(config, jiraFetch({ issues: [{ key: 'X-1' }] })).search();
    expect(i!.statusCategory).toBe('unknown');
  });

  it('asks for the description, which harvest needs to predict anything', async () => {
    // Without it the phase gets a one-line summary and fails with
    // "digest predicted an empty touch set".
    const f = jiraFetch({ issues: [] });
    await new JiraClient(config, f).search();
    expect(f.urls[0]).toContain('description');
  });

  it('tolerates a trailing slash on the host', async () => {
    const f = jiraFetch({ issues: [] });
    await new JiraClient({ ...config, host: 'https://acme.atlassian.net/' }, f).search();
    expect(f.urls[0]).not.toContain('.net//rest');
  });

  it('survives an issue missing the fields it hoped for', async () => {
    // Jira instances differ; a missing field should degrade one row.
    const [i] = await new JiraClient(config, jiraFetch({ issues: [{ key: 'X-1' }] })).search();
    expect(i).toMatchObject({ key: 'X-1', status: 'unknown', labels: [] });
  });

  it('authenticates with basic auth over the API token', async () => {
    const f = jiraFetch({ issues: [] });
    await new JiraClient(config, f).search();
    const decoded = Buffer.from(f.auth[0]!.replace('Basic ', ''), 'base64').toString();
    expect(decoded).toBe('me@acme.com:tok');
  });

  it('caps the page size — hundreds of results is a broken query', async () => {
    const f = jiraFetch({ issues: [] });
    await new JiraClient(config, f).search(MY_OPEN_ISSUES_JQL, 5_000);
    expect(f.urls[0]).toContain('maxResults=100');
  });

  it('says what each failure usually means', async () => {
    const fails = (s: number, body = '') =>
      new JiraClient(config, jiraFetch(body, s)).search();
    await expect(fails(401)).rejects.toThrow(/email and API token/);
    await expect(fails(404)).rejects.toThrow(/wrong host/);
    await expect(fails(400, 'bad JQL near "assignee"')).rejects.toThrow(/bad JQL/);
  });
});

describe('Jira configuration', () => {
  it('takes the host from the repo and the credentials from the user', () => {
    // The host is the same for the whole team, so it belongs in the repo;
    // credentials never do.
    mkdirSync(join(dir, '.agentflow'), { recursive: true });
    writeFileSync(
      join(dir, '.agentflow', 'config.json'),
      JSON.stringify({ integrations: { jira: { host: 'https://acme.atlassian.net' } } }),
    );
    const resolved = resolveJiraConfig({
      agentflowDir: join(dir, '.agentflow'),
      env: { AGENTFLOW_JIRA_EMAIL: 'me@acme.com', AGENTFLOW_JIRA_TOKEN: 'tok' },
    });
    expect(resolved).toEqual({ host: 'https://acme.atlassian.net', email: 'me@acme.com', token: 'tok' });
  });

  it('prefers stored credentials over the environment', () => {
    const r = resolveJiraConfig({
      stored: { host: 'https://stored.atlassian.net', email: 'a@b.c', token: 'stored' },
      env: { AGENTFLOW_JIRA_HOST: 'https://env.atlassian.net', AGENTFLOW_JIRA_EMAIL: 'x@y.z', AGENTFLOW_JIRA_TOKEN: 'env' },
    });
    expect(r?.host).toBe('https://stored.atlassian.net');
    expect(r?.token).toBe('stored');
  });

  it('needs all three, and reports absence rather than a partial config', () => {
    expect(resolveJiraConfig({ env: { AGENTFLOW_JIRA_HOST: 'https://x' } })).toBeUndefined();
    expect(resolveJiraConfig({ env: {} })).toBeUndefined();
  });

  it('is not taken down by a malformed config file', () => {
    mkdirSync(join(dir, '.agentflow'), { recursive: true });
    writeFileSync(join(dir, '.agentflow', 'config.json'), '{ not json');
    expect(() => resolveJiraConfig({ agentflowDir: join(dir, '.agentflow'), env: {} })).not.toThrow();
  });

  it('tells the human every way to configure it', () => {
    expect(jiraSetupHint()).toContain('AGENTFLOW_JIRA_HOST');
    expect(jiraSetupHint()).toContain('Set Jira Credentials');
  });
});

// --- the poller -------------------------------------------------------------

const item = (id: string): WorkItem => ({
  id, source: 'jira', key: id, title: 't', url: 'u', status: 'open',
  labels: [], updatedAt: '2026-09-20T09:00:00Z', detail: undefined, draft: false,
});

/** A Jira provider returning a canned list, or throwing on demand. */
function jiraProvider(behaviour: () => unknown[]) {
  return async () => ({
    client: {
      search: async () => behaviour(),
    } as unknown as JiraClient,
  });
}

const cacheFile = () => join(dir, 'cache', 'inbox.json');

describe('Jira descriptions arrive as ADF, not text', () => {
  const doc = (...content: unknown[]) => ({ type: 'doc', version: 1, content });
  const para = (...text: string[]) => ({
    type: 'paragraph', content: text.map((t) => ({ type: 'text', text: t })),
  });

  it('flattens a document to prose', () => {
    expect(plainText(doc(para('Checkout is empty.'), para('Repro: add nothing.'))))
      .toBe('Checkout is empty.\nRepro: add nothing.');
  });

  it('keeps list items on their own lines', () => {
    const list = {
      type: 'bulletList',
      content: [
        { type: 'listItem', content: [para('one')] },
        { type: 'listItem', content: [para('two')] },
      ],
    };
    expect(plainText(doc(list)).split('\n')).toEqual(['one', 'two']);
  });

  it('joins inline marks without breaking a sentence apart', () => {
    // Bold and links are separate text nodes inside one paragraph; a naive
    // newline-per-node turns a sentence into a list.
    expect(plainText(doc(para('the ', 'checkout', ' page')))).toBe('the checkout page');
  });

  it('accepts a plain string, which older instances still return', () => {
    expect(plainText('just text')).toBe('just text');
  });

  it('never yields [object Object] for a shape it does not know', () => {
    // Worse than empty: it looks like content, so nothing downstream notices.
    for (const v of [undefined, null, {}, { type: 'weird' }, 42]) {
      expect(plainText(v)).not.toContain('object Object');
    }
  });

  it('reads the description onto the issue', async () => {
    const [i] = await new JiraClient(config, jiraFetch({
      issues: [{ key: 'X-1', fields: { description: doc(para('the body')) } }],
    })).search();
    expect(i!.description).toBe('the body');
  });
});

describe('the work inbox poller (§6.4)', () => {
  it('reports the items it fetched', async () => {
    const inbox = new WorkInbox({
      cacheFile: cacheFile(),
      providers: {
        jira: jiraProvider(() => [
          { key: 'PAY-1', fields: { summary: 'a', updated: '2026-09-20T09:00:00Z' } },
        ]),
      },
    });
    const snap = await inbox.refreshNow();
    expect(snap.jira.items).toHaveLength(1);
    expect(snap.stale).toBe(false);
  });

  it('carries the status category through to the item the UI tabs on', async () => {
    // The mapping is the whole point: a category that stops at the Jira
    // client leaves every tab but All empty.
    const inbox = new WorkInbox({
      cacheFile: cacheFile(),
      providers: {
        jira: jiraProvider(() => [
          { key: 'PAY-1', summary: 'a', statusCategory: 'done', labels: [] },
        ]),
      },
    });
    const snap = await inbox.refreshNow();
    expect(snap.jira.items[0]!.category).toBe('done');
  });

  it('defaults to PRs you are involved in, not only ones assigned to you', async () => {
    const seen: unknown[] = [];
    const inbox = new WorkInbox({
      cacheFile: cacheFile(),
      providers: {
        github: async () => ({
          repo: { owner: 'o', name: 'r' },
          client: {
            listPullRequests: async (query: unknown) => { seen.push(query); return []; },
          } as never,
        }),
      },
    });
    await inbox.refreshNow();
    expect(seen[0]).toMatchObject({ involves: true });
    expect(seen[0]).not.toHaveProperty('reviewRequested');
  });

  it('drops the cached PR list when the scope changes', async () => {
    // The cached list was built under the old scope; showing it under the new
    // one tells the user their setting did nothing.
    const inbox = new WorkInbox({
      cacheFile: cacheFile(),
      prScope: 'involves',
      providers: {
        github: async () => ({
          repo: { owner: 'o', name: 'r' },
          client: { listPullRequests: async () => [
            { number: 1, title: 't', url: '', author: 'a', labels: [], draft: false, updatedAt: '' },
          ] } as never,
        }),
      },
    });
    await inbox.refreshNow();
    expect(inbox.snapshot().github.items).toHaveLength(1);

    inbox.setPrScope('authored');
    expect(inbox.snapshot().github.items).toHaveLength(0);
  });

  it('keeps the last good list when a source goes away', async () => {
    // "You have no work" and "I could not ask" are different answers, and
    // only one of them means you can stop looking.
    let fail = false;
    const inbox = new WorkInbox({
      cacheFile: cacheFile(),
      providers: {
        jira: jiraProvider(() => {
          if (fail) throw new Error('getaddrinfo ENOTFOUND');
          return [{ key: 'PAY-1', fields: { summary: 'a' } }];
        }),
      },
    });

    await inbox.refreshNow();
    fail = true;
    const snap = await inbox.refreshNow();

    expect(snap.jira.items).toHaveLength(1);
    expect(snap.jira.problem).toMatch(/ENOTFOUND/);
  });

  it('caches to disk and renders from it before fetching anything', async () => {
    const first = new WorkInbox({
      cacheFile: cacheFile(),
      providers: { jira: jiraProvider(() => [{ key: 'PAY-1', fields: { summary: 'a' } }]) },
    });
    await first.refreshNow();
    expect(readFileSync(cacheFile(), 'utf8')).toContain('PAY-1');

    // A fresh instance, no provider called yet: the list is there, marked stale.
    const second = new WorkInbox({ cacheFile: cacheFile(), providers: {} });
    expect(second.snapshot().jira.items).toHaveLength(1);
    expect(second.snapshot().stale).toBe(true);
  });

  it('starts empty rather than failing on a corrupt cache', () => {
    mkdirSync(join(dir, 'cache'), { recursive: true });
    writeFileSync(cacheFile(), 'not json at all');
    const inbox = new WorkInbox({ cacheFile: cacheFile(), providers: {} });
    expect(inbox.snapshot().jira.items).toEqual([]);
  });

  it('reports a provider that is not configured as a problem, not a crash', async () => {
    const inbox = new WorkInbox({
      cacheFile: cacheFile(),
      providers: { jira: async () => ({ problem: 'Jira is not configured.' }) },
    });
    const snap = await inbox.refreshNow();
    expect(snap.jira.problem).toBe('Jira is not configured.');
    expect(snap.jira.items).toEqual([]);
  });

  it('polls on its own clock and stops when told', async () => {
    let calls = 0;
    const inbox = new WorkInbox({
      cacheFile: cacheFile(),
      jiraIntervalMs: 10,
      jitter: (b) => b,
      providers: { jira: jiraProvider(() => { calls += 1; return []; }) },
    });
    inbox.start();
    await new Promise((r) => setTimeout(r, 60));
    const afterStart = calls;
    inbox.stop();
    await new Promise((r) => setTimeout(r, 40));

    expect(afterStart).toBeGreaterThan(1);
    expect(calls).toBe(afterStart);
  });

  it('starting twice does not double the polling', async () => {
    let calls = 0;
    const inbox = new WorkInbox({
      cacheFile: cacheFile(),
      jiraIntervalMs: 15,
      jitter: (b) => b,
      providers: { jira: jiraProvider(() => { calls += 1; return []; }) },
    });
    inbox.start(); inbox.start(); inbox.start();
    await new Promise((r) => setTimeout(r, 50));
    inbox.stop();
    // Three schedulers would roughly treble this; the guard keeps it to one.
    expect(calls).toBeLessThan(7);
  });
});

describe('one list, both sources', () => {
  it('merges most recently updated first', () => {
    const snap = {
      jira: { items: [{ ...item('a'), updatedAt: '2026-09-01T00:00:00Z' }], fetchedAt: 1, problem: undefined },
      github: { items: [{ ...item('b'), source: 'github' as const, updatedAt: '2026-09-20T00:00:00Z' }], fetchedAt: 1, problem: undefined },
      stale: false,
    };
    expect(mergedItems(snap).map((i) => i.id)).toEqual(['b', 'a']);
  });
});
