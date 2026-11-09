import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentPanel } from '../src/agent/panel';

test('panel: demoAutoApprove is off by default (only recording mode turns it on)', () => {
  const panel = new AgentPanel({} as any, {} as any, {} as any, {} as any, { appendLine: () => {} } as any);
  assert.equal(panel.demoAutoApprove, false);
});
