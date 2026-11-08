# Anvil: a VS Code coding agent on TrueForge

Anvil is a Visual Studio Code extension whose agent loop runs on [TrueForge](https://github.com/truefoundry/trueforge), TrueFoundry's open-source agent harness, in local mode. It was built for the TrueFoundry Forge-a-thon (Techfest 2026-27).

| Capability | What it does |
|---|---|
| **Inline edit** (`Ctrl+Alt+K`) | Select code, type an instruction, and the diff streams into the editor. You then accept or reject each hunk. |
| **Agent mode** (Anvil panel, `Ctrl+Alt+A`) | One request drives a TrueForge agent through a tool loop: retrieve, search, read, edit, run tests. It finds the files itself. |
| **Context assembly** | Supports `@file` and `@symbol` mentions. Automatic retrieval uses BM25 over definition-level chunks, adds test and docs counterparts, and stays under a token budget. The panel shows every chosen file and why it was chosen. |
| **Diff review** | Every write is gated by TrueForge tool approval and shown hunk by hunk in a native diff editor. Each hunk applies atomically, and you can undo with `Ctrl+Z`, "Undo last applied change", or "Revert run". Nothing is written to disk silently. |
| **Streaming and cancellation** | Tokens stream from TrueForge events. Stop, `Esc` in the panel, or `Ctrl+Alt+Backspace` cancels the TrueForge session, kills running commands and discards pending hunks. |
| **Resilience** | Transient errors are retried with backoff. Anvil then fails over automatically to the next configured model. If every model fails, you get a clear message and the workspace is untouched. |

**Starting point:** from scratch. There is no upstream fork; all code in this repository is original. Libraries: `@truefoundry/trueforge-sdk`, `@modelcontextprotocol/sdk`, `diff`, `zod`.

---

## Setup from a clean clone

Requirements: Node.js 22.14 or newer, VS Code 1.90 or newer, Git, and Python 3.9 or newer (to run Flask's tests).

```bash
git clone <this repo> anvil && cd anvil

# 1. Start TrueForge locally (http://localhost:8790). Leave it running.
#    The script allow-lists 127.0.0.1 so TrueForge can reach Anvil's MCP server inside VS Code.
./scripts/start-trueforge.sh            # Windows: powershell -File scripts/start-trueforge.ps1

# 2. Register a model provider (keys come from env vars; nothing is written to the repo).
export GEMINI_API_KEY=...               # and/or GROQ_API_KEY=..., or run Ollama locally
node scripts/register-providers.mjs     # prints the model ids TrueForge exposes
#    (or add providers in the TrueForge UI: Settings → Models)

# 3. Build the extension
cd extension && npm install && npm run build && npm test

# 4. Get the pinned repository
git clone https://github.com/pallets/flask.git ../../flask-3.1.3 && git -C ../../flask-3.1.3 checkout 3.1.3
cd ../../flask-3.1.3 && python -m venv .venv && . .venv/bin/activate && pip install -e . pytest
```

Then open `anvil/extension` in VS Code and press **F5** ("Run Anvil on flask-3.1.3"). In the new window, set the models in settings (see [examples/vscode-settings.example.jsonc](examples/vscode-settings.example.jsonc)):

```jsonc
"anvil.models": ["google-gemini/gemini-2.5-flash", "groq/llama-3-3-70b"]   // primary, then fallbacks
```

Run **"Anvil: Register Agents & MCP Server with TrueForge"**. Anvil also does this automatically before the first run. It:
1. registers its MCP server `anvil-editor` (`http://127.0.0.1:7337/mcp`, header-token auth) with `PUT /api/v1/settings/mcp-servers`, and
2. upserts the agent definitions in [agents/](agents/), one per configured model: `anvil-coder`, `anvil-coder-fb1`, …, and `anvil-inline`, `anvil-inline-fb1`, ….

### Switching models
Change `anvil.models`. The first entry is primary and the others are automatic fallbacks, in order. The agents are re-registered with the new models on the next run. Any model TrueForge can serve works: a catalog provider, an OpenAI-compatible endpoint, or a local Ollama model. Anvil never calls a provider directly.

---

## How it fits together

```
VS Code extension ──(TrueForge TS SDK: sessions, turns, SSE stream, cancel)──► TrueForge (local, :8790) ──► model
       ▲                                                                              │
       └────────────── MCP over streamable HTTP (127.0.0.1:7337/mcp) ◄────────────────┘
                       read/search/retrieve tools, reviewed writes, approved commands
```

- **The agent decides; the editor executes.** The editor's capabilities are MCP tools (`retrieve_context`, `search_code`, `find_symbol`, `read_file`, `list_files`, `repo_map`, `get_diagnostics`, `edit_file`, `create_file`, `run_command`). TrueForge calls them.
- **TrueForge approval drives the diff review.** `edit_file`, `create_file` and `run_command` are listed in `require_approval_for_tools`. On `tool.approval_required`, Anvil computes the proposed file in memory and opens the per-hunk review. It then answers TrueForge with `user.tool_approval` set to `allow`, or to `deny` with the reason (for example "user rejected all hunks" or "old_string not found"). The tool result reports exactly which hunks landed.
- **Harness features used:**
  - *Dynamic sub-agents*: the coder can delegate repository exploration, which shows as a sub-agent card in the panel and a thread in the TrueForge session.
  - *Deferred tool loading*: `preload: false` with eight preloaded tools; `repo_map` and `get_diagnostics` are discovered on demand.
  - *Compaction*: triggered at 60k input tokens.
  - *Large tool response* offload.

Design details, trade-offs and the build plan: [PLAN.md](PLAN.md) and [WRITEUP.md](WRITEUP.md).

## Demo script (the three fixed tasks)

| Task | Steps | Verify |
|---|---|---|
| **A. Inline edit** | Open `src/flask/helpers.py`, select `get_debug_flag`, press `Ctrl+Alt+K`, and paste the instruction. Watch the diff stream, then accept the hunks. | `FLASK_DEBUG=off python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"` prints `False` |
| **B. Agent mode** | In the Anvil panel, paste the `flask config` instruction (no files named). The Context card shows what was retrieved and why. Review each `edit_file` diff, then approve the pytest command. Click the session link to open it in TrueForge. | `pytest tests/test_cli.py -q` passes. `flask --app <app> config` prints masked JSON. `git status` shows 3 or more files changed. |
| **C. Resilience** | Run `node scripts/register-providers.mjs examples/task-c-broken-provider.json`, set `"anvil.models": ["broken/dead-model", "<working model>"]`, and repeat Task A. | A "falling back to …" notice appears and the edit completes on the second model. With only the broken model, a clear error appears. `git status` shows nothing changed. |

## Development

```bash
cd extension
npm run watch      # rebuild on change
npm test           # 16 tests: retrieval on flask, hunks, MCP transport, runner (approval, fallback, backoff, cancel)
STUB_WORKSPACE=/path/to/flask-3.1.3 npm test   # also runs the flask-backed MCP and approval tests
```

## Models used

See [WRITEUP.md §5](WRITEUP.md). No API keys are committed. Keys are supplied through env vars to `scripts/register-providers.mjs`, or entered in the TrueForge UI.

## License

MIT. See [LICENSE](LICENSE).
