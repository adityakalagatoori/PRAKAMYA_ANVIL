# Anvil: write-up (TrueFoundry Forge-a-thon, Round 1)

> Fill in the remaining **[TODO]**s (team, video timestamps), then export to a 1 to 3 page PDF.

## 1. Team
**[TODO]** Names · college or employer · GitHub handles.

## 2. Starting point
Built **from scratch**. There is no upstream fork. Libraries: `@truefoundry/trueforge-sdk` 0.184.1 (MIT), `@modelcontextprotocol/sdk` 1.32.2 (MIT), `diff` (BSD-3-Clause) and `zod` (MIT). The diff UI is VS Code's native diff editor with CodeLens, so no diff viewer was rebuilt.

## 3. Architecture on TrueForge
- **Client of a TrueForge agent.** The extension upserts two agent definitions (`agents/anvil-coder.json` and `agents/anvil-inline.json`, one copy per configured model). It creates sessions with `sessions.create`, sends turns with `sessions.createTurnStream` (SSE), and cancels with `sessions.cancel`. It never calls a model provider.
- **Editor capabilities as MCP tools.** TrueForge only supports remote MCP, so the extension hosts a streamable-HTTP MCP server on `127.0.0.1` behind a per-install token header, and registers it with TrueForge. The tools are `retrieve_context`, `search_code`, `find_symbol`, `read_file`, `list_files`, `repo_map`, `get_diagnostics`, `edit_file`, `create_file` and `run_command`. The agent decides what to read and change.
- **Approval drives review.** `edit_file`, `create_file` and `run_command` are gated by `require_approval_for_tools`. A `tool.approval_required` event makes Anvil compute the proposed file in memory and open a per-hunk review in the diff editor. Anvil then answers with `user.tool_approval` set to `allow`, or to `deny` with a reason the model sees. An accepted hunk is applied as one `WorkspaceEdit`, saved, and pushed onto an undo stack. There is no write path without review: if a write call ever arrives without an approval-time review, the MCP handler opens the review itself.
- **Harness features:**
  - *Dynamic sub-agents*, for repository exploration on multi-file tasks (`create_sub_agent` "explorer" in the live Task B run). They appear as threads in the session and as cards in the panel.
  - *Deferred tool loading*: `preload:false` with the eight core tools preloaded. `repo_map` and `get_diagnostics` are reached through `list_tools`/`get_tool_info`/`call_tool`, and Anvil unwraps `call_tool` approvals. The live Task B session shows the agent using `list_tools` and `get_tool_info`.
  - *Compaction*, with an explicit 60k-token trigger, surfaced in the panel.
  - *Large-tool-response* offload.
- **Resilience.** TrueForge has no model fallback, so Anvil adds it. A `turn.done{status:error}` or a transport failure is classified. Transient errors (5xx, timeouts, connection refused) are retried after 1 s and then 3 s. Auth and config errors skip retries. Anvil then opens a fresh session on the next model's agent with the same input. If edits were already applied in this run, the new session is told which files changed. **Rate limits** are handled separately: Anvil honours the provider's "retry in Xs", otherwise escalates waits 15/30/60 s, does not count them as failures, and **resumes the same TrueForge session**. Daily-quota errors fall back to the next model immediately. Verified live in VS Code: a primary at `127.0.0.1:59999` (`ECONNREFUSED`) is retried 1 s/3 s, falls back automatically and the edit lands; with no fallback, a clear error appears in about 4 s, the file is untouched and `git status` is clean.
- **Cancellation.** Stop aborts the SSE stream, calls `sessions.cancel`, kills running commands (the whole process tree), closes open reviews, and makes the MCP write handlers refuse further writes. Pending hunks are never applied, and each accepted hunk is atomic, so there is never a half-applied edit. A notification offers "Revert this run".

**Security** (details in SECURITY.md). We grouped the published vulnerabilities in AI coding tools into 13 classes and built a tested control for each:
- Copilot CVE-2025-53773, Cursor CurXecute/MCPoison, Roo CVE-2025-53097, MCP Inspector CVE-2025-49596, the Rules File Backdoor, GlassWorm, and the Amazon Q wiper prompt.
- Controls: a protected-path policy with modal confirmation; secret blocking and redaction; hidden-Unicode reveal; a Host/Origin-checked token server; risk-rated commands; workspace trust; a loop guard; an audit log.
- Our own dependencies are exact-pinned and audited to 0 vulnerabilities, which meant upgrading zod (GHSA-mrhx-c7xc-m3w5, high), diff and esbuild.

**Tests.** 40 unit tests (`npm test`), including attack simulations over HTTP; 10 VS Code integration tests, including live Task A (on Gemini flash-lite and local `qwen2.5:7b`) and live Task C; and a headless live e2e harness (real TrueForge and a real model) used for Task B.

## 4. How context is selected
**Index.** On activation Anvil indexes the workspace and keeps the index updated with a file watcher. Flask (200 files, about 1,670 chunks) indexes in under 0.3 s. Chunks are definition-level: a Python function, class or method with its decorators attached; a docs section; or a 60-line window for other files. A symbol table and an import graph are built alongside.

**Pack, per request, under a budget** (`anvil.contextBudgetTokens`, default 6,000 tokens):
1. `@file` and `@symbol` mentions, capped at 40% of the budget.
2. BM25 over chunks, with identifier-aware tokenisation (snake_case and camelCase splitting, light stemming) and boosts for path and symbol-name hits.
3. **Structural expansion**: for the top 3 source files, add their test file (`tests/test_<stem>.py`) and their docs page. A change rarely lives in one file.
4. Diversity: at most 2 chunks per file in the first pass, then a greedy fill by score.
5. Files left out for budget are listed by path as candidates.
6. A repository map of the touched directories, capped at 1,200 tokens.

Every item carries a *reason*. The panel's **Context card** shows file, line range, tokens and why it was chosen, plus a budget bar. During the run the agent pulls more with `retrieve_context`, which returns the same reasoned list. **Measured on Task B's exact instruction:** the pack includes `src/flask/cli.py`, `tests/test_cli.py` and `docs/cli.rst`, at 5,855 of 6,000 tokens. This is checked by an automated test. In the live Task B run (Gemini 3.5-flash-lite, no files named) the agent changed `cli.py` (`config` command in `FlaskGroup`), `test_cli.py` (new test), `docs/cli.rst` (new "Show Configuration" section) and `src/flask/json/provider.py` (timedelta serialization). `pytest tests/test_cli.py`: 59 passed (58 + 1 new); `flask --help` lists `config  Show the app configuration.`; `flask config` prints `SECRET_KEY`, `DB_PASSWORD`, `API_TOKEN` and `STRIPE_KEY` as `***`.

Trade-offs: lexical retrieval needs no embedding model or server, which keeps it in scope and model-agnostic. It is deterministic and explainable. It misses pure synonyms, which the agent compensates for with `search_code` and sub-agent exploration.

## 5. Model setup
Every model is configured in TrueForge, never in the extension. Anvil only refers to models by TrueForge id.

| Role | Model | Where | Cost |
|---|---|---|---|
| Demo primary | `gemini-3.5-flash` / `gemini-3.8-flash` | Google AI Studio free tier, TrueForge provider type `google-gemini` (also registered via Gemini's OpenAI-compatible endpoint `https://generativelanguage.googleapis.com/v1beta/openai` as a `custom` provider) | $0 |
| Demo fallback | `gemini-3.1-flash-lite` (also `gemini-3.5-flash-lite`, used for the live Task B run) | Google AI Studio free tier | $0 |
| Local | `qwen2.5:7b-instruct` (Task A and C verified live), plus `qwen3:4b`, `qwen2.5-coder:7b`, `qwen2.5:1.5b-instruct` for development | Ollama on a laptop RTX 4050 (6 GB), registered as TrueForge provider `ollama` | $0 |
| Task C | `broken/dead-model` (custom provider at `127.0.0.1:59999`, connection refused) | n/a | $0 |

**Total model cost: $0** (free tiers plus local GPU).

**Switching models.** Set `anvil.models` in VS Code settings to a priority list: the first entry is primary and the rest are automatic fallbacks. Per-model parameters go in `anvil.modelParams` (for example `{"google-gemini/gemini-3.5-flash": {"reasoning_effort": "low"}}`). Providers are added in the TrueForge UI or with `scripts/register-providers.mjs`, which reads keys from env vars.

**What we learned running free and local models through TrueForge.** Each finding produced a product change, and each is unit-tested.
- TrueForge streams an empty base `model.message` followed by deltas. Anvil **rebuilds tool calls from the streamed deltas**.
- Gemini's free tier allows about 5 requests/min and 20 requests/day per flash model, and we hit both live. This produced the rate-limit handling above (honour "retry in Xs", 15/30/60 s escalation, same-session resume) and immediate fallback on daily-quota errors.
- Models sometimes ended a change request without attempting a write. Anvil **auto-continues** once in that case.
- `run_command` **auto-activates the workspace `.venv`**, so agent-run `pytest` and `flask` use the project's interpreter.
- Ollama's default 4K context silently truncated the agent prompt. We documented `OLLAMA_CONTEXT_LENGTH=16384` with flash attention and a q8 KV cache, so the model fits fully in 6 GB of VRAM.
- `qwen2.5-coder` under Ollama prints tool calls as JSON text instead of making function calls, which silently ends the loop. Anvil now **detects text tool calls and nudges** the model to use real function calling (unit-tested).
- Reasoning models (qwen3) can think for minutes before their first tool call. `anvil.modelParams` lets a user turn reasoning down per model. The panel streams reasoning tokens in a collapsible *Thinking* card, so the user sees progress instead of a frozen UI. A *Changes in this run* card and live token usage complete the panel.
- A cold model load caused `Headers Timeout` errors. Anvil's retry-with-backoff recovered automatically in a live run. The start scripts also raise TrueForge's model timeouts.

**Note:** Use the native `google-gemini` provider type for Gemini 3 models: through Gemini's OpenAI-compatible endpoint, multi-step tool calls fail with HTTP 400 because Gemini 3 thought signatures are not round-tripped.

## 6. Scorecard
| Criterion | Video timestamp | Claim |
|---|---|---|
| A1 Inline edit | [TODO] | Diff streams into the editor; per-hunk accept and reject via CodeLens |
| A2 Agent mode | [TODO] | Task B changes cli.py, test_cli.py and docs/cli.rst (4 files in the verified run), none named by the user; 59 tests pass |
| A3 Streaming and cancellation | [TODO] | Tokens stream live; Stop is immediate, discards pending hunks and leaves `git status` clean |
| B1 Context assembly | [TODO] | Context card shows each chosen file, why, and tokens against the budget; `retrieve_context` calls are visible |
| B2 Diff safety | [TODO] | Per-hunk review, including rejecting an unrelated `conftest.py` edit; undo of an applied hunk shown on screen |
| B3 Resilience | [TODO] | Unreachable primary leads to automatic fallback with no user action; `git status` clean |
| B4 TrueForge depth | [TODO] | MCP tools; approval drives review; sub-agents, deferred loading and compaction visible in the session |
| C1 Video | n/a | A, B and C in order, each verified on screen |

## 7. Tools used
VS Code; Node.js 24; TypeScript and esbuild; TrueForge 0.184.x; Claude Code (an AI coding assistant) for planning, implementation and tests. Google AI Studio (free Gemini keys); Ollama (local models); Python 3 and pytest 8.4.2 for Flask's tests; `npm audit`.

## 8. Known limitations and what we would do with another month
- Retrieval is lexical only. Next: add a local embedding re-ranker (still model-agnostic) and call-graph expansion beyond imports.
- The MCP server is stateless and assumes one active run per VS Code window.
- Fallback restarts the request on the next model rather than replaying the failed session's tool history.
- `run_command` output is capped at 8 KB per call, with large outputs left to TrueForge's offload.
- Inline edit replaces whole selected lines. Multi-cursor and notebook cells are not supported.
- **Free-tier quotas are tight** (about 5 requests/min and 20 requests/day per Gemini flash model). One Task B run can consume a large share of a model's daily quota. Anvil waits out per-minute limits and falls back on daily ones, but a long session can exhaust every configured free model.
- **Weaker models sometimes edit unrelated files**, such as test infrastructure (`conftest.py`). Per-hunk review is the control; the demo shows rejecting those hunks.
- With a local 7B model (`qwen2.5:7b-instruct`, 16K context, 6 GB GPU), Task A and Task C complete end to end and are verified live in VS Code. **Task B does not complete reliably on 7B**: the model explores, uses retrieval, and even spawns a sub-agent, but then narrates instead of editing, even after Anvil's auto-continue. Task B needs a stronger hosted model. Every Anvil mechanism (retrieval, sub-agent, nudges, approval gating) behaves correctly either way.
