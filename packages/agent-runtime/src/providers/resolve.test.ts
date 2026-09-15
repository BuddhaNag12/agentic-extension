import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CLI_PATH_ENV, SDK_PATH_ENV, VENDOR_RELATIVE,
  claudeAuthStatus, claudeCliPath, sdkSpecifier, type Exec,
} from './resolve.js';

/**
 * The regression these guard is a packaging one, and it only appeared when
 * installed: under F5 the *workspace* had a `node_modules`, so a bare
 * specifier resolved and nothing looked wrong.
 */

const nothingExists = () => false;

describe('finding the Agent SDK', () => {
  it('prefers a vendored copy beside the bundle, as a file URL', () => {
    const from = '/ext/dist';
    const vendored = join(from, VENDOR_RELATIVE);

    const spec = sdkSpecifier({ from, env: {}, exists: (p) => p === vendored });
    // A path, not a bare specifier: the SDK is ESM-only and there is no
    // `node_modules` in scope to resolve a package name against.
    expect(spec).toBe(pathToFileURL(vendored).href);
    expect(spec.startsWith('file://')).toBe(true);
  });

  it('looks one directory up as well, for a nested bundle layout', () => {
    const from = '/ext/dist/sub';
    const vendored = join(from, '..', VENDOR_RELATIVE);
    expect(sdkSpecifier({ from, env: {}, exists: (p) => p === vendored }))
      .toBe(pathToFileURL(vendored).href);
  });

  it('falls back to the bare specifier, so a plain checkout still works', () => {
    expect(sdkSpecifier({ from: '/ext/dist', env: {}, exists: nothingExists }))
      .toBe('@anthropic-ai/claude-agent-sdk');
  });

  it('honours an explicit override ahead of everything else', () => {
    const from = '/ext/dist';
    const spec = sdkSpecifier({
      from,
      env: { [SDK_PATH_ENV]: '/elsewhere/sdk.mjs' },
      // The vendored copy exists and must still lose to the override.
      exists: () => true,
    });
    expect(spec).toBe(pathToFileURL('/elsewhere/sdk.mjs').href);
  });
});

describe('finding the Claude Code CLI', () => {
  it('takes the first match on PATH', () => {
    const env = { PATH: ['/a', '/b'].join(':') };
    expect(claudeCliPath({ env, exists: (p) => p === '/b/claude' })).toBe('/b/claude');
  });

  it('returns undefined when PATH has none, letting the SDK resolve its own', () => {
    // Not a failure: a checkout that installed the optional native dependency
    // should use it, and the SDK's own error is clear when neither exists.
    expect(claudeCliPath({ env: { PATH: '/a:/b' }, exists: nothingExists })).toBeUndefined();
  });

  it('tolerates an unset PATH', () => {
    expect(claudeCliPath({ env: {}, exists: () => true })).toBeUndefined();
  });

  it('honours an override', () => {
    expect(claudeCliPath({ env: { [CLI_PATH_ENV]: '/opt/claude' }, exists: () => true }))
      .toBe('/opt/claude');
  });

  it('ignores an override that does not exist rather than passing a bad path on', () => {
    // Handing the SDK a path that is not there produces a spawn failure deep
    // in a run; undefined lets it fall back to its own resolution.
    expect(claudeCliPath({ env: { [CLI_PATH_ENV]: '/nope' }, exists: nothingExists }))
      .toBeUndefined();
  });
});

describe('checking CLI authentication', () => {
  const says = (stdout: string, exitCode = 0): Exec => async () => ({ stdout, exitCode });

  it('reports signed in', async () => {
    const r = await claudeAuthStatus('claude', says('{"loggedIn":true,"authMethod":"oauth"}'));
    expect(r.state).toBe('signed_in');
  });

  it('reports signed out with the command that fixes it', async () => {
    // The CLI exits 1 when signed out and still prints the JSON saying so.
    const r = await claudeAuthStatus('claude', says('{"loggedIn":false,"authMethod":"none"}', 1));
    expect(r.state).toBe('signed_out');
    expect(r.detail).toContain('claude auth login');
  });

  it('tolerates leading noise before the JSON', async () => {
    const r = await claudeAuthStatus('claude', says('warning: something\n{"loggedIn":true}'));
    expect(r.state).toBe('signed_in');
  });

  it('is unknown, not signed out, when the CLI cannot be asked', async () => {
    // An older CLI without `auth status` is not evidence of being signed out;
    // blocking on it would break a working setup to guard a broken one.
    const boom: Exec = async () => { throw new Error('unknown command "auth"'); };
    const r = await claudeAuthStatus('claude', boom);
    expect(r.state).toBe('unknown');
    expect(r.detail).toContain('unknown command');
  });

  it('is unknown on unparseable or silent output', async () => {
    expect((await claudeAuthStatus('claude', says('not json at all'))).state).toBe('unknown');
    expect((await claudeAuthStatus('claude', says('{oops'))).state).toBe('unknown');
    expect((await claudeAuthStatus('claude', says('{"apiProvider":"firstParty"}'))).state).toBe('unknown');
  });
});
