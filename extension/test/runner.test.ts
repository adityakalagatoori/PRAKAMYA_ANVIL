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
