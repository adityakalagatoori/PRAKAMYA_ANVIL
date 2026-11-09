import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContractEnv, contractCommands, evaluate, failing, finishGateMessage, forbiddenBy, globToRegExp, parseContract } from '../src/review/contract';

const TASK_B = {
  clauses: [
    { id: 'C1', text: '`flask --help` lists the config command', check: { type: 'command_output', command: 'flask --help', pattern: '\\bconfig\\b' } },
    { id: 'C2', text: 'CLI tests pass', check: { type: 'command_succeeds', command: 'python -m pytest tests/test_cli.py -q' } },
    { id: 'C3', text: 'docs describe flask config', check: { type: 'file_contains', path: 'docs/cli.rst', pattern: 'flask config' } },
    { id: 'C4', text: 'command implemented', check: { type: 'symbol_exists', name: 'config_command' } },
    { id: 'C5', text: 'shared fixtures untouched', check: { type: 'not_modified', path_glob: 'tests/conftest.py' } },
  ],
};

function env(state: { help: string; testsOk: boolean; docs: string; symbols: string[]; modified: string[] }): ContractEnv {
  return {
    run: async (cmd) => (cmd.startsWith('flask') ? { code: 0, output: state.help } : { code: state.testsOk ? 0 : 1, output: state.testsOk ? '59 passed' : 'FAILED test_config_masks' }),
    read: (p) => (p === 'docs/cli.rst' ? state.docs : undefined),
    symbolExists: (n) => state.symbols.includes(n),
    modified: () => state.modified,
  };
}

test('contract: Task B compiles to five typed clauses; invalid checks are rejected', () => {
  const p = parseContract(TASK_B);
  assert.ok(p.contract, p.error);
  assert.deepEqual(p.contract!.clauses.map((c) => c.check.type), ['command_output', 'command_succeeds', 'file_contains', 'symbol_exists', 'not_modified']);
  assert.deepEqual(contractCommands(p.contract!), ['flask --help', 'python -m pytest tests/test_cli.py -q']);
  assert.match(parseContract({ clauses: [{ text: 'x', check: { type: 'file_contains', path: 'a' } }] }).error!, /invalid check/);
  assert.match(parseContract({ clauses: [] }).error!, /non-empty/);
});

test('contract: evaluation tracks progress; the finish-gate message carries the failing evidence', async () => {
  const c = parseContract(TASK_B).contract!;
  const s = { help: 'Commands:\n  routes\n  run\n  shell', testsOk: false, docs: 'Run the server', symbols: [] as string[], modified: ['src/flask/cli.py'] };
  await evaluate(c, env(s), { commands: true });
  assert.deepEqual(failing(c).map((x) => x.id), ['C1', 'C2', 'C3', 'C4']);
  const msg = finishGateMessage(c, 1);
  assert.match(msg, /C2 "CLI tests pass"/);
  assert.match(msg, /FAILED test_config_masks/);
  // The agent fixes things; a live (no-command) pass updates file/symbol clauses only.
  s.docs = 'Use ``flask config`` to print the configuration.';
  s.symbols = ['config_command'];
  await evaluate(c, env(s), { commands: false });
  assert.deepEqual(failing(c).map((x) => x.id), ['C1', 'C2'], 'command clauses keep their last result until re-run');
  s.help = 'Commands:\n  config  Show the app config\n  routes';
  s.testsOk = true;
  await evaluate(c, env(s), { commands: true });
  assert.deepEqual(failing(c), []);
});

test('contract: negative scope is enforced and detected', async () => {
  const c = parseContract(TASK_B).contract!;
  assert.equal(forbiddenBy(c, 'tests/conftest.py')?.id, 'C5');
  assert.equal(forbiddenBy(c, 'tests/test_cli.py'), undefined);
  await evaluate(c, env({ help: '', testsOk: true, docs: '', symbols: [], modified: ['tests/conftest.py'] }), { commands: false });
  assert.equal(c.results.get('C5')!.state, 'fail');
  assert.ok(globToRegExp('src/**/*.py').test('src/flask/json/provider.py'));
  assert.ok(!globToRegExp('src/*.py').test('src/flask/cli.py'));
});
