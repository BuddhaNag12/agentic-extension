import { context, build } from 'esbuild';

/**
 * Two bundles: the extension host entry, and the orchestrator daemon that the
 * extension spawns as a separate process (§2.2). Bundling the daemon means the
 * packaged .vsix has no workspace-link dependencies at runtime.
 */
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

const watch = process.argv.includes('--watch');
for (const config of builds) {
  if (watch) {
    const ctx = await context(config);
    await ctx.watch();
  } else {
    await build(config);
  }
}
