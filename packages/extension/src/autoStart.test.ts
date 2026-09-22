import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { workspacePaths } from '@agentflow/orchestrator';
import { shouldAutoStart } from './autoStart.js';

let stateRoot: string;
let repo: string;

afterEach(() => {
  for (const d of [stateRoot, repo]) if (d) rmSync(d, { recursive: true, force: true });
});

function paths() {
  stateRoot ??= mkdtempSync(join(tmpdir(), 'agentflow-state-'));
  repo ??= mkdtempSync(join(tmpdir(), 'agentflow-repo-'));
  return workspacePaths(repo, { AGENTFLOW_STATE_DIR: stateRoot });
}

describe('deciding whether activation connects', () => {
  it('stays out of a workspace that has never used AgentFlow', () => {
    // The bug: onStartupFinished fires everywhere, so this spawned a daemon
    // and a state directory for every repository the user ever opened.
    expect(shouldAutoStart(paths(), true)).toBe(false);
  });

  it('starts where a previous run left state behind', () => {
    const p = paths();
    mkdirSync(p.stateDir, { recursive: true });
    expect(shouldAutoStart(p, true)).toBe(true);
  });

  it('starts where the repo commits AgentFlow config but has never run', () => {
    // State lives outside the tree now, so an in-repo .agentflow means
    // workflows or a repo registry — intent to use it here, nothing run yet.
    const p = paths();
    mkdirSync(p.configDir, { recursive: true });
    expect(shouldAutoStart(p, true)).toBe(true);
  });

  it('respects the setting even where AgentFlow is in use', () => {
    const p = paths();
    mkdirSync(p.stateDir, { recursive: true });
    expect(shouldAutoStart(p, false)).toBe(false);
  });
});
