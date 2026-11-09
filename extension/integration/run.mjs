// Launches VS Code with Anvil loaded on a throwaway copy of flask and runs integration/suite.ts inside it.
//   node integration/run.mjs [path-to-flask]   (uses the locally installed VS Code if found)
import { runTests } from '@vscode/test-electron';
import { build } from 'esbuild';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';

const ext = resolve(import.meta.dirname, '..');
const flask = resolve(process.argv[2] ?? join(ext, '..', '..', 'flask-3.1.3'));
await build({ entryPoints: [join(ext, 'integration', 'suite.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: join(ext, 'out-test', 'integration.cjs'), external: ['vscode'] });

// When launched from inside VS Code, this env var would make Code.exe behave as plain node.
delete process.env.ELECTRON_RUN_AS_NODE;
process.env.ANVIL_AUTOMATION ??= "1"; // review prompts (acceptance closure) pick their first option instead of blocking
const tmp = mkdtempSync(join(tmpdir(), 'anvil-it-'));
const ws = join(tmp, 'flask');
cpSync(flask, ws, { recursive: true, filter: (s) => !/[\\/](\.git|\.venv|__pycache__)([\\/]|$)/.test(s) });

const local = [
  join(homedir(), 'AppData', 'Local', 'Programs', 'Microsoft VS Code', 'Code.exe'),
  '/Applications/Visual Studio Code.app/Contents/MacOS/Electron',
  '/usr/share/code/code',
].find(existsSync);

try {
  await runTests({
    vscodeExecutablePath: process.env.ANVIL_LOCAL_CODE ? local : undefined, // default: isolated download in .vscode-test
    extensionDevelopmentPath: ext,
    extensionTestsPath: join(ext, 'out-test', 'integration.cjs'),
    launchArgs: [ws, '--disable-extensions', '--user-data-dir', join(tmp, 'ud'), '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust'],
  });
  console.log('integration: OK');
} catch (e) {
  console.error('integration: FAILED', e?.message ?? e);
  process.exitCode = 1;
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
}
