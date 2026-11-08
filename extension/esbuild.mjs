import * as esbuild from 'esbuild';
import { readdirSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const tests = process.argv.includes('--tests');

if (tests) {
  // Bundle pure-logic tests (no vscode dependency) for node --test.
  const entries = readdirSync('test').filter((f) => f.endsWith('.test.ts') || f.endsWith('.live.ts')).map((f) => `test/${f}`);
  await esbuild.build({
    entryPoints: entries,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outdir: 'out-test',
    outExtension: { '.js': '.cjs' },
    alias: { vscode: './test/vscode-stub.ts' },
    sourcemap: 'inline',
  });
} else {
  const ctx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: 'dist/extension.js',
    external: ['vscode'],
    sourcemap: true,
    logLevel: 'info',
    mainFields: ['module', 'main'],
  });
  if (watch) await ctx.watch();
  else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}
