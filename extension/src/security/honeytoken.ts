import { createHmac, randomBytes } from 'node:crypto';

/**
 * Redaction-minted honeytokens.
 *
 * Instead of an inert "[REDACTED]" placeholder, every credential that would reach the model is
 * replaced by a unique, format-preserving decoy (same prefix, length and alphabet: an AWS key
 * still looks like AKIA…, a Stripe key still starts sk_live_). A vault outside the model maps
 * decoy → real secret. Consequences:
 *  - The model (and any prompt injection steering it) cannot tell decoys from real secrets, so an
 *    exfiltration attempt *necessarily* carries a decoy: every sink (command line, file write,
 *    tool argument) is scanned for decoys, including base64 / hex / URL-encoded / split forms,
 *    and a hit is blocked and attributed to the exact secret it stands for.
 *  - Legitimate edits keep working: when the agent edits a file that already contains the real
 *    secret (e.g. it quotes a config line in old_string), decoys are rehydrated to the real value
 *    outside the model, but only into that same file. Copying a secret anywhere else is blocked.
 * Pure (no vscode).
 */

export interface SecretKind {
  label: string;
  re: RegExp;
  /** Builds a decoy for a matched secret. */
  decoy: (m: string, rnd: (alphabet: string, n: number) => string) => string;
}

const UP = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const LO = 'abcdefghijklmnopqrstuvwxyz';
const DIG = '0123456789';
const ALNUM = UP + LO + DIG;
const B64URL = ALNUM + '-_';
const B64 = ALNUM + '+/';

/** Keeps `prefix`, regenerates the rest from `alphabet` with the same length. */
const keep = (prefixRe: RegExp, alphabet: string) => (m: string, rnd: (a: string, n: number) => string) => {
  const p = (m.match(prefixRe) ?? [''])[0];
  return p + rnd(alphabet, m.length - p.length);
};

export const SECRET_KINDS: SecretKind[] = [
  {
    label: 'private-key',
    re: /-----BEGIN ([A-Z ]*)PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    decoy: (m, rnd) => {
      const kind = m.match(/BEGIN ([A-Z ]*)PRIVATE KEY/)![1];
      const body = m.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
      const fresh = rnd(B64, Math.max(64, body.length)).match(/.{1,64}/g)!.join('\n');
      return `-----BEGIN ${kind}PRIVATE KEY-----\n${fresh}\n-----END ${kind}PRIVATE KEY-----`;
    },
  },
  { label: 'aws-access-key-id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, decoy: keep(/^(AKIA|ASIA)/, UP + DIG) },
  { label: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g, decoy: keep(/^gh[pousr]_/, ALNUM) },
  { label: 'github-token', re: /\bgithub_pat_[A-Za-z0-9_]{60,255}\b/g, decoy: keep(/^github_pat_/, ALNUM + '_') },
  { label: 'gitlab-token', re: /\bglpat-[A-Za-z0-9_-]{20,}\b/g, decoy: keep(/^glpat-/, ALNUM + '_-') },
  { label: 'api-key', re: /\bsk-(?:proj-|ant-(?:api\d\d-)?)?[A-Za-z0-9_-]{20,}\b/g, decoy: keep(/^sk-(?:proj-|ant-(?:api\d\d-)?)?/, ALNUM) },
  { label: 'groq-key', re: /\bgsk_[A-Za-z0-9]{40,}\b/g, decoy: keep(/^gsk_/, ALNUM) },
  { label: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g, decoy: keep(/^AIza/, ALNUM + '_-') },
  { label: 'slack-token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, decoy: keep(/^xox[abposr]-/, ALNUM) },
  { label: 'stripe-key', re: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/g, decoy: keep(/^(?:sk|rk)_live_/, ALNUM) },
  { label: 'npm-token', re: /\bnpm_[A-Za-z0-9]{36}\b/g, decoy: keep(/^npm_/, ALNUM) },
  {
    label: 'jwt',
    re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    decoy: (m, rnd) => m.split('.').map((part, i) => (i < 2 ? 'eyJ' + rnd(B64URL, part.length - 3) : rnd(B64URL, part.length))).join('.'),
  },
  {
    label: 'connection-string-credentials',
    re: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:/@]+:[^\s@/]+@/gi,
    decoy: (m, rnd) => m.replace(/:([^\s:/@]+)@$/, (_x, pw: string) => ':' + rnd(ALNUM, Math.max(12, pw.length)) + '@'),
  },
];

export interface VaultEntry {
  decoy: string;
  real: string;
  label: string;
  firstSeen: number;
}

export interface DecoyHit {
  entry: VaultEntry;
  /** How the decoy appeared in the sink. */
  encoding: 'plain' | 'base64' | 'hex' | 'url' | 'split';
}

export class HoneyVault {
  private byDecoy = new Map<string, VaultEntry>();
  private byReal = new Map<string, VaultEntry>();
  private key: Buffer;
  /** Called when a new decoy is minted (used to persist the decoy list). */
  onMint?: () => void;

  constructor(key?: Buffer) {
    this.key = key ?? randomBytes(32);
  }

  /**
   * Installs a persistent key (kept in the editor's secret storage), so the same secret maps to the
   * same decoy across editor restarts and resumed agent sessions.
   */
  setKey(key: Buffer) {
    this.key = key;
  }

  /** Decoys only (never the real values): persisted so sinks still recognise them after a restart. */
  exportDecoys(): { decoy: string; label: string }[] {
    return [...this.byDecoy.values()].map((e) => ({ decoy: e.decoy, label: e.label }));
  }

  /** Re-registers persisted decoys; their real value is recovered on demand (see rehydrateFor). */
  importDecoys(list: { decoy: string; label: string }[]) {
    for (const d of list ?? []) {
      if (d?.decoy && !this.byDecoy.has(d.decoy)) this.byDecoy.set(d.decoy, { decoy: d.decoy, real: '', label: d.label, firstSeen: 0 });
    }
  }

  get size() {
    return this.byDecoy.size;
  }

  entries(): VaultEntry[] {
    return [...this.byDecoy.values()];
  }

  isDecoy(s: string) {
    return this.byDecoy.has(s);
  }

  /** Deterministic per secret (the same secret always maps to the same decoy within a session). */
  private mint(real: string, kind: SecretKind): string {
    let counter = 0;
    const stream = (n: number): Buffer => {
      const out: Buffer[] = [];
      let len = 0;
      while (len < n) {
        const b = createHmac('sha256', this.key).update(`${kind.label}\u0000${real}\u0000${counter++}`).digest();
        out.push(b);
        len += b.length;
      }
      return Buffer.concat(out);
    };
    for (let attempt = 0; attempt < 5; attempt++) {
      const bytes = stream(4096);
      let i = 0;
      const rnd = (alphabet: string, n: number) => {
        let s = '';
        for (let k = 0; k < n; k++) s += alphabet[bytes[i++ % bytes.length] % alphabet.length];
        return s;
      };
      const d = kind.decoy(real, rnd);
      if (d !== real && !this.byReal.has(d)) return d;
    }
    return kind.decoy(real, (a, n) => a[0].repeat(n));
  }

  /**
   * Replaces every credential in `text` with its decoy. Decoys already present (e.g. the model's
   * own command echoed back in tool output) are left as they are.
   */
  substitute(text: string): { text: string; count: number; labels: string[] } {
    let count = 0;
    const labels: string[] = [];
    let out = text;
    for (const kind of SECRET_KINDS) {
      out = out.replace(kind.re, (m) => {
        if (this.byDecoy.has(m)) return m;
        if (kind.label === 'connection-string-credentials') {
          const pw = m.match(/:([^\s:/@]+)@$/)?.[1];
          if (pw && this.byDecoy.has(pw)) return m;
        }
        let e = this.byReal.get(m);
        if (!e) {
          const decoy = this.mint(m, kind);
          e = { decoy, real: m, label: kind.label, firstSeen: Date.now() };
          this.byReal.set(m, e);
          this.byDecoy.set(decoy, e);
          this.onMint?.();
          // Connection strings: the password part alone is also a decoy token.
          if (kind.label === 'connection-string-credentials') {
            const realPw = m.match(/:([^\s:/@]+)@$/)?.[1];
            const decoyPw = decoy.match(/:([^\s:/@]+)@$/)?.[1];
            if (realPw && decoyPw) this.byDecoy.set(decoyPw, { ...e, decoy: decoyPw, real: realPw });
          }
        }
        count++;
        labels.push(kind.label);
        return e.decoy;
      });
    }
    return { text: out, count, labels };
  }

  /** Finds decoys in a sink payload: plain, base64, hex, URL-encoded, or split by quotes/whitespace/concatenation. */
  scan(payload: string): DecoyHit[] {
    if (!this.byDecoy.size || !payload) return [];
    const hits = new Map<string, DecoyHit>();
    const add = (e: VaultEntry, encoding: DecoyHit['encoding']) => {
      if (!hits.has(e.decoy)) hits.set(e.decoy, { entry: e, encoding });
    };
    const views: [string, DecoyHit['encoding']][] = [[payload, 'plain']];
    try {
      const u = decodeURIComponent(payload.replace(/\+/g, ' '));
      if (u !== payload) views.push([u, 'url']);
    } catch {
      /* not URL-encoded */
    }
    const b64Tokens = new Set<string>();
    for (const m of payload.matchAll(/[A-Za-z0-9+/_-]{16,}={0,2}/g)) {
      b64Tokens.add(m[0]);
      // "/" is both a base64 character and a URL path separator: also try each path segment.
      for (const seg of m[0].split('/')) if (seg.length >= 16) b64Tokens.add(seg);
    }
    for (const tok of b64Tokens) {
      try {
        const b = Buffer.from(tok.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
        if (/^[\x20-\x7e\s]+$/.test(b) && b.length >= 8) views.push([b, 'base64']);
      } catch {
        /* not base64 */
      }
    }
    for (const m of payload.matchAll(/[0-9a-fA-F]{16,}/g)) {
      const tok = m[0].length % 2 ? m[0].slice(0, -1) : m[0];
      const h = Buffer.from(tok, 'hex').toString('utf8');
      if (/^[\x20-\x7e\s]+$/.test(h)) views.push([h, 'hex']);
    }
    const squashed = payload.replace(/["'`\s+.,;:()\[\]{}|&\\^]/g, '');
    for (const e of this.byDecoy.values()) {
      for (const [v, enc] of views) if (v.includes(e.decoy)) add(e, enc);
      if (!hits.has(e.decoy) && e.decoy.length >= 12) {
        const sq = e.decoy.replace(/["'`\s+.,;:()\[\]{}|&\\^]/g, '');
        if (sq.length >= 12 && squashed.includes(sq)) add(e, 'split');
      }
    }
    // A connection-string decoy also contains its password decoy: report the outer one only.
    return [...hits.values()].filter((h) => ![...hits.values()].some((o) => o !== h && o.entry.decoy.length > h.entry.decoy.length && o.entry.decoy.includes(h.entry.decoy)));
  }

  /**
   * Rehydrates decoys in text destined for `targetCurrent` (the target file's current content):
   * a decoy becomes its real value only if that real value already lives in the target file.
   * Returns the text plus any decoys that would have carried a secret somewhere new.
   */
  rehydrateFor(text: string, targetCurrent: string): { text: string; rehydrated: number; foreign: VaultEntry[] } {
    // Register the target's own secrets first: with a persistent key this recovers the real value of
    // decoys minted in an earlier editor session (they map deterministically).
    if (this.byDecoy.size) this.substitute(targetCurrent);
    let out = text;
    let rehydrated = 0;
    const foreign: VaultEntry[] = [];
    // Longest first so a connection-string decoy wins over its embedded password decoy.
    const entries = [...this.byDecoy.values()].sort((a, b) => b.decoy.length - a.decoy.length);
    for (const e of entries) {
      if (!out.includes(e.decoy)) continue;
      if (e.real && targetCurrent.includes(e.real)) {
        out = out.split(e.decoy).join(e.real);
        rehydrated++;
      } else foreign.push(e);
    }
    return { text: out, rehydrated, foreign };
  }
}

/** One vault per extension host session (decoys must stay consistent across tool calls). */
export const vault = new HoneyVault();

export function describeHit(h: DecoyHit): string {
  const how = h.encoding === 'plain' ? '' : ` (${h.encoding}-encoded)`;
  return `${h.entry.label} credential${how}`;
}
