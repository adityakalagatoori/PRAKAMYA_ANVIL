/**
 * Live end-to-end harness (not part of `npm test`): real TrueForge + real model + real MCP server,
 * headless. Reviews are auto-accepted and written to a scratch copy of flask.
 *
 *   STUB_WORKSPACE=<flask copy> ANVIL_MODELS=a/b,c/d [ANVIL_TASK=A|B|C] npm run e2e
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { AnvilMcpServer } from '../src/mcp/server';
import { CodeIndex } from '../src/context/index';
import { RunState } from '../src/runState';
import { TrueForgeGateway } from '../src/trueforge/gateway';
import { AgentRunner, UiEvent } from '../src/trueforge/runner';
import { assembleContext, renderPack } from '../src/context/assembler';
import { computeHunks } from '../src/review/diff';

const WS = process.env.STUB_WORKSPACE!;
const models = (process.env.ANVIL_MODELS ?? '').split(',').filter(Boolean);
const task = process.env.ANVIL_TASK ?? 'B';
(globalThis as any).__anvilConfig = { models, trueforgeUrl: process.env.TRUEFORGE_URL ?? 'http://localhost:8790', retries: 1, iterationLimit: 40 };

const log = { appendLine: (s: string) => console.log('  [log] ' + s), show() {} } as any;

function load(): CodeIndex {
  const out: { path: string; text: string }[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      if (n.startsWith('.') || n === '__pycache__' || n === 'node_modules') continue;
      const f = join(d, n);
      if (statSync(f).isDirectory()) walk(f);
      else if (/\.(py|rst|md|toml|cfg)$/.test(n)) out.push({ path: relative(WS, f).replace(/\\/g, '/'), text: readFileSync(f, 'utf8') });
    }
  };
  walk(WS);
  return CodeIndex.build(out);
}

async function main() {
  let idx = load();
  const runs = new RunState();
  const applied: string[] = [];
  const reviews = {
    cancelAll() {},
    async review(uri: any, original: string, proposed: string) {
      const hunks = computeHunks(original, proposed);
      const rel = relative(WS, uri.fsPath).replace(/\\/g, '/');
      console.log(`  [review] ${rel}: ${hunks.length} hunk(s) → auto-accept`);
      mkdirSync(dirname(uri.fsPath), { recursive: true });
      writeFileSync(uri.fsPath, proposed);
      applied.push(rel);
      idx = idx.withFile(rel, proposed);
      return { status: 'decided', accepted: hunks.map((h) => h.index), rejected: [], total: hunks.length, finalText: proposed, hunks };
    },
  };
  const terminal = {
    run: async (cmd: string) => {
      const { execSync } = await import('node:child_process');
      console.log(`  [cmd] ${cmd}`);
      try {
        return 'exit code: 0\n' + execSync(cmd, { cwd: WS, encoding: 'utf8', timeout: 180000, stdio: 'pipe' }).slice(-4000);
      } catch (e: any) {
        return `exit code: ${e.status}\n${String(e.stdout ?? '').slice(-3000)}${String(e.stderr ?? '').slice(-2000)}`;
      }
    },
  };
  const mcp = new AnvilMcpServer({ index: { ready: async () => idx } as any, reviews: reviews as any, runs, log, terminal: terminal as any }, 'e2e-token', log);
  const port = await mcp.start(Number(process.env.MCP_PORT ?? 7399));
  const gw = new TrueForgeGateway(log, () => ({ url: `http://127.0.0.1:${port}/mcp`, token: 'e2e-token' }));
  const runner = new AgentRunner(gw, reviews as any, { forRun: () => [] } as any, runs, log);

  const events: UiEvent[] = [];
  let line = '';
  const sink = {
    emit: (e: UiEvent) => {
      events.push(e);
      if (e.t === 'delta') {
        line += e.text;
        if (line.length > 400 || e.text.includes('\n')) {
          process.stdout.write(line);
          line = '';
        }
      } else {
        if (line) process.stdout.write(line + '\n'), (line = '');
        const brief = JSON.stringify(e).slice(0, 300);
        console.log(`  <${e.t}> ${brief}`);
      }
    },
    approveCommand: async (_id: string, cmd: string) => {
      console.log(`  [approve] ${cmd}`);
      return true;
    },
  };

  const t0 = Date.now();
  let res;
  if (task === 'A') {
    const helpers = readFileSync(join(WS, 'src/flask/helpers.py'), 'utf8');
    const def = idx.findSymbol('get_debug_flag').find((d) => d.path === 'src/flask/helpers.py')!;
    const c = idx.chunkAt(def.path, def.line)!;
    const sel = helpers.split(/\r?\n/).slice(c.startLine - 1, c.endLine).join('\n');
    const prompt = `File: src/flask/helpers.py (language: python)\n<selection>\n${sel}\n</selection>\nInstruction: Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.\nReturn ONLY the replacement for the <selection> in one \`\`\`python code block.`;
    res = await runner.run('inline', prompt, sink);
  } else {
    const q =
      task === 'B'
        ? 'Add a new built-in CLI command flask config that prints the loaded application\'s configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.'
        : task;
    const pack = assembleContext(idx, q, { budget: 6000 });
    console.log(`  [context] ${pack.items.length} items, ${pack.used}/${pack.budget} tokens: ${[...new Set(pack.items.map((i) => i.path))].join(', ')}`);
    res = await runner.run('coder', `${q}\n\n${renderPack(pack)}`, sink);
  }
  if (line) console.log(line);
  console.log(`\n=== ${res.status} in ${((Date.now() - t0) / 1000).toFixed(1)}s (slot ${res.slot}) ${res.message ?? ''}`);
  console.log(`=== files applied: ${[...new Set(applied)].join(', ') || '(none)'}`);
  const counts: Record<string, number> = {};
  for (const e of events) counts[e.t] = (counts[e.t] ?? 0) + 1;
  console.log('=== event counts', counts);
  mcp.dispose();
  process.exit(res.status === 'done' ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
