import { mkdirSync, mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateLegacyState, stateRoot, workspacePaths } from './paths.js';

/**
 * The tool used to write its runs, cache, lock and log into `.agentflow/`
 * inside the repository being worked on. Nothing it writes is the repo's
 * business, and a tool that litters a working tree is a tool people delete.
 */

let dir: string;
let state: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentflow-paths-'));
  state = mkdtempSync(join(tmpdir(), 'agentflow-state-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(state, { recursive: true, force: true });
});

const paths = () => workspacePaths(dir, { AGENTFLOW_STATE_DIR: state });

describe('where state lives', () => {
  it('writes nothing inside the repository', () => {
    const p = paths();
    for (const written of [p.stateDir, p.lockFile, p.daemonLogFile, p.runsDir]) {
      expect(written.startsWith(dir), written).toBe(false);
    }
  });

  it('still reads committed config from the repository', () => {
    // The config and workflows are inputs a team shares; only output moves.
    expect(paths().configDir).toBe(join(dir, '.agentflow'));
  });

  it('keeps two workspaces apart even when they share a basename', () => {
    const a = workspacePaths('/tmp/one/app', { AGENTFLOW_STATE_DIR: state });
    const b = workspacePaths('/tmp/two/app', { AGENTFLOW_STATE_DIR: state });
    expect(a.stateDir).not.toBe(b.stateDir);
    expect(a.ipcEndpoint).not.toBe(b.ipcEndpoint);
  });

  it('honours an explicit state directory', () => {
    expect(paths().stateDir.startsWith(state)).toBe(true);
  });

  it('falls back to a per-user location with no override', () => {
    const root = stateRoot({});
    expect(root.length).toBeGreaterThan(0);
    expect(root.startsWith(dir)).toBe(false);
  });
});

describe('migrating state written by an earlier build', () => {
  const legacy = (name: string, file = 'x.json') => {
    const d = join(dir, '.agentflow', name);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, file), '{}', 'utf8');
    return d;
  };

  it('moves run history out of the repository', () => {
    legacy('runs', 'events.jsonl');
    const p = paths();
    expect(migrateLegacyState(p)).toContain('runs');
    expect(existsSync(join(p.runsDir, 'events.jsonl'))).toBe(true);
    expect(existsSync(join(dir, '.agentflow', 'runs'))).toBe(false);
  });

  it('never overwrites state already in the new location', () => {
    legacy('runs', 'old.jsonl');
    const p = paths();
    mkdirSync(p.runsDir, { recursive: true });
    writeFileSync(join(p.runsDir, 'new.jsonl'), '{}', 'utf8');

    expect(migrateLegacyState(p)).not.toContain('runs');
    expect(existsSync(join(p.runsDir, 'new.jsonl'))).toBe(true);
    // And the old copy is left alone rather than being silently discarded.
    expect(existsSync(join(dir, '.agentflow', 'runs', 'old.jsonl'))).toBe(true);
  });

  it('does nothing, quietly, when there is nothing to move', () => {
    expect(migrateLegacyState(paths())).toEqual([]);
  });

  it('leaves committed inputs where they are', () => {
    mkdirSync(join(dir, '.agentflow', 'workflows'), { recursive: true });
    writeFileSync(join(dir, '.agentflow', 'config.json'), '{}', 'utf8');
    migrateLegacyState(paths());
    expect(existsSync(join(dir, '.agentflow', 'config.json'))).toBe(true);
    expect(existsSync(join(dir, '.agentflow', 'workflows'))).toBe(true);
  });
});
