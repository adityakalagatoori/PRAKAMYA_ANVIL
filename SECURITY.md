# Anvil security model

An AI coding agent reads untrusted text (repository files, issues, tool output) and can write files and run commands. Every major AI coding tool has shipped vulnerabilities from that combination. We studied those incidents, grouped them into classes, and built a specific, tested control for each class. The controls are covered by Anvil's 40 unit tests (`npm test`), which include attack simulations against the live MCP server over HTTP.

## Threat classes and controls

| # | Class | Real incidents | Anvil control | Proven by |
|---|---|---|---|---|
| 1 | **Config tampering leading to code execution.** The agent edits IDE or CI config to grant itself power. | GitHub Copilot **CVE-2025-53773**: the agent wrote `chat.tools.autoApprove` into `.vscode/settings.json`, enabling "YOLO mode". Cursor **CVE-2025-54135** (CurXecute) and **CVE-2025-54136** (MCPoison). IDEsaster's `php.validate.executablePath` trick. Roo Code `.clinerules` execution. | **Protected-path policy.** `.git/` and secret files are *blocked*. `.vscode/`, `*.code-workspace`, CI workflows, devcontainers, git-hook managers, agent rules files (`.cursorrules`, `.clinerules`, `AGENTS.md`…), shell profiles, `.npmrc` and scripts are *sensitive*: the diff shows a ⚠ banner, and the first Accept needs a separate **modal confirmation**. Anvil has no auto-approve mode for the agent to switch on. Anvil's own connection settings are `machine`-scoped, so a cloned repo's `.vscode/settings.json` cannot redirect them. | `security.test.ts` › paths; `policy.classifyPath` |
| 2 | **Data exfiltration side channels.** | Cline renders markdown images from attacker URLs. Cursor **CVE-2025-54132** (Mermaid image exfiltration). Roo Code **CVE-2025-53097** and IDEsaster: writing a remote JSON `$schema` makes the IDE fetch it. Cline DNS exfiltration through `ping`. | The panel renders **text only** (`textContent`, no markdown or HTML). The webview CSP is `default-src 'none'; img-src 'none'; connect-src 'none'` with nonce scripts. Edits that add remote `$schema`/`$ref` URLs, or URLs in config files, are flagged and need confirmation. Network commands are flagged in the approval UI. The webview can only open the TrueForge origin. | `security.test.ts` › edits, commands |
| 3 | **Secrets reaching the model or attacker** | Cline exposing `.env` files. API keys in agent shell environments. | Secret files (`.env*`, keys, `id_rsa`, `.aws/`, `.ssh/`, `*.tfstate`, service accounts…) are **never indexed, read or written**. Every tool result and context pack passes through `sanitizeForModel`, which **redacts credentials** (AWS, GitHub, GitLab, OpenAI/Anthropic, Google, Slack, Stripe, npm, JWT, private keys, DB URLs). Agent-run commands get an environment **with credential variables removed** (opt-in `anvil.passSecretsToCommands`). | `security.test.ts` › secrets, redaction, env; `mcp.test.ts` › security |
| 4 | **Hidden instructions and invisible code** | Pillar Security "Rules File Backdoor" (Copilot, Cursor). Trojan Source **CVE-2021-42574**. **GlassWorm** variation-selector malware. ASCII smuggling with Unicode tag characters. | Hidden characters (zero-width, bidi, variation selectors, tag characters) are **made visible** (`⟦U+202E⟧`) in everything the model reads, with a note to treat what they hide as untrusted. Edits that *add* hidden characters are flagged and need confirmation. Commands containing them are rated high risk. | `security.test.ts` › hidden unicode; `mcp.test.ts` › security |
| 5 | **Local server attacks** | MCP Inspector **CVE-2025-49596** (CVSS 9.4): an unauthenticated localhost server reachable via CSRF or DNS rebinding. **CVE-2025-54994** (same pattern). | Anvil's MCP server binds to **127.0.0.1 only**. Every request needs a 256-bit token, compared in **constant time** and stored in the OS keychain through VS Code **SecretStorage**. **Host header allow-list** (blocks DNS rebinding). Any **browser Origin / cross-site** request is refused (blocks CSRF). 4 MB body limit and request timeouts. | `mcp.test.ts` › security (403 for Origin/rebound Host, 401 for wrong token) |
| 6 | **Destructive or excessive agency** | Gemini CLI deleting a user's files. Replit deleting a production database. Amazon Q extension v1.84.0 shipping a **wiper prompt** (supply chain). Cursor deleting about 70 files with `rm -rf`. | No silent writes: **every** write is a per-hunk diff the user accepts. Every accepted hunk is undoable, and **Revert run** undoes a whole run. There is no delete tool. **Every command needs approval**, recorded per run, and the MCP handler refuses unapproved commands. Commands are **risk-rated**: recursive deletes, `git reset --hard/clean/push -f`, pipe-to-shell, base64 payloads, raw sockets, privilege escalation, persistence and publishing are **high** risk and need a modal confirmation listing the reasons. | `security.test.ts` › commands; `runner.test.ts`; integration › undo / revert |
| 7 | **Untrusted workspaces** | VS Code Restricted Mode is the platform's defence against hostile repositories. | `capabilities.untrustedWorkspaces: limited`. In an untrusted workspace Anvil **will not write or run commands**, and its model and endpoint settings are restricted configurations. | `prepareWrite` / `run_command` trust checks |
| 8 | **Unbounded consumption and loops** (OWASP LLM10) | Agents re-reading the same file range indefinitely (Cursor forum, qwen-code #4695); "Diff Edit Failed" retry storms (Cline #1195, #1511). | **Loop guard**: a 4th identical tool call is short-circuited with corrective feedback, plus a per-run budget of 250 calls. TrueForge iteration limit and compaction. When an edit misses, the model gets the **closest matching region with line numbers**, so it fixes the edit in one step. Live **token usage** shows in the panel. | `security.test.ts` › loop guard; `mcp.test.ts`; `diff.test.ts` › closest match |
| 9 | **Path traversal** | IDEsaster lists path traversal among the common AI IDE flaws. | `..` cannot escape the root. Absolute, UNC and drive paths are rejected. NTFS alternate data streams (`file:stream`), Windows device names (`CON`, `NUL`), trailing dot/space aliases and control characters are rejected. A **realpath containment** check stops symlink and junction escapes. | `mcp.test.ts` › security bad paths |
| 10 | **ReDoS from model-supplied regex** | General risk for any tool that runs model-supplied regex in the editor process. | Pattern length cap, nested-quantifier rejection, a 2,000-character line cap and a 3-second search budget. | `security.test.ts` › regex |
| 11 | **Terminal escape injection** | OSC 52 clipboard writes and title or hyperlink spoofing from untrusted command output. | Command output is sanitized before display (only colours survive). The model receives plain text. | `security.test.ts` › terminal |
| 12 | **Supply chain of the extension itself** | GlassWorm. The Amazon Q compromise. | **Exact-pinned** dependencies and a committed lockfile. `npm audit` is **clean**: this work upgraded `zod` (GHSA-mrhx-c7xc-m3w5, high), `diff` (low) and `esbuild` (moderate). No install scripts in Anvil. The bundle contains only what esbuild includes. | `npm audit` → 0 vulnerabilities |
| 13 | **Repudiation** (no record of what the agent did) | OWASP Agentic: traceability. | Append-only **JSONL audit log** of tool calls (large arguments summarised), approvals and denials with risk, applied writes, commands with exit codes, sanitizations, loop blocks, and rejected MCP requests. It's stored in extension storage, not the repo. Command: **Anvil: Open Audit Log**. | `security/audit.ts` |

## OWASP mapping
- **LLM Top 10 (2025):**

  | Entry | Classes |
  |---|---|
  | LLM01 Prompt Injection | 1, 2, 4, 6 |
  | LLM02 Sensitive Information Disclosure | 3 |
  | LLM03 Supply Chain | 12 |
  | LLM05 Improper Output Handling | 2, 11 |
  | LLM06 Excessive Agency | 1, 6, 7 |
  | LLM10 Unbounded Consumption | 8, 10 |

  Not applicable: LLM04 Data and Model Poisoning (no training), LLM07 System Prompt Leakage (the prompts are public in `agents/`), LLM08 Vector and Embedding Weaknesses (no embeddings), LLM09 Misinformation (mitigated by human review of every diff).
- **Agentic (OWASP GenAI Agentic Top 10):**

  | Risk | Classes |
  |---|---|
  | Goal hijacking | 1, 4 |
  | Tool misuse | 6, 8, 10 |
  | Privilege abuse | 3, 7 |
  | Unexpected code execution | 1, 6 |
  | Context poisoning | 4 |
  | Agentic supply chain | 12 |
  | Human-agent trust exploitation | Risk badges and modal confirmations, so approvals are informed |
  | Repudiation | 13 |

## Defence in depth: how a write reaches disk
1. The model calls `edit_file`. TrueForge **pauses for approval** (`require_approval_for_tools`).
2. `prepareWrite` checks workspace trust, path validity, the containment realpath and the protected-path class. Blocked edits are **denied with a reason** before any UI appears.
3. A per-hunk diff opens, with security warnings as CodeLens. Warnings need a **modal confirmation** before the first hunk applies.
4. Each accepted hunk is one atomic, undoable `WorkspaceEdit`, saved and **audited**.
5. Even if step 1 is misconfigured, the MCP handler never writes without its own review, and never runs a command without approval.

## Residual risks (honest limits)
- Command risk rating is **advisory**. No shell analyser catches every obfuscation; Cursor's own advisory calls allow-lists "best-effort". The real control is that *every* command needs approval, and high-risk ones need a modal.
- Redaction is pattern-based. Unusual secret formats in ordinary source files can slip through, which is why secret *files* are blocked outright.
- Approved commands run with the user's OS privileges; there is no sandbox (TrueForge's sandbox is Linux/macOS-only). Use a dev container for hostile repositories.
- Anvil cannot stop a user from accepting a malicious diff. It can only make the risk visible.

## Reporting
Please report vulnerabilities privately to the maintainers (GitHub security advisory on this repository) rather than in a public issue.

## Sources
- GitHub Copilot CVE-2025-53773: [Embrace The Red](https://embracethered.com/blog/posts/2025/github-copilot-remote-code-execution-via-prompt-injection), [Wiz](https://www.wiz.io/vulnerability-database/cve/cve-2025-53773)
- Cline exfiltration and flaws: [Embrace The Red](https://embracethered.com/blog/posts/2025/cline-vulnerable-to-data-exfiltration/), [Cybersecurity News (Mindgard)](https://cybersecuritynews.com/cline-ai-coding-agent-vulnerabilities/), [Mindgard patterns](https://github.com/Mindgard/ai-ide-vuln-patterns)
- Cursor CurXecute and MCPoison: [Tenable FAQ](https://www.tenable.com/blog/faq-cve-2025-54135-cve-2025-54136-vulnerabilities-in-cursor-curxecute-mcpoison), CVE-2025-54131 [NVD](https://nvd.nist.gov/vuln/detail/CVE-2025-54131), [HiddenLayer advisory](https://hiddenlayer.com/sai_security_advisor/2025-11-cursor/), [The Hacker News](https://thehackernews.com/2025/08/cursor-ai-code-editor-fixed-flaw.html)
- IDEsaster (30+ flaws across AI IDEs): [The Hacker News](https://thehackernews.com/2025/12/researchers-uncover-30-flaws-in-ai.html), [Tom's Hardware](https://tomshardware.com/tech-industry/cyber-security/researchers-uncover-critical-ai-ide-flaws-exposing-developers-to-data-theft-and-rce)
- MCP Inspector CVE-2025-49596: [Recorded Future](https://www.recordedfuture.com/blog/anthropic-mcp-inspector-cve-2025-49596), [OSV](https://osv.dev/vulnerability/CVE-2025-49596)
- Rules File Backdoor: [Pillar Security](https://pillar.security/blog/new-vulnerability-in-github-copilot-and-cursor-how-hackers-can-weaponize-code-agents), [The Hacker News](https://thehackernews.com/2025/03/new-rules-file-backdoor-attack-lets.html)
- GlassWorm: [Koi](https://koi.ai/blog/glassworm-first-self-propagating-worm-using-invisible-code-hits-openvsx-marketplace), [BleepingComputer](https://www.bleepingcomputer.com/news/security/self-spreading-glassworm-malware-hits-openvsx-vs-code-registries/)
- Amazon Q wiper prompt: [BleepingComputer](https://bleepingcomputer.com/news/security/amazon-ai-coding-agent-hacked-to-inject-data-wiping-commands), [JFrog](https://research.jfrog.com/post/amazon-q-vs-code-extension-compromised-with-malicious-code/)
- Destructive agent incidents (Gemini CLI, Replit): [Ars Technica via HN reader](https://hn.jakechampion.name/reader/https://arstechnica.com/information-technology/2025/07/ai-coding-assistants-chase-phantoms-destroy-real-user-data), [AI Incident Database](https://incidentdatabase.ai/cite/1152/)
- Prompt injection in AI dev tools survey: [arXiv 2603.21642](https://arxiv.org/html/2603.21642v1), [CSA README injection note](https://labs.cloudsecurityalliance.org/wp-content/uploads/2026/03/CSA_research_note_readme_instruction_injection_ai_coding_agents_20260317-csa-styled.pdf)
- Diff-edit failures: [Cline #1195](https://github.com/cline/cline/issues/1195), [Cline #1511](https://github.com/cline/cline/issues/1511), [Roo Code #4199](https://github.com/RooCodeInc/Roo-Code/issues/4199)
- Agent loops: [Cursor forum](https://forum.cursor.com/t/agent-enters-infinite-loop-re-reading-the-exact-same-file-range-with-auto-mode/170975), [qwen-code #4695](https://github.com/QwenLM/qwen-code/issues/4695)
- OWASP: [Top 10 for LLM Applications 2025 overview](https://www.gravitee.io/blog/owasp-top-10-for-llm-applications-2025-a-practical-guide), [Agentic Top 10](https://www.pointguardai.com/glossary/owasp-top-10-for-agentic-applications)
