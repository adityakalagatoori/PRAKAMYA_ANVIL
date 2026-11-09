import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { CodeIndex } from '../src/context/index';
import { ObservationLedger } from '../src/context/observation';
import { assessAdmission, pythonBindings, pythonCode, shouldHold } from '../src/review/grounding';

const FLASK = process.env.FLASK_REPO ?? join(__dirname, '..', '..', '..', 'flask-3.1.3');

function walk(dir: string, root: string, out: { path: string; text: string }[]) {
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.') || name === 'node_modules' || name === '__pycache__') continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, root, out);
    else if (/\.(py|rst|md)$/.test(name) && st.size < 512_000) out.push({ path: relative(root, full).replace(/\\/g, '/'), text: readFileSync(full, 'utf8') });
  }
}
const files: { path: string; text: string }[] = [];
walk(FLASK, FLASK, files);
const idx = CodeIndex.build(files);
const text = (p: string) => idx.files.get(p)!.text;
const CLI = 'src/flask/cli.py';
const HELPERS = 'src/flask/helpers.py';

/** Inserts `snippet` after the first line matching `anchor` (a tiny stand-in for edit_file). */
function insertAfter(src: string, anchor: RegExp, snippet: string): string {
  const lines = src.split('\n');
  const i = lines.findIndex((l) => anchor.test(l));
  lines.splice(i + 1, 0, ...snippet.split('\n'));
  return lines.join('\n');
}

test('observation ledger: validity is by content, so line shifts keep blocks valid and edits make them stale', () => {
  const led = new ObservationLedger();
  const src = 'a = 1\nb = 2\ndef f():\n    return 3\n';
  led.record('x.py', 1, src, 'read_file');
  assert.equal(led.valid('x.py', '# header\n' + src).length, 1, 'inserting lines elsewhere keeps the observation valid');
  assert.equal(led.stale('x.py', src.replace('return 3', 'return 4')).length, 1, 'changing the observed region makes it stale');
  assert.ok(led.sawLine('x.py', '    return 3', src));
  assert.ok(!led.sawLine('x.py', 'c = 9', src + 'c = 9\n'));
});

test('python masking and bindings ignore strings/comments and collect params, imports and assignments', () => {
  const code = pythonCode('x = "call_me()"  # other()\ndef g(a, b: int = 2, *args, **kw):\n    """doc mentions h()"""\n    from .mod import (p, q as r)\n    return a\n');
  assert.ok(!code.join('\n').includes('call_me') && !code.join('\n').includes('other') && !code.join('\n').includes('h()'));
  const b = pythonBindings(code);
  for (const n of ['x', 'g', 'a', 'b', 'args', 'kw', 'p', 'r']) assert.ok(b.names.has(n), n);
  assert.deepEqual(b.imports.map((i) => i.name), ['p', 'q']);
});

test('admission: a hallucinated import from a local module is "unknown" and holds the edit', () => {
  const led = new ObservationLedger();
  led.record(CLI, 1, text(CLI), 'read_file');
  const proposed = insertAfter(text(CLI), /^from \.globals import current_app/, 'from .helpers import get_debug_mode');
  const r = assessAdmission(idx, led, CLI, text(CLI), proposed);
  const issue = r.issues.find((i) => i.name === 'get_debug_mode');
  assert.equal(issue?.kind, 'unknown', JSON.stringify(r.issues));
  assert.ok(shouldHold(r));
});

test('admission: calling a repo function the model never saw (defined or used) is "unread"; once shown it is grounded', () => {
  const led = new ObservationLedger();
  led.record(CLI, 1, text(CLI), 'read_file'); // the model read cli.py but not helpers.py
  const proposed = insertAfter(text(CLI), /^\s*debug = get_debug_flag\(\)/, '    root = get_root_path(__name__)');
  const r1 = assessAdmission(idx, led, CLI, text(CLI), proposed);
  const issue = r1.issues.find((i) => i.name === 'get_root_path');
  assert.equal(issue?.kind, 'unread', JSON.stringify(r1.issues));
  assert.equal(issue?.def?.path, HELPERS);
  led.record(HELPERS, 1, text(HELPERS), 'admission');
  const r2 = assessAdmission(idx, led, CLI, text(CLI), proposed);
  assert.ok(!r2.issues.some((i) => i.name === 'get_root_path'), JSON.stringify(r2.issues));
});

test('admission: a definition the model saw before it changed is "stale"', () => {
  const led = new ObservationLedger();
  led.record(HELPERS, 1, text(HELPERS), 'read_file');
  led.record(CLI, 1, text(CLI), 'read_file');
  // Someone (user / another hunk) changes get_load_dotenv's signature after the model read it.
  const changed = idx.withFile(HELPERS, text(HELPERS).replace('def get_root_path(import_name: str) -> str:', 'def get_root_path(import_name: str, *, strict: bool = False) -> str:'));
  const proposed = insertAfter(text(CLI), /^\s*debug = get_debug_flag\(\)/, '    root = get_root_path(__name__)');
  const r = assessAdmission(changed, led, CLI, text(CLI), proposed);
  assert.equal(r.issues.find((i) => i.name === 'get_root_path')?.kind, 'stale', JSON.stringify(r.issues));
});

test('admission: changing a signature reports unseen callers/tests as blind spots until the model has seen them', () => {
  const led = new ObservationLedger();
  led.record(HELPERS, 1, text(HELPERS), 'read_file');
  const proposed = text(HELPERS).replace('def get_debug_flag() -> bool:', 'def get_debug_flag(default: bool) -> bool:');
  const r1 = assessAdmission(idx, led, HELPERS, text(HELPERS), proposed);
  const paths = new Set(r1.blindSpots.map((b) => b.path));
  for (const p of [CLI, 'src/flask/app.py', 'tests/test_helpers.py']) assert.ok(paths.has(p), `${p} in ${[...paths].join(', ')}`);
  assert.ok(r1.blindSpots.some((b) => b.relation === 'test'));
  assert.ok(shouldHold(r1));
  for (const b of r1.blindSpots) led.recordLines(b.path, [{ line: b.line, text: text(b.path).split(/\r?\n/)[b.line - 1] }], 'admission');
  const r2 = assessAdmission(idx, led, HELPERS, text(HELPERS), proposed);
  assert.equal(r2.blindSpots.length, 0, JSON.stringify(r2.blindSpots));
  assert.ok(r2.seenReferences >= r1.blindSpots.length);
});

test('admission: a well-grounded edit passes; non-Python files are not analysed', () => {
  const led = new ObservationLedger();
  led.record(HELPERS, 1, text(HELPERS), 'read_file');
  const proposed = text(HELPERS).replace('return bool(val and val.lower() not in {"0", "false", "no"})', 'return bool(val and val.lower() not in {"0", "false", "no", "off", "n"})');
  assert.notEqual(proposed, text(HELPERS));
  const r = assessAdmission(idx, led, HELPERS, text(HELPERS), proposed);
  assert.ok(!shouldHold(r), JSON.stringify(r));
  const md = assessAdmission(idx, new ObservationLedger(), 'README.md', '# a\n', '# a\nnew()\n');
  assert.equal(md.language, 'other');
  assert.ok(!shouldHold(md));
});
