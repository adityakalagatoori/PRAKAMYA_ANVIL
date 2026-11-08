import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { CodeIndex } from '../src/context/index';
import { assembleContext, renderPack } from '../src/context/assembler';
import { chunkFile } from '../src/context/chunker';
import { tokenize } from '../src/context/bm25';

const FLASK = process.env.FLASK_REPO ?? join(__dirname, '..', '..', '..', 'flask-3.1.3');

function walk(dir: string, root: string, out: { path: string; text: string }[]) {
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.') || name === 'node_modules' || name === '__pycache__') continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, root, out);
    else if (/\.(py|rst|md|toml|cfg|txt|html)$/.test(name) && st.size < 512_000) {
      out.push({ path: relative(root, full).replace(/\\/g, '/'), text: readFileSync(full, 'utf8') });
    }
  }
}

test('tokenizer splits identifiers', () => {
  const t = tokenize('get_debug_flag FlaskGroup listCommands');
  assert.ok(t.includes('debug') && t.includes('flag') && t.includes('get_debug_flag'));
  assert.ok(t.includes('group') && t.includes('command'));
});

test('python chunker finds defs, methods and decorators', () => {
  const src = 'import os\n\n@dec\ndef a():\n    return 1\n\nclass B:\n    """doc"""\n    def m(self):\n        pass\n\nX = 1\n';
  const { chunks, symbols } = chunkFile('x.py', src);
  assert.deepEqual(symbols.map((s) => s.qualified), ['a', 'B', 'B.m']);
  const a = chunks.find((c) => c.symbol === 'a')!;
  assert.equal(a.startLine, 3); // decorator attached
  assert.ok(chunks.some((c) => c.kind === 'module' && c.text.includes('X = 1')));
});

const haveFlask = existsSync(join(FLASK, 'src', 'flask', 'cli.py'));

test('Task B retrieval: finds cli.py, test_cli.py and docs/cli.rst within budget', { skip: !haveFlask }, () => {
  const files: { path: string; text: string }[] = [];
  walk(FLASK, FLASK, files);
  const t0 = Date.now();
  const index = CodeIndex.build(files);
  const buildMs = Date.now() - t0;
  const q =
    'Add a new built-in CLI command flask config that prints the loaded application\'s configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.';
  const pack = assembleContext(index, q, { budget: 6000 });
  const paths = new Set(pack.items.map((i) => i.path));
  console.log(`indexed ${files.length} files / ${index.chunks.length} chunks in ${buildMs}ms; used ${pack.used}/${pack.budget}`);
  for (const i of pack.items) console.log(`  ${i.path}:${i.startLine}-${i.endLine} ${i.symbol ?? ''} [${i.tokens}t] — ${i.reason}`);
  console.log('  candidates:', pack.candidates.map((c) => c.path).join(', '));
  assert.ok(pack.used <= pack.budget, 'stays within budget');
  assert.ok(paths.has('src/flask/cli.py'), 'cli.py chosen');
  assert.ok(paths.has('tests/test_cli.py'), 'test_cli.py chosen');
  assert.ok(paths.has('docs/cli.rst'), 'docs/cli.rst chosen');
  assert.ok(renderPack(pack).includes('why:'));
});

test('Task A retrieval: get_debug_flag is found by symbol', { skip: !haveFlask }, () => {
  const files: { path: string; text: string }[] = [];
  walk(FLASK, FLASK, files);
  const index = CodeIndex.build(files);
  const defs = index.findSymbol('get_debug_flag');
  assert.ok(defs.some((d) => d.path === 'src/flask/helpers.py'));
  const pack = assembleContext(index, 'Treat the values off and n as false in @get_debug_flag', { budget: 2000 });
  assert.ok(pack.items.some((i) => i.source === 'mention' && i.symbol === 'get_debug_flag'));
});
