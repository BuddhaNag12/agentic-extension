import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_REPO_ID, loadRepoRegistry, projectKeyOf, routeTicket } from './repos.js';
import { workspacePaths } from './paths.js';
import { RunStore } from './runs/store.js';

/**
 * A run used to target the first workspace folder unconditionally. The thing
 * worth testing here is that it still does whenever anything is unclear —
 * branching the wrong repository is far worse than branching the usual one.
 */

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'agentflow-repos-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const agentflowDir = () => join(dir, '.agentflow');

function config(body: unknown | string): void {
  mkdirSync(agentflowDir(), { recursive: true });
  writeFileSync(
    join(agentflowDir(), 'config.json'),
    typeof body === 'string' ? body : JSON.stringify(body),
    'utf8',
  );
}

/** A directory that looks enough like a git repo to pass validation. */
function repoAt(rel: string): string {
  const p = resolve(dir, rel);
  mkdirSync(join(p, '.git'), { recursive: true });
  return p;
}

const load = () => loadRepoRegistry(dir, agentflowDir());

describe('the repo registry', () => {
  it('falls back to the workspace when there is no config at all', () => {
    const r = load();
    expect(r.repos).toHaveLength(1);
    expect(r.fallback.id).toBe(DEFAULT_REPO_ID);
    expect(r.fallback.path).toBe(resolve(dir));
  });

  it('falls back to the workspace when the config is unparseable', () => {
    // A typo in a committed config must not stop every run in the workspace.
    config('{ not json');
    const r = load();
    expect(r.fallback.path).toBe(resolve(dir));
    expect(r.problems.join(' ')).toMatch(/not valid JSON/);
  });

  it('resolves a relative path against the workspace root', () => {
    repoAt('../sibling');
    config({ repos: [{ id: 'sibling', path: '../sibling' }] });
    expect(load().repos[0]!.path).toBe(resolve(dir, '../sibling'));
  });

  it('accepts a repo outside the workspace, which is the whole point', () => {
    const other = repoAt('../other-service');
    config({ repos: [{ id: 'svc', path: other }] });
    const r = load();
    expect(r.repos[0]!.path).toBe(other);
    expect(r.problems).toEqual([]);
  });

  it('reports a missing checkout without dropping the other repos', () => {
    repoAt('../present');
    config({ repos: [
      { id: 'gone', path: '/nope/not/here' },
      { id: 'present', path: '../present' },
    ] });
    const r = load();
    expect(r.repos.map((x) => x.id)).toEqual(['gone', 'present']);
    expect(r.problems.join(' ')).toMatch(/does not exist/);
  });

  it('says when a registered path is not a git repository', () => {
    mkdirSync(resolve(dir, '../plain'), { recursive: true });
    config({ repos: [{ id: 'plain', path: '../plain' }] });
    expect(load().problems.join(' ')).toMatch(/not a git repository/);
  });

  it('ignores a duplicate id rather than letting it shadow the first', () => {
    repoAt('../a'); repoAt('../b');
    config({ repos: [{ id: 'dup', path: '../a' }, { id: 'dup', path: '../b' }] });
    const r = load();
    expect(r.repos).toHaveLength(1);
    expect(r.repos[0]!.path).toBe(resolve(dir, '../a'));
    expect(r.problems.join(' ')).toMatch(/repeats the id/);
  });

  it('keeps the workspace reachable when the config never mentions it', () => {
    repoAt('../elsewhere');
    config({ repos: [{ id: 'elsewhere', path: '../elsewhere' }] });
    // Otherwise a ticket that routes nowhere has no repo to fall back to.
    expect(load().fallback.path).toBe(resolve(dir));
  });

  it('turns a base branch into a ref the run can use', () => {
    repoAt('../api');
    config({ repos: [{ id: 'api', path: '../api', baseBranch: 'develop' }] });
    expect(load().repos[0]!.baseBranch).toBe('develop');
  });
});

describe('routing a ticket to a repo', () => {
  const registry = () => {
    repoAt('.'); repoAt('../api');
    config({ repos: [
      { id: 'ui', path: '.', tickets: { projects: ['FWERP'], labels: ['frontend'] } },
      { id: 'api', path: '../api', tickets: { projects: ['FWAPI'] } },
    ] });
    return load();
  };

  it('reads the project key out of the ticket', () => {
    expect(projectKeyOf('FWERP-3838')).toBe('FWERP');
    expect(projectKeyOf('fwerp-1')).toBe('FWERP');
    expect(projectKeyOf('not-a-key')).toBeUndefined();
  });

  it('routes on the project key', () => {
    expect(routeTicket(registry(), { ticketKey: 'FWAPI-12' }))
      .toMatchObject({ repo: { id: 'api' }, why: 'project' });
  });

  it('routes on a label when no project matches', () => {
    expect(routeTicket(registry(), { ticketKey: 'OTHER-1', labels: ['frontend'] }))
      .toMatchObject({ repo: { id: 'ui' }, why: 'label' });
  });

  it('prefers the project key over a label', () => {
    // A key is structural; a label is something anyone can add to a ticket.
    expect(routeTicket(registry(), { ticketKey: 'FWAPI-12', labels: ['frontend'] }))
      .toMatchObject({ repo: { id: 'api' }, why: 'project' });
  });

  it('lets an explicitly named repo win over everything', () => {
    expect(routeTicket(registry(), { ticketKey: 'FWAPI-12', repoId: 'ui' }))
      .toMatchObject({ repo: { id: 'ui' }, why: 'explicit' });
  });

  it('falls back to the workspace when nothing claims the ticket', () => {
    expect(routeTicket(registry(), { ticketKey: 'ZZZ-9' }))
      .toMatchObject({ why: 'fallback' });
  });

  it('falls back when the named repo does not exist, rather than inventing one', () => {
    expect(routeTicket(registry(), { ticketKey: 'ZZZ-9', repoId: 'typo' }))
      .toMatchObject({ why: 'fallback' });
  });

  it('flags an ambiguous match instead of quietly picking one', () => {
    repoAt('.'); repoAt('../two');
    config({ repos: [
      { id: 'one', path: '.', tickets: { projects: ['SHARED'] } },
      { id: 'two', path: '../two', tickets: { projects: ['SHARED'] } },
    ] });
    const r = routeTicket(load(), { ticketKey: 'SHARED-1' });
    expect(r.ambiguous).toEqual(['one', 'two']);
    expect(r.repo.id).toBe('one');
  });
});

describe('a run actually targets the repo it was routed to', () => {
  it('branches the routed repo, not the workspace, and parks its tree beside it', () => {
    // The registry is decorative unless `create` reads it: before this, every
    // run got `paths.root` and a worktree beside the workspace.
    const api = repoAt('../api');
    const store = new RunStore(workspacePaths(dir));
    const { run } = store.create({
      ticketKey: 'FWAPI-12',
      repo: { id: 'api', path: api, baseBranch: 'develop' },
    });

    expect(run.repo).toMatchObject({ id: 'api', path: api, baseRef: 'origin/develop' });
    expect(run.worktree).toBe(`${api}-agentflow/FWAPI-12`);
  });

  it('still defaults to the workspace when nothing routed it', () => {
    const store = new RunStore(workspacePaths(dir));
    const { run } = store.create({ ticketKey: 'ZZZ-1' });
    expect(run.repo).toMatchObject({ id: 'default', path: dir, baseRef: 'origin/main' });
    expect(run.worktree).toBe(`${dir}-agentflow/ZZZ-1`);
  });

  it('lets an explicit baseRef override the registry branch', () => {
    const api = repoAt('../api2');
    const store = new RunStore(workspacePaths(dir));
    const { run } = store.create({
      ticketKey: 'FWAPI-13',
      repo: { id: 'api2', path: api, baseBranch: 'develop' },
      baseRef: 'origin/release-4',
    });
    expect(run.repo.baseRef).toBe('origin/release-4');
  });
});
