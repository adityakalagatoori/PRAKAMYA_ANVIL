import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AgentRunner, UiEvent } from '../src/trueforge/runner';
import { RunState } from '../src/runState';

const FLASK = process.env.STUB_WORKSPACE ?? '';
const have = existsSync(join(FLASK, 'src', 'flask', 'helpers.py'));
const log = { appendLine: () => {} } as any;

/** Fake TrueForge: scripted turns per session. */
function fakeGateway(models: string[], script: (slot: number, input: any[], emit: (e: any) => void, signal: AbortSignal) => Promise<any>) {
  const sessions = new Map<string, number>();
  const calls: { cancel: string[]; inputs: any[][] } = { cancel: [], inputs: [] };
  let n = 0;
  return {
    calls,
    gw: {
      ensureSetup: async () => {},
      models: () => models,
      agentName: (k: string, s: number) => `anvil-${k}${s ? '-fb' + s : ''}`,
      sessionUrl: (id: string) => `http://tf/sessions/${id}`,
      createSession: async (_k: string, slot: number) => {
        const id = `s${++n}`;
        sessions.set(id, slot);
        return id;
      },
      streamTurn: async (id: string, input: any[], onEvent: (e: any) => void, signal: AbortSignal) => {
        calls.inputs.push(input);
        return script(sessions.get(id)!, input, onEvent, signal);
      },
      cancel: async (id: string) => {
        calls.cancel.push(id);
      },
    } as any,
  };
}

const sinkOf = (events: UiEvent[]) => ({ emit: (e: UiEvent) => events.push(e), approveCommand: async () => true });
const done = (extra = {}) => ({ status: 'done', completedAt: '', output: null, requiredActions: [], ...extra });

test('Task C: invalid key on primary → automatic fallback to second model, no retries on auth errors', async () => {
  let primaryCalls = 0;
  const { gw } = fakeGateway(['bad/model', 'good/model'], async (slot, _in, emit) => {
    if (slot === 0) {
      primaryCalls++;
      return { status: 'error', message: '401 Unauthorized: invalid api key', completedAt: '' };
    }
    emit({ type: 'model.message.delta', id: 'm1', threadId: 'main', content: 'fixed' });
    return done();
  });
  const events: UiEvent[] = [];
  const runner = new AgentRunner(gw, { cancelAll() {} } as any, { forRun: () => [] } as any, new RunState(), log);
  const r = await runner.run('inline', 'x', sinkOf(events));
  assert.equal(r.status, 'done');
  assert.equal(r.slot, 1);
  assert.equal(primaryCalls, 1, 'auth errors are not retried');
  assert.ok(events.some((e) => e.t === 'fallback' && e.to === 'good/model'));
  assert.ok(events.some((e) => e.t === 'delta' && e.text === 'fixed'));
});

test('transient errors are retried with backoff before falling back; all-fail gives a clear error', async () => {
  let calls = 0;
  const { gw } = fakeGateway(['only/model'], async () => {
    calls++;
    return { status: 'error', message: 'connect ECONNREFUSED 127.0.0.1:9', completedAt: '' };
  });
  const events: UiEvent[] = [];
  const runner = new AgentRunner(gw, { cancelAll() {} } as any, { forRun: () => [] } as any, new RunState(), log);
  const t0 = Date.now();
  const r = await runner.run('inline', 'x', sinkOf(events));
  assert.equal(r.status, 'error');
  assert.match(r.message!, /ECONNREFUSED/);
  assert.equal(calls, 3); // 1 + 2 retries (default)
  assert.ok(Date.now() - t0 >= 3900, 'backoff 1s + 3s');
  assert.ok(events.filter((e) => e.t === 'notice').length >= 2);
});

test('approval_required for edit_file → diff review → allow sent back to TrueForge', { skip: !have }, async () => {
  const { gw, calls } = fakeGateway(['m/1'], async (_slot, input, emit) => {
    if (input[0].type === 'user.message') {
      emit({
        type: 'model.message', id: 'm1', threadId: 'main', createdAt: '',
        toolCalls: [{ id: 'tc1', type: 'function', function: { name: 'edit_file', arguments: JSON.stringify({ path: 'src/flask/helpers.py', old_string: 'def get_debug_flag() -> bool:', new_string: 'def get_debug_flag() -> bool:  # x' }) }, toolInfo: { type: 'mcp', name: 'edit_file', serverName: 'anvil-editor', serverId: '1' } }],
      });
      emit({ type: 'tool.approval_required', id: 'a1', threadId: 'main', createdAt: '', toolCalls: [{ id: 'tc1', sourceEventId: 'm1' }] });
      return done();
    }
    emit({ type: 'tool.response', id: 'r', threadId: 'main', createdAt: '', toolCallId: 'tc1', content: 'Applied all 1 hunk(s)' });
    emit({ type: 'model.message', id: 'm2', threadId: 'main', createdAt: '', content: 'Done.' });
    return done();
  });
  const reviewed: string[] = [];
  const reviews = {
    cancelAll() {},
    review: async (_u: any, original: string, proposed: string) => {
      reviewed.push(proposed);
      assert.notEqual(original, proposed);
      return { status: 'decided', accepted: [0], rejected: [], total: 1, finalText: proposed, hunks: [] };
    },
  };
  const runs = new RunState();
  const events: UiEvent[] = [];
  const runner = new AgentRunner(gw, reviews as any, { forRun: () => [] } as any, runs, log);
  const r = await runner.run('coder', 'do it', sinkOf(events));
  assert.equal(r.status, 'done');
  assert.equal(reviewed.length, 1);
  assert.ok(reviewed[0].includes('def get_debug_flag() -> bool:  # x'));
  const second = calls.inputs[1];
  assert.deepEqual(second, [{ type: 'user.tool_approval', threadId: 'main', toolCallId: 'tc1', approval: { status: 'allow' } }]);
  assert.equal(r.output, 'Done.');
});

test('edit_file with old_string not found → auto-deny with reason, no review opened', { skip: !have }, async () => {
  const { gw, calls } = fakeGateway(['m/1'], async (_s, input, emit) => {
    if (input[0].type === 'user.message') {
      emit({ type: 'model.message', id: 'm1', threadId: 'main', createdAt: '', toolCalls: [{ id: 'tc9', type: 'function', function: { name: 'anvil-editor__edit_file', arguments: JSON.stringify({ path: 'src/flask/helpers.py', old_string: 'NOT IN FILE', new_string: 'y' }) } }] });
      emit({ type: 'tool.approval_required', id: 'a', threadId: 'main', createdAt: '', toolCalls: [{ id: 'tc9', sourceEventId: 'm1' }] });
    }
    return done();
  });
  let opened = 0;
  const runner = new AgentRunner(gw, { cancelAll() {}, review: async () => (opened++, {}) } as any, { forRun: () => [] } as any, new RunState(), log);
  await runner.run('coder', 'x', sinkOf([]));
  assert.equal(opened, 0);
  assert.equal(calls.inputs[1][0].approval.status, 'deny');
  assert.match(calls.inputs[1][0].approval.reason, /not found/);
});

test('cancellation mid-stream: stops immediately, cancels the TrueForge session, cancels reviews', async () => {
  const { gw, calls } = fakeGateway(['m/1'], (_s, _i, emit, signal) => {
    emit({ type: 'model.message.delta', id: 'd', threadId: 'main', content: 'partial…' });
    return new Promise((resolve) => signal.addEventListener('abort', () => resolve({ status: 'cancelled', reason: 'client-cancelled', completedAt: '' })));
  });
  let cancelledReviews = 0;
  const runs = new RunState();
  const runner = new AgentRunner(gw, { cancelAll: () => cancelledReviews++ } as any, { forRun: () => [] } as any, runs, log);
  const p = runner.run('coder', 'x', sinkOf([]));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(runner.isRunning, true);
  await runner.cancel();
  const r = await p;
  assert.equal(r.status, 'cancelled');
  assert.deepEqual(calls.cancel, ['s1']);
  assert.ok(cancelledReviews >= 1);
  assert.equal(runner.isRunning, false);
  assert.equal(runs.active, undefined);
});

test('text-printed tool call is detected and nudged (local-model robustness)', async () => {
  let turn = 0;
  const { gw, calls } = fakeGateway(['m/1'], async (_s, input, emit) => {
    turn++;
    if (turn === 1) emit({ type: 'model.message.delta', id: 'x', threadId: 'main', content: '```json\n{"name": "read_file", "arguments": {"path": "a.py"}}\n```' });
    else emit({ type: 'model.message.delta', id: 'y', threadId: 'main', content: 'ok' });
    return done();
  });
  const events: UiEvent[] = [];
  const runner = new AgentRunner(gw, { cancelAll() {} } as any, { forRun: () => [] } as any, new RunState(), log);
  const r = await runner.run('coder', 'x', sinkOf(events));
  assert.equal(r.status, 'done');
  assert.equal(calls.inputs.length, 2);
  assert.match(calls.inputs[1][0].content, /function-calling/);
  assert.ok(events.some((e) => e.t === 'notice' && /plain text/.test(e.text)));
});

test('live shape: tool call arrives only as streamed delta fragments → still reviewed via approval', { skip: !have }, async () => {
  const args = JSON.stringify({ path: 'src/flask/helpers.py', old_string: 'def get_debug_flag() -> bool:', new_string: 'def get_debug_flag() -> bool:  # y' });
  const { gw, calls } = fakeGateway(['m/1'], async (_s, input, emit) => {
    if (input[0].type === 'user.message') {
      const info = { type: 'mcp', name: 'edit_file', serverName: 'anvil-editor', serverId: 'anvil-editor' };
      // Live order: empty base model.message first, then deltas with the same id.
      emit({ type: 'model.message', id: 'm1', threadId: 'main', createdAt: '' });
      emit({ type: 'model.message.delta', id: 'm1', threadId: 'main', toolCalls: [{ index: 0, id: 'tcD', type: 'function', function: { name: 'edit_file', arguments: args.slice(0, 20) }, toolInfo: info }] });
      emit({ type: 'model.message.delta', id: 'm1', threadId: 'main', toolCalls: [{ index: 0, function: { arguments: args.slice(20) } }] });
      emit({ type: 'model.message.delta', id: 'm1', threadId: 'main', finishReason: 'tool_calls' });
      emit({ type: 'tool.approval_required', id: 'a', threadId: 'main', createdAt: '', toolCalls: [{ id: 'tcD', sourceEventId: 'm1' }] });
      return done();
    }
    return done();
  });
  const events: UiEvent[] = [];
  let reviewed = '';
  const reviews = { cancelAll() {}, review: async (_u: any, _o: string, p: string) => ((reviewed = p), { status: 'decided', accepted: [0], rejected: [], total: 1, finalText: p, hunks: [] }) };
  const runner = new AgentRunner(gw, reviews as any, { forRun: () => [] } as any, new RunState(), log);
  await runner.run('coder', 'x', sinkOf(events));
  assert.ok(reviewed.includes('# y'), 'review opened with merged args');
  assert.ok(events.some((e) => e.t === 'tool.start' && e.name === 'edit_file'));
  assert.deepEqual(calls.inputs[1][0].approval, { status: 'allow' });
});

test('auto-continue when a change request ends without any write attempt', async () => {
  let turn = 0;
  const { gw, calls } = fakeGateway(['m/1'], async (_s, _input, emit) => {
    turn++;
    emit({ type: 'model.message.delta', id: 'x' + turn, threadId: 'main', content: 'Here is what I found…', finishReason: 'stop' });
    return done();
  });
  const events: UiEvent[] = [];
  const runner = new AgentRunner(gw, { cancelAll() {} } as any, { forRun: () => [] } as any, new RunState(), log);
  const rr = await runner.run('coder', 'Add a config command <anvil_context>…</anvil_context>', sinkOf(events));
  assert.equal(calls.inputs.length, 3, 'initial + 2 continues');
  assert.match(calls.inputs[1][0].content, /implement the requested change/);
  // A question (not a change request) does not trigger it.
  const r2 = fakeGateway(['m/1'], async (_s, _i, emit) => (emit({ type: 'model.message.delta', id: 'q', threadId: 'main', content: 'answer', finishReason: 'stop' }), done()));
  await new AgentRunner(r2.gw, { cancelAll() {} } as any, { forRun: () => [] } as any, new RunState(), log).run('coder', 'How does routing work?', sinkOf([]));
  assert.equal(r2.calls.inputs.length, 1);
});

test('rate limit: honours provider retry hint, resumes the SAME session, does not burn retries or fall back', async () => {
  const { rateLimitDelayMs } = await import('../src/trueforge/runner');
  assert.equal(rateLimitDelayMs('Request failed (429): quota exceeded. Please retry in 0.2s.'), 2000);
  assert.equal(rateLimitDelayMs('429 Too Many Requests. Please retry in 27.69s.'), 28690);
  assert.equal(rateLimitDelayMs('401 invalid api key'), undefined);
  let calls = 0;
  const { gw, calls: c } = fakeGateway(['m/1', 'm/2'], async (slot, input, emit) => {
    calls++;
    if (calls <= 3) return { status: 'error', message: '[Model Error] Request failed (429): quota. Please retry in 0.01s.', completedAt: '' };
    emit({ type: 'model.message.delta', id: 'ok', threadId: 'main', content: `done on ${slot} after ${input[0].content.slice(0, 20)}`, finishReason: 'stop' });
    return done();
  });
  const events: UiEvent[] = [];
  const runner = new AgentRunner(gw, { cancelAll() {} } as any, { forRun: () => [] } as any, new RunState(), log);
  const r = await runner.run('coder', 'How does routing work?', sinkOf(events));
  assert.equal(r.status, 'done');
  assert.equal(r.slot, 0, 'stayed on the primary model (retries=2 but 3 rate-limit waits)');
  assert.equal(r.sessionId, 's1', 'resumed the same TrueForge session');
  assert.match(c.inputs[1][0].content, /Continue the task/);
  assert.ok(events.some((e) => e.t === 'notice' && /Rate limited/.test(e.text)));
  assert.ok(!events.some((e) => e.t === 'fallback'));
});

test('daily quota exhausted → immediate fallback (no futile waiting)', async () => {
  const { isDailyQuota, rateLimitDelayMs } = await import('../src/trueforge/runner');
  const daily = 'Request failed (429): You exceeded your current quota. Quota exceeded for metric: generate_content_free_tier_requests, limit: 20, description: Generate content requests per day limit exceeded on Free Tier. Please retry in 30s.';
  assert.ok(isDailyQuota(daily));
  assert.equal(rateLimitDelayMs(daily), undefined);
  let primary = 0;
  const { gw } = fakeGateway(['a/1', 'b/2'], async (slot, _i, emit) => {
    if (slot === 0) return primary++, { status: 'error', message: daily, completedAt: '' };
    emit({ type: 'model.message.delta', id: 'x', threadId: 'main', content: 'ok', finishReason: 'stop' });
    return done();
  });
  const t0 = Date.now();
  const r = await new AgentRunner(gw, { cancelAll() {} } as any, { forRun: () => [] } as any, new RunState(), log).run('coder', 'question?', sinkOf([]));
  assert.equal(r.slot, 1);
  assert.equal(primary, 1);
  assert.ok(Date.now() - t0 < 1500);
});

test('admission gate: an edit relying on a name that does not exist is held before review; the corrected edit reaches review', { skip: !have }, async () => {
  const { CodeIndex } = await import('../src/context/index');
  const { readFileSync, readdirSync, statSync } = await import('node:fs');
  const { relative } = await import('node:path');
  const files: { path: string; text: string }[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name.startsWith('.') || name === '__pycache__') continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(py|rst)$/.test(name)) files.push({ path: relative(FLASK, full).split('\\').join('/'), text: readFileSync(full, 'utf8') });
    }
  };
  walk(FLASK);
  const idx = CodeIndex.build(files);
  const bad = { path: 'src/flask/cli.py', old_string: 'from .globals import current_app', new_string: 'from .globals import current_app\nfrom .helpers import get_debug_mode' };
  const good = { path: 'src/flask/cli.py', old_string: 'from .globals import current_app', new_string: 'from .globals import current_app\nfrom .helpers import get_debug_flag as _debug_flag' };
  let turn = 0;
  const { gw, calls } = fakeGateway(['m/1'], async (_s, _input, emit) => {
    turn++;
    if (turn === 1 || turn === 2) {
      const args = turn === 1 ? bad : good;
      emit({ type: 'model.message', id: `m${turn}`, threadId: 'main', createdAt: '', toolCalls: [{ id: `tc${turn}`, type: 'function', function: { name: 'edit_file', arguments: JSON.stringify(args) } }] });
      emit({ type: 'tool.approval_required', id: `a${turn}`, threadId: 'main', createdAt: '', toolCalls: [{ id: `tc${turn}`, sourceEventId: `m${turn}` }] });
      return done();
    }
    emit({ type: 'model.message', id: 'm9', threadId: 'main', createdAt: '', content: 'Done.' });
    return done();
  });
  const reviewed: string[] = [];
  const reviews = { cancelAll() {}, review: async (_u: any, _o: string, proposed: string, opts: any) => (reviewed.push(proposed), (reviews as any).notes = opts.notes, { status: 'decided', accepted: [0], rejected: [], total: 1, finalText: proposed, hunks: [] }) };
  const runs = new RunState();
  const events: UiEvent[] = [];
  const runner = new AgentRunner(gw, reviews as any, { forRun: () => [] } as any, runs, log, { ready: async () => idx });
  // The context pack showed cli.py to the model.
  const r = await runner.run('coder', 'x', sinkOf(events), { observations: [{ path: 'src/flask/cli.py', line: 1, text: idx.files.get('src/flask/cli.py')!.text }] });
  assert.equal(r.status, 'done');
  const first = calls.inputs[1][0];
  assert.equal(first.approval.status, 'deny', 'the hallucinated import is held');
  assert.match(first.approval.reason, /get_debug_mode/);
  assert.match(first.approval.reason, /BEFORE showing it to the user/);
  assert.equal(reviewed.length, 1, 'only the corrected edit reached the human');
  assert.ok(reviewed[0].includes('get_debug_flag as _debug_flag'));
  assert.equal(calls.inputs[2][0].approval.status, 'allow');
  assert.ok(events.some((e) => e.t === 'admission' && e.held));
  assert.ok(((reviews as any).notes as string[]).some((n) => /^Grounding: /.test(n)), 'the review shows the grounding badge');
});

test('finish gate: the run cannot end while an approved contract clause fails; the agent gets the evidence and fixes it', { skip: !have }, async () => {
  const { CodeIndex } = await import('../src/context/index');
  const contract = { clauses: [{ id: 'C1', text: 'help lists config', check: { type: 'command_output', command: 'flask --help', pattern: 'config' } }] };
  let turn = 0;
  const { gw, calls } = fakeGateway(['m/1'], async (_s, _input, emit) => {
    turn++;
    if (turn === 1) {
      emit({ type: 'model.message', id: 'm1', threadId: 'main', createdAt: '', toolCalls: [{ id: 'tcC', type: 'function', function: { name: 'propose_contract', arguments: JSON.stringify(contract) } }] });
      emit({ type: 'tool.approval_required', id: 'aC', threadId: 'main', createdAt: '', toolCalls: [{ id: 'tcC', sourceEventId: 'm1' }] });
      return done();
    }
    emit({ type: 'model.message', id: `m${turn}`, threadId: 'main', createdAt: '', content: 'Done.' });
    return done();
  });
  let helpRuns = 0;
  const terminal = { run: async () => (++helpRuns === 1 ? 'exit code: 0\nCommands:\n  routes\n  run' : 'exit code: 0\nCommands:\n  config\n  routes') };
  const runs = new RunState();
  const events: UiEvent[] = [];
  const runner = new AgentRunner(gw, { cancelAll() {} } as any, { forRun: () => [] } as any, runs, log, { ready: async () => CodeIndex.build([]) }, terminal as any);
  const r = await runner.run('coder', 'x', sinkOf(events));
  assert.equal(r.status, 'done');
  assert.equal(calls.inputs[1][0].approval.status, 'allow', 'the user approved the contract');
  const gate = calls.inputs[2][0];
  assert.equal(gate.type, 'user.message', 'finishing with a failing clause is withheld');
  assert.match(gate.content, /finish gate \(1\/2\)/);
  assert.match(gate.content, /does not match \/config\//);
  assert.equal(calls.inputs.length, 3, 'second attempt passes the gate');
  assert.ok(events.some((e) => e.t === 'notice' && /Intent contract satisfied/.test(e.text)));
  assert.ok(events.some((e) => e.t === 'contract' && e.phase === 'checked'));
});

test('contract scope: an edit to a file the contract forbids is denied before review', { skip: !have }, async () => {
  const contract = { clauses: [{ id: 'C9', text: 'do not touch helpers', check: { type: 'not_modified', path_glob: 'src/flask/helpers.py' } }] };
  let turn = 0;
  const { gw, calls } = fakeGateway(['m/1'], async (_s, _input, emit) => {
    turn++;
    if (turn === 1) {
      emit({ type: 'model.message', id: 'm1', threadId: 'main', createdAt: '', toolCalls: [{ id: 'tcC', type: 'function', function: { name: 'propose_contract', arguments: JSON.stringify(contract) } }] });
      emit({ type: 'tool.approval_required', id: 'aC', threadId: 'main', createdAt: '', toolCalls: [{ id: 'tcC', sourceEventId: 'm1' }] });
      return done();
    }
    if (turn === 2) {
      emit({ type: 'model.message', id: 'm2', threadId: 'main', createdAt: '', toolCalls: [{ id: 'tcE', type: 'function', function: { name: 'edit_file', arguments: JSON.stringify({ path: 'src/flask/helpers.py', old_string: 'def get_debug_flag() -> bool:', new_string: 'def get_debug_flag() -> bool:  # x' }) } }] });
      emit({ type: 'tool.approval_required', id: 'aE', threadId: 'main', createdAt: '', toolCalls: [{ id: 'tcE', sourceEventId: 'm2' }] });
      return done();
    }
    emit({ type: 'model.message', id: 'm3', threadId: 'main', createdAt: '', content: 'ok' });
    return done();
  });
  let opened = 0;
  const runner = new AgentRunner(gw, { cancelAll() {}, review: async () => (opened++, {}) } as any, { forRun: () => [] } as any, new RunState(), log);
  await runner.run('coder', 'x', sinkOf([]));
  assert.equal(opened, 0, 'no review was opened');
  assert.equal(calls.inputs[2][0].approval.status, 'deny');
  assert.match(calls.inputs[2][0].approval.reason, /clause C9/);
});
