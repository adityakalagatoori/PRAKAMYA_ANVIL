# Anvil: build plan

Anvil is a VS Code coding agent whose agent loop runs on **TrueForge** (local mode). It was built for the TrueFoundry Forge-a-thon, Round 1.

This file is the working plan. Every build step below maps to a scoring criterion.

---

## 0. Ground truth (verified from `@truefoundry/trueforge-sdk@0.184.1` types and the `@truefoundry/trueforge@0.184.2` bundle)

| Fact | Consequence |
|---|---|
| Server: `npx @truefoundry/trueforge@latest` serves `http://localhost:8790`. Node >= 22.14. UI route for a session is `/sessions/:sessionId`. | Anvil deep-links to the TrueForge session view from the panel, which the Task B video needs. |
| TrueForge only connects to **remote** MCP servers (`type: "remote"`, transport streamable-http or SSE). There is no stdio. | The extension hosts its own **streamable-HTTP MCP server on 127.0.0.1** and registers it with `settings.mcpServers.createOrUpdate`, using header auth (`x-anvil-token`). |
| Outbound URL guard: `NETWORK_POLICY_ENABLED` (default true), `OUTBOUND_URL_ALLOWED_HOSTS`. | Start TrueForge with localhost allowed (see `scripts/start-trueforge.*`). **Risk #1: verify on the first run.** |
| Agent spec: `{ model:{name,params}, instructions, mcpServers:[{name, enableTools, preload, preloadTools, requireApprovalForTools}], config:{dynamicSubAgents, contextManagement:{compaction, largeToolResponse}, iterationLimit} }`. CRUD via `client.agents.*`. | The agent definitions live in `agents/*.json` (a deliverable). The extension upserts them. |
| Turns use `sessions.createTurnStream(id, {input})` and are async-iterable. Events: `model.message.delta`, `model.message` (toolCalls with args), `tool.approval_required` (`toolCalls:[{id}]`), `tool.response`, `thread.created`/`thread.done` (subagents), `thread.context_compaction_*`, `turn.update`, and `turn.done` (`state.status`: done, cancelled, or error). | One event reducer drives both the panel and the inline edit. |
| Approval: the next turn's input is `[{type:"user.tool_approval", threadId, toolCallId, approval:{status:"allow"} | {status:"deny", reason}}]`. | **TrueForge's approval gate drives the diff review.** That is the B4 = 7 anchor. |
| Cancel: `sessions.cancel(sessionId)`. | The Stop button and command call it, abort the local stream, and discard pending reviews. |
| No built-in model fallback. | Anvil adds retry with backoff and then automatic fallback to the next configured model. That is the B3 = 10 anchor. |
| Context features: dynamic subagents (`create_sub_agent`), deferred tool loading (`preload:false` plus the `list_tools`/`call_tool` meta-tools), compaction, large tool responses. | All of them are used. See section 4. |

---

## 1. Architecture

```
┌──────────────────────── VS Code (extension host) ─────────────────────────┐
│  Agent panel (webview)   Inline edit (Ctrl+Alt+K)   Review (diff + CodeLens) │
│          │                       │                         ▲                │
│          ▼                       ▼                         │                │
│     RunController ──── TrueForgeGateway (SDK: sessions, turns, stream,     │
│          │              cancel, retry+fallback, agent upsert)               │
│          │                       │ HTTP + SSE                               │
│   ContextEngine (index, BM25,    ▼                                          │
│   symbols, budgeted packs) ◄── MCP server (127.0.0.1:7337, streamable HTTP) │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │ tool calls
                     ┌─────────────▼──────────────┐       ┌─────────────────┐
                     │ TrueForge (local, :8790)   │──────►│ model provider  │
                     │ loop, sessions, approvals, │       │ (primary, then  │
                     │ subagents, compaction      │       │  fallbacks)     │
                     └────────────────────────────┘       └─────────────────┘
```

The extension never calls a model provider. It only talks to TrueForge, and TrueForge calls back into the extension's MCP tools.

### MCP tools (server name `anvil-editor`)
| Tool | Kind | Approval | Preloaded |
|---|---|---|---|
| `retrieve_context(query, budget_tokens?)` | read | no | yes |
| `search_code(pattern, regex?, glob?, max_results?)` | read | no | yes |
| `find_symbol(name)` | read | no | yes |
| `read_file(path, start_line?, end_line?)` | read | no | yes |
| `list_files(dir?, glob?)` | read | no | yes |
| `repo_map(dir?)` | read | no | deferred |
| `edit_file(path, old_string, new_string)` | write | **yes** | yes |
| `create_file(path, content)` | write | **yes** | yes |
| `run_command(command, timeout_s?)` | exec | **yes** | yes |
| `get_diagnostics(path?)` | read | no | deferred |

Annotations: `readOnlyHint` and `destructiveHint` are set, and approval is also listed by name in the agent spec.

### Approval → review → disk (the safety core)
1. The model calls `edit_file`. TrueForge emits `model.message` (args) and then `tool.approval_required`, and the turn pauses.
2. Anvil computes the proposed file in memory. If `old_string` is not found or is ambiguous, Anvil auto-denies with a reason so the model can re-read. Nothing touches disk.
3. Review UI: a diff editor shows the current file on the left and the proposed version on the right. CodeLens gives each hunk **Accept / Reject**, plus Accept all and Reject all.
4. An accepted hunk is applied atomically with one `WorkspaceEdit`, then saved, and recorded on Anvil's undo stack. Ctrl+Z also works.
5. When every hunk is decided, Anvil sends `allow` (at least one hunk accepted) or `deny` with the reason "user rejected all hunks". The MCP handler then runs and reports exactly which hunks landed. It writes nothing itself.
6. Belt and braces: if a write tool call arrives with no recorded review (for example, approval is misconfigured), the handler opens the review itself and waits. There is no silent write path at all.
7. Cancel: pending reviews close, unreviewed hunks are dropped, and the MCP handlers for a cancelled run refuse to write. A toast offers **Revert this run** to restore every file touched by the run's accepted hunks.

### Resilience (Task C)
- Settings: `anvil.models = ["<primary provider/model>", "<fallback>", ...]`. Each entry gets an agent (`anvil-coder`, `anvil-coder-fb1`, …, and `anvil-inline`, `anvil-inline-fb1`, …).
- A turn that ends in `error`, or a stream that throws before any edit was applied, is retried on the same model with backoff (1 s, then 3 s, only for transient errors). After that Anvil fails over to the next model in a fresh session, with the same input. The panel shows a "Fell back to X" banner.
- If every model fails, the user gets a clear message with the TrueForge error text. The editor never blocks (everything is async), and nothing was written.
- If TrueForge itself is unreachable, the message explains how to start it.

---

## 2. Context assembly (B1, the intellectual core)

**Index** (built on activation, updated by a file watcher; Flask takes under 1 s):
- Workspace text files, excluding `.git`, `node_modules`, venvs, build dirs, and binaries over 512 KB.
- Chunking: Python by top-level `def` and `class`, plus methods inside classes (indentation aware). Markdown and RST by heading. Everything else in 60-line windows.
- Symbol table: `def` and `class` names mapped to file and line.
- BM25 over chunk tokens, with identifier splitting (snake_case and camelCase), path tokens, and a small stopword list.

**Context pack for a request** (budget `anvil.contextBudgetTokens`, default 6000; tokens estimated as chars/4):
1. **Explicit mentions**: `@path/to/file` (whole file, truncated to 40% of the budget) and `@symbol` (the defining chunk). Reason: "mentioned by you".
2. **Lexical retrieval**: BM25 top-k over chunks, with boosts for matches in the file path and for symbol-name matches. Reason: "matched: cli, command, json (score 9.1)".
3. **Structural expansion**: for each chosen source file, pull in its *counterparts*: `tests/test_<stem>.py`, docs pages mentioning the module, and the module's import neighbours. Reason: "test counterpart of src/flask/cli.py".
4. **Diversity and budget**: at most 2 chunks per file in the first pass, then greedy fill in score order until the budget is spent. Leftover high scorers are listed as "candidates (not included)" with paths only, so the agent can `read_file` them.
5. **Repo map**: a compact tree of directories and top-level symbols, capped at 1200 tokens.

The pack becomes the first user message. The panel renders it as a **Context card** listing each file, its line range, token count and *why*, plus the total used against the budget. That is the "visibly at work in Task B" anchor. The agent can pull more with `retrieve_context`, and each such call shows as a tool card with the same reasons.

**Harness context features** (B4 = 10):
- **Subagents**: instructions tell the coder to spawn an *explorer* subagent (`create_sub_agent`) for broad discovery on multi-file tasks, so the root context stays small. It shows in the session as a thread, and in the panel as a subagent card.
- **Deferred tool loading**: rarely used tools (`repo_map`, `get_diagnostics`) are not preloaded, and the model discovers them through `list_tools`/`call_tool`. The unwrapping logic handles `call_tool` approvals.
- **Compaction**: enabled with an explicit trigger (`input_tokens: 60000`). Compaction events show in the panel.
- **Large tool response** offload: enabled.

---

## 3. Inline edit (Task A)
- `Ctrl+Alt+K` with a selection opens an input box. Anvil builds context: the selected range, its enclosing function and class, the file's imports, and the retrieval pack, which is small (budget/3).
- It runs agent `anvil-inline`: no MCP tools, and an instruction to return only the replacement for the selection in one fenced block.
- **Streaming**: the diff editor opens immediately, and the right-hand side updates live as tokens arrive (throttled to 80 ms). The progress notification has a **Cancel** button, and `Anvil: Cancel` is also available.
- On completion the result goes through the same per-hunk review. Cancelling midway closes the preview, and the file is untouched.

---

## 4. Agent panel (Task B)
- Webview view in the Anvil activity-bar container, built with plain HTML, CSS and JS.
- Input with `@` autocomplete for files and symbols, fed from the index.
- Streamed rendering: assistant text deltas, tool-call cards (name, short args, running/ok/error, collapsible result), subagent threads, compaction notices, the context card, and approval/review status.
- Header: model in use (and fallback status), session id with an **Open in TrueForge** link, and a **Stop** button.
- Multi-turn: follow-ups continue the same session.

---

## 5. Repository layout
```
anvil/
  PLAN.md  README.md  LICENSE (MIT)  WRITEUP.md (draft)
  anvil.config.example.json        # example models/providers, no keys
  agents/anvil-coder.json          # agent definitions (deliverable)
  agents/anvil-inline.json
  scripts/start-trueforge.ps1|.sh  # starts TrueForge with localhost MCP allowed
  scripts/setup-providers.mjs      # optional: register providers from env keys
  extension/
    package.json  tsconfig.json  esbuild.mjs
    src/extension.ts
    src/config.ts
    src/trueforge/gateway.ts        # SDK client, agent upsert, run with retry and fallback
    src/trueforge/events.ts         # event reducer and tool-call bookkeeping
    src/mcp/server.ts               # streamable HTTP MCP host
    src/mcp/tools.ts
    src/context/indexer.ts  bm25.ts  chunker.ts  assembler.ts
    src/review/diff.ts  reviewManager.ts  undo.ts
    src/inline/inlineEdit.ts
    src/agent/runController.ts  panel.ts
    media/panel.js  panel.css
    test/                           # node tests: chunker, bm25, assembler on flask, diff hunks
```

## 6. Build order and checkpoints
1. Scaffold the extension (esbuild, CJS bundle) and the config.
2. Context engine, plus a CLI test against the flask 3.1.3 clone. Checkpoint: the Task B query picks cli.py, test_cli.py and docs/cli.rst within budget.
3. Diff/hunk engine, plus unit tests.
4. Review manager (virtual docs, diff editor, CodeLens, apply, undo).
5. MCP server and tools.
6. TrueForge gateway (agent upsert, MCP registration, streaming, cancel, retry, fallback).
7. Inline edit.
8. Agent panel and run controller (approval → review loop).
9. Scripts, agent JSON, README, write-up draft.
10. Live end-to-end on flask: Tasks A, B and C. This needs TrueForge running and a model key.

## 7. Risks
| Risk | Mitigation |
|---|---|
| TrueForge blocks localhost MCP URLs. | Start it with `NETWORK_POLICY_ENABLED=false` or `OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]'`, using the scripts provided. |
| A weak model can't drive the tool loop. | Use a capable free tier (for example Gemini) as primary. Scoring is behavioural, but Task B must still complete. |
| Tool names arrive prefixed, or wrapped in `call_tool`. | Normalise by suffix match and unwrap meta-tool args. |
| The turn pauses and the stream ends at `turn.done` with `requiredActions`. | Handle both the `turn.update: paused` and the `turn.done` + `requiredActions` paths. |
