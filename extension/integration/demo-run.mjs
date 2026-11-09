// Launches VS Code (isolated, maximized, window titled "Anvil Demo") on a fresh copy of flask and runs the
// scripted demo, which records each scene with ffmpeg.
//   ANVIL_FFMPEG=... ANVIL_VENV_BIN=... ANVIL_DEMO_OUT=... node integration/demo-run.mjs
import { runTests } from '@vscode/test-electron';
import { build } from 'esbuild';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ext = resolve(import.meta.dirname, '..');
const flask = resolve(process.argv[2] ?? join(ext, '..', '..', 'flask-3.1.3'));
await build({ entryPoints: [join(ext, 'integration', 'demo.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: join(ext, 'out-test', 'demo.cjs'), external: ['vscode'] });

delete process.env.ELECTRON_RUN_AS_NODE;
const tmp = mkdtempSync(join(tmpdir(), 'anvil-demo-'));
const ws = join(tmp, 'flask');
cpSync(flask, ws, { recursive: true, filter: (s) => !/[\\/](\.venv|__pycache__)([\\/]|$)/.test(s) });
const ud = join(tmp, 'ud');
mkdirSync(join(ud, 'User'), { recursive: true });
writeFileSync(
  join(ud, 'User', 'settings.json'),
  JSON.stringify(
    {
      'window.title': 'Anvil Demo',
      'window.newWindowDimensions': 'maximized',
      'window.dialogStyle': 'custom',
      'window.commandCenter': false,
      'workbench.colorTheme': 'Default Dark Modern',
      'workbench.startupEditor': 'none',
      'workbench.tips.enabled': false,
      'workbench.layoutControl.enabled': false,
      'chat.disableAIFeatures': true,
      'chat.commandCenter.enabled': false,
      'workbench.secondarySideBar.defaultVisibility': 'hidden',
      'editor.fontSize': 15,
      'editor.minimap.enabled': false,
      'editor.codeLens': true,
      'diffEditor.codeLens': true,
      'diffEditor.renderSideBySide': true,
      'terminal.integrated.fontSize': 14,
      'update.mode': 'none',
      'telemetry.telemetryLevel': 'off',
      'git.openRepositoryInParentFolders': 'never',
      'security.workspace.trust.enabled': false,
      'anvil.models': [process.env.ANVIL_LIVE_MODEL ?? 'ollama/qwen25-7b'],
    },
    null,
    2,
  ),
);
process.env.ANVIL_EXT_DIR = ext;

try {
  await runTests({
    extensionDevelopmentPath: ext,
    extensionTestsPath: join(ext, 'out-test', 'demo.cjs'),
    launchArgs: [ws, '--disable-extensions', '--user-data-dir', ud, '--skip-welcome', '--skip-release-notes'],
  });
  console.log('demo: OK');
} catch (e) {
  console.error('demo: FAILED', e?.message ?? e);
  process.exitCode = 1;
}
