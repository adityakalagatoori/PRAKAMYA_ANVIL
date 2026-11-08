#!/usr/bin/env node
// Registers model providers with a local TrueForge from a JSON file, substituting ${ENV_VAR}
// placeholders so API keys never live in the repository.
//
//   node scripts/register-providers.mjs [file] [--url http://localhost:8790] [--list]
//
// Default file: examples/model-providers.json if present, else examples/model-providers.example.json.
// Providers whose key env var is unset are skipped (with a message), so the example works with any subset.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const urlIdx = args.indexOf('--url');
const base = (urlIdx >= 0 ? args[urlIdx + 1] : process.env.TRUEFORGE_URL ?? 'http://localhost:8790').replace(/\/$/, '');
const listOnly = args.includes('--list');
const fileArg = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--url');
const file = fileArg ?? (existsSync(join(here, '..', 'examples', 'model-providers.json')) ? join(here, '..', 'examples', 'model-providers.json') : join(here, '..', 'examples', 'model-providers.example.json'));

async function api(method, path, body) {
  const res = await fetch(`${base}/api/v1/${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : undefined;
}

async function listModels() {
  const res = await api('GET', 'models');
  const items = res?.data ?? res ?? [];
  console.log('\nModels available in TrueForge (use these ids in "anvil.models"):');
  for (const m of items) console.log('  ' + (m.name ?? m.id ?? JSON.stringify(m)));
}

if (!listOnly) {
  const cfg = JSON.parse(readFileSync(file, 'utf8'));
  for (const p of cfg.providers) {
    const missing = [];
    const manifest = JSON.parse(
      JSON.stringify(p.manifest).replace(/\$\{([A-Z0-9_]+)\}/g, (_, v) => {
        if (!process.env[v]) missing.push(v);
        return process.env[v] ?? '';
      }),
    );
    const label = manifest.name ?? manifest.type;
    if (missing.length) {
      console.log(`- skip ${label}: set ${missing.join(', ')} to register it`);
      continue;
    }
    try {
      await api('PUT', 'settings/model-providers', { manifest });
      console.log(`✓ ${label}: ${manifest.models.map((m) => m.name).join(', ')}`);
    } catch (e) {
      console.log(`✗ ${label}: ${e.message}`);
    }
  }
}
try {
  await listModels();
} catch (e) {
  console.log(`(could not list models: ${e.message})`);
}
