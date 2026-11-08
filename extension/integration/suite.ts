/**
 * Runs INSIDE a real VS Code extension host (see integration/run.mjs).
 * Exercises the real review UI: diff editor, CodeLens, per-hunk accept/reject, disk state, undo, panel.
 */
import * as vscode from 'vscode';
import * as assert from 'node:assert/strict';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => T | Promise<T>, what: string, ms = 10000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timeout waiting for ' + what);
    await sleep(100);
  }
}

export async function run(): Promise<void> {
  const results: string[] = [];
  const check = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
      results.push(`PASS ${name}`);
    } catch (e) {
      results.push(`FAIL ${name}: ${(e as Error).stack ?? e}`);
    }
  };

  const ext = vscode.extensions.all.find((e) => e.packageJSON.name === 'anvil-agent')!;
  const api: any = await ext.activate();
  const root = vscode.workspace.workspaceFolders![0].uri;
  const file = vscode.Uri.joinPath(root, 'src', 'flask', 'helpers.py');
  const read = async () => new TextDecoder().decode(await vscode.workspace.fs.readFile(file));

  await check('diffEditor.codeLens enabled', async () => {
    assert.equal(vscode.workspace.getConfiguration('diffEditor').get('codeLens'), true);
  });

  await check('index built on activation', async () => {
    const idx = await api.index.ready();
    assert.ok(idx.files.has('src/flask/cli.py'));
    assert.ok(idx.findSymbol('get_debug_flag').length > 0);
  });

  await check('MCP server answers with token only', async () => {
    const { url, token } = api.mcpInfo();
    const bad = await fetch(url, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    assert.equal(bad.status, 401);
    const ok = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-anvil-token': token },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } }),
    });
    assert.equal(ok.status, 200);
  });

  await check('per-hunk review: accept one, reject one; disk reflects only the accepted hunk; undo restores', async () => {
    const original = await read();
    const lines = original.split('\n');
    const a = lines.findIndex((l) => l.startsWith('def get_debug_flag'));
    const b = lines.findIndex((l) => l.startsWith('def get_load_dotenv'));
    assert.ok(a > 0 && b > a + 5);
    const proposedLines = [...lines];
    proposedLines.splice(a, 0, '# HUNK-ONE');
    proposedLines.splice(b + 1, 0, '# HUNK-TWO');
    const proposed = proposedLines.join('\n');

    const p = api.reviews.review(file, original, proposed, { runId: 'itest', title: 'itest' });
    // Diff editor opens with our proposed doc
    const ed = await until(() => vscode.window.visibleTextEditors.find((e) => e.document.uri.scheme === 'anvil-proposed'), 'diff editor');
    // CodeLens offers Accept/Reject for each hunk
    const lenses: vscode.CodeLens[] = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', ed.document.uri);
    const titles = lenses.map((l) => l.command?.title ?? '');
    assert.equal(titles.filter((t) => t.includes('Accept') && !t.includes('all')).length, 2, titles.join(' | '));
    assert.equal(titles.filter((t) => t.includes('Reject') && !t.includes('all')).length, 2);
    // Nothing on disk yet
    assert.equal(await read(), original);

    // Accept the first hunk via its CodeLens command
    const acc = lenses.find((l) => l.command?.title.includes('Accept') && !l.command.title.includes('all'))!;
    await vscode.commands.executeCommand(acc.command!.command, ...(acc.command!.arguments ?? []));
    const afterOne = await read();
    assert.ok(afterOne.includes('# HUNK-ONE'));
    assert.ok(!afterOne.includes('# HUNK-TWO'));
    // Reject the remaining hunk via the keyboard command
    await vscode.commands.executeCommand('anvil.rejectHunkAtCursor');
    const res = await p;
    assert.equal(res.status, 'decided');
    assert.deepEqual(res.accepted, [0]);
    const final = await read();
    assert.ok(final.includes('# HUNK-ONE') && !final.includes('# HUNK-TWO'));
    // Diff tab closed
    await until(() => !vscode.window.visibleTextEditors.some((e) => e.document.uri.scheme === 'anvil-proposed'), 'diff closed');
    // Undo restores the original
    await vscode.commands.executeCommand('anvil.undoLast');
    assert.equal((await read()).replace(/\r\n/g, '\n'), original.replace(/\r\n/g, '\n'));
  });

  await check('cancel during review applies nothing', async () => {
    const original = await read();
    const p = api.reviews.review(file, original, original.replace('def get_debug_flag', '# X\ndef get_debug_flag'), { runId: 'itest2', title: 'itest2' });
    await until(() => vscode.window.visibleTextEditors.find((e) => e.document.uri.scheme === 'anvil-proposed'), 'diff editor');
    api.reviews.cancelAll('itest2');
    const r = await p;
    assert.equal(r.status, 'cancelled');
    assert.equal(await read(), original);
  });

  await check('new file review creates file; revert run deletes it', async () => {
    const nf = vscode.Uri.joinPath(root, 'anvil_itest_new.txt');
    const p = api.reviews.review(nf, '', 'hello\nworld\n', { runId: 'itest3', title: 'new', isNewFile: true });
    await until(() => vscode.window.visibleTextEditors.find((e) => e.document.uri.scheme === 'anvil-proposed'), 'diff editor');
    await vscode.commands.executeCommand('anvil.acceptAll');
    await p;
    assert.equal(new TextDecoder().decode(await vscode.workspace.fs.readFile(nf)), 'hello\nworld\n');
    await vscode.commands.executeCommand('anvil.revertRun', 'itest3');
    await assert.rejects(Promise.resolve(vscode.workspace.fs.stat(nf)));
  });

  await check('agent panel view resolves', async () => {
    await vscode.commands.executeCommand('anvil.openPanel');
    await sleep(500);
  });

  const report = results.join('\n');
  console.log('\n===== ANVIL INTEGRATION =====\n' + report + '\n=============================');
  if (results.some((r) => r.startsWith('FAIL'))) throw new Error('integration failures:\n' + report);
}
