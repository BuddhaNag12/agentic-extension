import { context, build } from 'esbuild';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/**
 * Two bundles: the extension host entry, and the orchestrator daemon that the
 * extension spawns as a separate process (§2.2). Bundling the daemon means the
 * packaged .vsix has no workspace-link dependencies at runtime.
 */

/**
 * The one thing that cannot be bundled: the Agent SDK.
 *
 * It is ESM-only and locates its own files through `import.meta.url`, which
 * bundling relocates. It is also imported through an opaque specifier so
 * TypeScript cannot downlevel it to `require()` (DECISIONS D23) — and an opaque
 * specifier is invisible to esbuild too, so the bare import survived into the
 * bundle and resolved against a `node_modules` that a packaged extension does
 * not have. So it is staged verbatim beside the bundle instead.
 *
 * Only `sdk.mjs` and its metadata: it imports nothing but node builtins, and
 * `bridge.mjs` / `browser-sdk.js` are separate entry points this never uses.
 * The 192 MB platform-specific native CLI is deliberately absent — the runtime
 * drives the developer's own `claude` (DECISIONS D42).
 */
const SDK_FILES = ['sdk.mjs', 'package.json', 'manifest.json', 'manifest.zst.json', 'LICENSE.md'];

function vendorSdk() {
  // Resolve the package entry, not `package.json`: the SDK's `exports` map
  // does not expose the manifest, so asking for it throws.
  const require = createRequire(import.meta.url);
  let from;
  try {
    from = dirname(require.resolve('@anthropic-ai/claude-agent-sdk'));
  } catch {
    console.warn('[esbuild] @anthropic-ai/claude-agent-sdk not installed; the packaged daemon will have no SDK');
    return;
  }

  const to = join('dist', 'vendor', '@anthropic-ai', 'claude-agent-sdk');
  mkdirSync(to, { recursive: true });
  for (const file of SDK_FILES) {
    const src = join(from, file);
    if (existsSync(src)) copyFileSync(src, join(to, file));
  }
  console.log(`[esbuild] vendored the Agent SDK into ${to}`);
}

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: true,
  logLevel: 'info',
};

const builds = [
  { ...shared, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', external: ['vscode'] },
  { ...shared, entryPoints: ['../orchestrator/src/main.ts'], outfile: 'dist/orchestrator.js', external: [] },
];

vendorSdk();

const watch = process.argv.includes('--watch');
for (const config of builds) {
  if (watch) {
    const ctx = await context(config);
    await ctx.watch();
  } else {
    await build(config);
  }
}
