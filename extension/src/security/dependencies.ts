/**
 * Name-origin dependency guard.
 *
 * An agent can introduce a package name that does not exist (hallucinated) or that exists but was
 * never installed by anyone here (a classic slopsquatting vector: an attacker registers the exact
 * name a model is statistically likely to invent). P1's grounding only checks names resolvable to
 * a *local* module; third-party imports are skipped entirely (`resolvePyModule` returns undefined
 * and the caller moves on). This module closes that gap: a newly introduced third-party name is
 * "anchored" only if something other than the model's own text already ties it to this workspace —
 * an installed package, a lockfile/manifest entry, or text the user actually wrote. An unanchored
 * name is held the same way P1 holds an edit, with evidence of what WOULD anchor it.
 * Pure (no vscode) except for the optional installed-package probe, which takes an injected reader.
 */

export interface DepWorkspace {
  /** Reads a workspace-relative file, or undefined if absent. */
  read(path: string): string | undefined;
  /** True if something resembling an installed package of this name exists (venv/node_modules). */
  installed(name: string, ecosystem: 'py' | 'js'): boolean;
}

export interface DependencyIssue {
  name: string;
  ecosystem: 'py' | 'js';
  line: number;
  /** What anchor is missing. */
  reason: string;
}

// A deliberately generous stdlib/builtin list: false negatives here just mean a few extra checks,
// never a false "unanchored" on real stdlib usage (checked first, before any network-ish logic).
const PY_STDLIB = new Set(
  (
    'abc argparse array ast asyncio atexit base64 bisect builtins bz2 calendar collections configparser contextlib copy ' +
    'csv ctypes dataclasses datetime decimal difflib dis email enum errno faulthandler fcntl filecmp fileinput fnmatch ' +
    'fractions ftplib functools gc getopt getpass gettext glob gzip hashlib heapq hmac html http imaplib imp importlib ' +
    'inspect io ipaddress itertools json keyword linecache locale logging lzma mailbox marshal math mimetypes mmap ' +
    'multiprocessing numbers operator os pathlib pdb pickle pickletools pkgutil platform plistlib poplib posixpath pprint ' +
    'profile pstats pty pwd py_compile pyclbr pydoc queue quopri random re readline reprlib resource sched secrets select ' +
    'selectors shelve shlex shutil signal site smtplib sndhdr socket socketserver sqlite3 ssl stat statistics string ' +
    'stringprep struct subprocess sunau symtable sys sysconfig syslog tarfile tempfile termios textwrap threading time ' +
    'timeit tkinter token tokenize trace traceback tracemalloc tty turtle types typing unicodedata unittest urllib uuid ' +
    'venv warnings wave weakref webbrowser wsgiref xdrlib xml xmlrpc zipapp zipfile zipimport zlib zoneinfo __future__ ' +
    '__main__ _thread t typing_extensions annotations dataclasses contextvars graphlib'
  ).split(' '),
);
const JS_BUILTIN = new Set('assert async_hooks buffer child_process cluster crypto dgram dns domain events fs http http2 https net os path perf_hooks process punycode querystring readline repl stream string_decoder timers tls tty url util v8 vm worker_threads zlib node:test'.split(' '));

function topLevel(mod: string, ecosystem: 'py' | 'js'): string {
  if (ecosystem === 'py') return mod.split('.')[0];
  if (mod.startsWith('node:')) return mod;
  if (mod.startsWith('@')) return mod.split('/').slice(0, 2).join('/');
  return mod.split('/')[0];
}

/** Dependency names already declared in manifests/lockfiles (the installer's own record, not the agent's claim). */
export function manifestNames(ws: DepWorkspace): { py: Set<string>; js: Set<string> } {
  const py = new Set<string>();
  const js = new Set<string>();
  const req = ws.read('requirements.txt') ?? '';
  for (const l of req.split(/\r?\n/)) {
    const m = l.trim().match(/^([A-Za-z0-9_.-]+)/);
    if (m && !l.trim().startsWith('#')) py.add(normPy(m[1]));
  }
  for (const f of ['pyproject.toml', 'setup.cfg', 'Pipfile']) {
    const t = ws.read(f) ?? '';
    for (const m of t.matchAll(/^[ \t]*["']?([A-Za-z0-9_.-]{2,})["']?\s*[=<>!~ ]/gm)) py.add(normPy(m[1]));
    for (const m of t.matchAll(/^\s*dependencies\s*=\s*\[([^\]]*)\]/gms)) {
      for (const d of m[1].matchAll(/["']([A-Za-z0-9_.-]+)/g)) py.add(normPy(d[1]));
    }
  }
  try {
    const pkg = JSON.parse(ws.read('package.json') ?? '{}');
    for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies, ...pkg.optionalDependencies })) js.add(dep);
  } catch {
    /* no/invalid package.json */
  }
  const lock = ws.read('package-lock.json') ?? ws.read('poetry.lock') ?? '';
  for (const m of lock.matchAll(/"name":\s*"([^"]+)"/g)) js.add(m[1]);
  for (const m of lock.matchAll(/^name = "([^"]+)"/gm)) py.add(normPy(m[1]));
  return { py, js };
}
const normPy = (s: string) => s.toLowerCase().replace(/[_.]/g, '-');

/**
 * Names newly introduced in `proposed` (not in `original`) that have no anchor: not stdlib, not a
 * local module, not declared in a manifest/lockfile, not installed, and not already present
 * verbatim anywhere in `userText` (so a name the user themselves asked for is never held).
 */
export function unanchoredDependencies(rel: string, original: string, proposed: string, ws: DepWorkspace, userText: string): DependencyIssue[] {
  const ecosystem: 'py' | 'js' | undefined = /\.pyi?$/.test(rel) ? 'py' : /\.[cm]?[jt]sx?$/.test(rel) ? 'js' : undefined;
  if (!ecosystem) return [];
  const manifest = manifestNames(ws);
  const out: DependencyIssue[] = [];
  const seen = new Set<string>();
  const before = new Set(extractImports(original, ecosystem));
  const lines = proposed.split(/\r?\n/);
  for (const imp of extractImportsWithLine(proposed, ecosystem)) {
    if (before.has(imp.module)) continue; // not newly introduced by this edit
    const top = topLevel(imp.module, ecosystem);
    if (seen.has(top)) continue;
    const stdlib = ecosystem === 'py' ? PY_STDLIB : JS_BUILTIN;
    if (stdlib.has(top) || imp.module.startsWith('.')) continue; // builtin or local-relative: not this guard's job
    if ((ecosystem === 'py' ? manifest.py.has(normPy(top)) : manifest.js.has(top))) continue;
    if (ws.installed(top, ecosystem)) continue;
    if (new RegExp(`(?<![\\w-])${top.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`).test(userText)) continue; // the user asked for it by name
    seen.add(top);
    out.push({ name: top, ecosystem, line: imp.line, reason: `not a builtin, not declared in a manifest/lockfile, not installed, and not named in the user's own request` });
  }
  return out;
}

function extractImports(text: string, ecosystem: 'py' | 'js'): string[] {
  return extractImportsWithLine(text, ecosystem).map((i) => i.module);
}
function extractImportsWithLine(text: string, ecosystem: 'py' | 'js'): { module: string; line: number }[] {
  const out: { module: string; line: number }[] = [];
  const lines = text.split(/\r?\n/);
  if (ecosystem === 'py') {
    lines.forEach((l, i) => {
      const m1 = l.match(/^\s*import\s+([\w.]+)/);
      const m2 = l.match(/^\s*from\s+([\w.]+)\s+import/);
      if (m1) out.push({ module: m1[1], line: i + 1 });
      if (m2) out.push({ module: m2[1], line: i + 1 });
    });
  } else {
    lines.forEach((l, i) => {
      for (const m of l.matchAll(/\brequire\(\s*["']([^"'./][^"']*)["']\s*\)/g)) out.push({ module: m[1], line: i + 1 });
      for (const m of l.matchAll(/\bfrom\s+["']([^"'./][^"']*)["']/g)) out.push({ module: m[1], line: i + 1 });
      for (const m of l.matchAll(/\bimport\s*\(\s*["']([^"'./][^"']*)["']\s*\)/g)) out.push({ module: m[1], line: i + 1 });
    });
  }
  return out;
}

/** Workspace view backed by the real disk: for locating manifests and probing installed packages. */
export function diskDepWorkspace(root: string): DepWorkspace {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('node:fs') as typeof import('node:fs');
  const p = require('node:path') as typeof import('node:path');
  const read = (rel: string) => {
    try {
      return fs.readFileSync(p.join(root, rel), 'utf8');
    } catch {
      return undefined;
    }
  };
  const venvSitePackages: string[] = [];
  for (const venv of ['.venv', 'venv', 'env']) {
    const libDir = p.join(root, venv, process.platform === 'win32' ? 'Lib' : 'lib');
    try {
      if (process.platform === 'win32') venvSitePackages.push(p.join(libDir, 'site-packages'));
      else for (const d of fs.readdirSync(libDir)) venvSitePackages.push(p.join(libDir, d, 'site-packages'));
    } catch {
      /* no venv */
    }
  }
  return {
    read,
    installed: (name, ecosystem) => {
      if (ecosystem === 'js') {
        try {
          return fs.existsSync(p.join(root, 'node_modules', name));
        } catch {
          return false;
        }
      }
      for (const sp of venvSitePackages) {
        try {
          if (fs.existsSync(p.join(sp, name)) || fs.existsSync(p.join(sp, name.replace(/-/g, '_')))) return true;
          for (const entry of fs.readdirSync(sp)) {
            if (entry.toLowerCase().startsWith(normPy(name).replace(/-/g, '_')) && /\.dist-info$|\.egg-info$/.test(entry)) return true;
          }
        } catch {
          /* sp missing */
        }
      }
      return false;
    },
  };
}

export function dependencyHoldMessage(rel: string, issues: DependencyIssue[]): string {
  const lines = issues.map((i) => `- "${i.name}" (line ${i.line}): ${i.reason}`);
  return [
    `Anvil's dependency guard held this edit to ${rel} because it introduces new package name(s) with no anchor in this workspace:`,
    ...lines,
    `If this is a real package, install it first (so it is anchored), or add it to the manifest, then re-issue the same edit. If the name is wrong, use the correct package name. Never add a package based only on guessing its name.`,
  ].join('\n');
}
