# Anvil: write-up (TrueFoundry Forge-a-thon, Round 1)

> DRAFT. Fill in every **[TODO]**, then export to a 1 to 3 page PDF.

## 1. Team
**[TODO]** Names · college or employer · GitHub handles.

## 2. Starting point
Built **from scratch**. There is no upstream fork. Libraries: `@truefoundry/trueforge-sdk` 0.184.1 (MIT), `@modelcontextprotocol/sdk` 1.32.2 (MIT), `diff` (BSD-3-Clause) and `zod` (MIT). The diff UI is VS Code's native diff editor with CodeLens, so no diff viewer was rebuilt.

## 3. Architecture on TrueForge
- **Client of a TrueForge agent.** The extension upserts two agent definitions (`agents/anvil-coder.json` and `agents/anvil-inline.json`, one copy per configured model). It creates sessions with `sessions.create`, sends turns with `sessions.createTurnStream` (SSE), and cancels with `sessions.cancel`. It never calls a model provider.
- **Editor capabilities as MCP tools.** TrueForge only supports remote MCP, so the extension hosts a streamable-HTTP MCP server on `127.0.0.1` behind a per-install token header, and registers it with TrueForge. The tools are `retrieve_context`, `search_code`, `find_symbol`, `read_file`, `list_files`, `repo_map`, `get_diagnostics`, `edit_file`, `create_file` and `run_command`. The agent decides what to read and change.
- **Approval drives review.** `edit_file`, `create_file` and `run_command` are gated by `require_approval_for_tools`. A `tool.approval_required` event makes Anvil compute the proposed file in memory and open a per-hunk review in the diff editor. Anvil then answers with `user.tool_approval` set to `allow`, or to `deny` with a reason the model sees. An accepted hunk is applied as one `WorkspaceEdit`, saved, and pushed onto an undo stack. There is no write path without review: if a write call ever arrives without an approval-time review, the MCP handler opens the review itself.
- **Harness features:**
  - *Dynamic sub-agents*, for repository exploration on multi-file tasks. They appear as threads in the session and as cards in the panel.
  - *Deferred tool loading*: `preload:false` with the eight core tools preloaded. `repo_map` and `get_diagnostics` are reached through `list_tools`/`call_tool`, and Anvil unwraps `call_tool` approvals.
  - *Compaction*, with an explicit 60k-token trigger, surfaced in the panel.
  - *Large-tool-response* offload.
- **Resilience.** TrueForge has no model fallback, so Anvil adds it. A `turn.done{status:error}` or a transport failure is classified. Transient errors (429, 5xx, timeouts, connection refused) are retried after 1 s and then 3 s. Auth and config errors skip retries. Anvil then opens a fresh session on the next model's agent with the same input. If edits were already applied in this run, the new session is told which files changed.
- **Cancellation.** Stop aborts the SSE stream, calls `sessions.cancel`, kills running commands (the whole process tree), closes open reviews, and makes the MCP write handlers refuse further writes. Pending hunks are never applied, and each accepted hunk is atomic, so there is never a half-applied edit. A notification offers "Revert this run".

**Security** (details in SECURITY.md). We grouped the published vulnerabilities in AI coding tools into 13 classes and built a tested control for each:
- Copilot CVE-2025-53773, Cursor CurXecute/MCPoison, Roo CVE-2025-53097, MCP Inspector CVE-2025-49596, the Rules File Backdoor, GlassWorm, and the Amazon Q wiper prompt.
- Controls: a protected-path policy with modal confirmation; secret blocking and redaction; hidden-Unicode reveal; a Host/Origin-checked token server; risk-rated commands; workspace trust; a loop guard; an audit log.
- Our own dependencies were audited to 0 vulnerabilities, which meant upgrading zod (a high-severity advisory).

## 4. How context is selected
**Index.** On activation Anvil indexes the workspace and keeps the index updated with a file watcher. Flask (200 files, about 1,670 chunks) indexes in under 0.3 s. Chunks are definition-level: a Python function, class or method with its decorators attached; a docs section; or a 60-line window for other files. A symbol table and an import graph are built alongside.

**Pack, per request, under a budget** (`anvil.contextBudgetTokens`, default 6,000 tokens):
1. `@file` and `@symbol` mentions, capped at 40% of the budget.
2. BM25 over chunks, with identifier-aware tokenisation (snake_case and camelCase splitting, light stemming) and boosts for path and symbol-name hits.
3. **Structural expansion**: for the top 3 source files, add their test file (`tests/test_<stem>.py`) and their docs page. A change rarely lives in one file.
4. Diversity: at most 2 chunks per file in the first pass, then a greedy fill by score.
5. Files left out for budget are listed by path as candidates.
6. A repository map of the touched directories, capped at 1,200 tokens.

Every item carries a *reason*. The panel's **Context card** shows file, line range, tokens and why it was chosen, plus a budget bar. During the run the agent pulls more with `retrieve_context`, which returns the same reasoned list. **Measured on Task B's exact instruction:** the pack includes `src/flask/cli.py`, `tests/test_cli.py` and `docs/cli.rst`, at 5,855 of 6,000 tokens. This is checked by an automated test.

Trade-offs: lexical retrieval needs no embedding model or server, which keeps it in scope and model-agnostic. It is deterministic and explainable. It misses pure synonyms, which the agent compensates for with `search_code` and sub-agent exploration.

## 5. Model setup
Every model is configured in TrueForge, never in the extension. Anvil only refers to models by TrueForge id.

| Role | Model | Where | Cost |
|---|---|---|---|
| Development and testing | `qwen3:4b`, `qwen2.5-coder:7b`, `qwen2.5:7b-instruct`, `qwen2.5:1.5b-instruct` | Ollama on a laptop RTX 4050 (6 GB), OpenAI-compatible endpoint registered as TrueForge provider `ollama` | $0 |
| Demo primary | **[TODO]** | **[TODO]** | **[TODO]** |
| Demo fallback | **[TODO]** | **[TODO]** | **[TODO]** |
| Task C | `broken/dead-model` (custom provider at `127.0.0.1:9`, which is unreachable) | n/a | $0 |

**Switching models.** Set `anvil.models` in VS Code settings to a priority list: the first entry is primary and the rest are automatic fallbacks. Per-model parameters go in `anvil.modelParams` (for example `{"ollama/qwen3-4b": {"reasoning_effort": "none"}}`). Providers are added in the TrueForge UI or with `scripts/register-providers.mjs`, which reads keys from env vars.

**What we learned running small local models through TrueForge.** Each finding produced a product change.
- Ollama's default 4K context silently truncated the agent prompt. We documented `OLLAMA_CONTEXT_LENGTH=16384` with flash attention and a q8 KV cache, so the model fits fully in 6 GB of VRAM.
- `qwen2.5-coder` under Ollama prints tool calls as JSON text instead of making function calls, which silently ends the loop. Anvil now **detects text tool calls and nudges** the model to use real function calling (unit-tested).
- Reasoning models (qwen3) can think for minutes before their first tool call. `anvil.modelParams` lets a user turn reasoning down per model. The panel streams reasoning tokens in a collapsible *Thinking* card, so the user sees progress instead of a frozen UI.
- A cold model load caused `Headers Timeout` errors. Anvil's retry-with-backoff recovered automatically in a live run. The start scripts also raise TrueForge's model timeouts.

## 6. Scorecard
| Criterion | Video timestamp | Claim |
|---|---|---|
| A1 Inline edit | [TODO] | Diff streams into the editor; per-hunk accept and reject via CodeLens |
| A2 Agent mode | [TODO] | Task B touches cli.py, test_cli.py and docs/cli.rst, none of them named by the user |
| A3 Streaming and cancellation | [TODO] | Tokens stream live; Stop is immediate, discards pending hunks and leaves `git status` clean |
| B1 Context assembly | [TODO] | Context card shows each chosen file, why, and tokens against the budget; `retrieve_context` calls are visible |
| B2 Diff safety | [TODO] | Per-hunk review; undo of an applied hunk shown on screen |
| B3 Resilience | [TODO] | Unreachable primary leads to automatic fallback with no user action; `git status` clean |
| B4 TrueForge depth | [TODO] | MCP tools; approval drives review; sub-agents, deferred loading and compaction visible in the session |
| C1 Video | n/a | A, B and C in order, each verified on screen |

## 7. Tools used
VS Code; Node.js 24; TypeScript and esbuild; TrueForge 0.184.x; Claude Code (an AI coding assistant) for planning, implementation and tests. **[TODO]** Add anything else.

## 8. Known limitations and what we would do with another month
- Retrieval is lexical only. Next: add a local embedding re-ranker (still model-agnostic) and call-graph expansion beyond imports.
- The MCP server is stateless and assumes one active run per VS Code window.
- Fallback restarts the request on the next model rather than replaying the failed session's tool history.
- `run_command` output is capped at 8 KB per call, with large outputs left to TrueForge's offload.
- Inline edit replaces whole selected lines. Multi-cursor and notebook cells are not supported.
- With a local 7B model (`qwen2.5:7b-instruct`, 16K context, 6 GB GPU), Task A and Task C complete end to end and are verified live in VS Code. **Task B does not complete reliably on 7B**: the model explores, uses retrieval, and even spawns a sub-agent, but then narrates instead of editing, even after Anvil's auto-continue. Task B needs a stronger hosted model. Every Anvil mechanism (retrieval, sub-agent, nudges, approval gating) behaves correctly either way.
- **[TODO]** Add anything you observed during recording.
