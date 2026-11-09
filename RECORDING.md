# Demo video script (4 minutes or less, Tasks A → B → C)

You may cut **model waiting time**. Do **not** cut between giving an instruction and the diff appearing.

## Before recording (not on camera)
1. Run `scripts/start-trueforge.ps1` and leave it running.
2. Register providers:
   - `node scripts/register-providers.mjs` (with your API key env vars set)
   - `node scripts/register-providers.mjs examples/task-c-broken-provider.json`
3. Prepare Flask:
   ```
   cd flask-3.1.3
   git checkout 3.1.3 && git status    # must be clean
   .venv/Scripts/activate              # pip install -e . pytest==8.4.2  (pytest 9 breaks Flask 3.1.3's conftest)
   ```
4. Open `anvil/extension` in VS Code and press **F5**. The Flask window opens.
5. In the Flask window's settings, set `"anvil.models": ["google-gemini/gemini-3.5-flash", "google-gemini/gemini-3.1-flash-lite"]` (or `gemini-3.8-flash` as primary) and `"anvil.modelParams": {"google-gemini/gemini-3.5-flash": {"reasoning_effort": "low"}}`.
   - **Free-tier quotas are small** (about 5 requests/min and 20 requests/day per flash model). Do one dry run at most per model, and register two providers or projects (for example `google-gemini` plus Gemini's OpenAI-compatible endpoint as a `custom` provider, each with its own key) so fallback has quota left. Anvil waits out per-minute limits on its own; daily-quota errors fall back immediately. **Note:** Use the native `google-gemini` provider type for Gemini 3 models: through Gemini's OpenAI-compatible endpoint, multi-step tool calls fail with HTTP 400 because Gemini 3 thought signatures are not round-tripped.
   - Run `node scripts/register-providers.mjs --list` to confirm the exact model ids.
6. Run **Anvil: Register Agents & MCP Server with TrueForge**.
7. Lay out the screen: editor on the left, Anvil panel on the right, terminal at the bottom. Use a large font.

## 0:00–0:10 Intro
"Anvil: a VS Code coding agent whose loop runs on TrueForge." Show the panel header with the model.

## 0:10–0:55 Task A: inline edit
1. Open `src/flask/helpers.py` and select the whole `get_debug_flag` function.
2. Press **Ctrl+Alt+K** and paste:
   > Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.
3. The diff editor opens and **streams live**. Point out the progress notification and its Cancel button.
4. Point out the per-hunk **Accept / Reject** CodeLens. Accept the hunks (click, or press Ctrl+Alt+Y).
5. Verify in the terminal: `$env:FLASK_DEBUG="off"; python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"` prints **False**.
6. (B2 undo, 5 s) Press Ctrl+Z, or run "Anvil: Undo Last Applied Change", to show undo, then redo or accept again.

## 0:55–2:50 Task B: agent mode
1. In the Anvil panel, with **no files mentioned**, paste the Task B instruction exactly.
2. Point at the **Context card**: `cli.py`, `test_cli.py` and `docs/cli.rst`, each with its reason, plus the budget bar. That's B1.
3. Tool cards stream: `retrieve_context`, `read_file`, possibly a **sub-agent** card. Each `edit_file` opens a diff; accept the hunks one by one. If the model edits unrelated test infrastructure (for example `tests/conftest.py`), **reject** those hunks on camera: that is the per-hunk control (B2). Tool cards show deferred loading (`list_tools`, `get_tool_info`) and sub-agents (B4).
4. Approve the pytest `run_command` card. The **Anvil agent** terminal shows the run.
5. Show the **Changes in this run** card listing 3 or more files.
6. Click **TrueForge session ↗** and spend about 5 s on the session view showing turns, tool calls and the sub-agent thread. This is a required shot.
7. Verify:
   - `pytest tests/test_cli.py -q` passes (59 in the verified run)
   - `flask --help` lists `config  Show the app configuration.`
   - `flask --app <any app> config` prints masked JSON (`SECRET_KEY`, `DB_PASSWORD`, `API_TOKEN`, `STRIPE_KEY` shown as `***`)
   - `git status` shows 3 or more files changed

## 2:50–3:40 Task C: resilience
1. Settings: `"anvil.models": ["broken/dead-model", "<working model>"]`.
2. Run `git stash` (or `git checkout .`) so the tree is clean. Show `git status` is clean.
3. Repeat Task A. The primary is a `custom` provider at `127.0.0.1:59999`, so connections are refused (`ECONNREFUSED`). You'll see "Model error … retry 1/2 … retry 2/2" (1 s, then 3 s), then "**Falling back automatically to …**", and the diff streams from the second model. Accept it.
4. Optional, for the clear-error path: set only `["broken/dead-model"]` and run Task A. You get a clear error notification in about 4 s while the editor stays responsive; the file is untouched and `git status` stays clean.

## 3:40–4:00 Cancellation (A3)
Start any agent request and press **Stop** mid-stream. "Cancelled. Pending hunks were discarded." Show `git status` is clean.

## After recording
Fill in the scorecard timestamps in WRITEUP.md §6, then export the write-up to PDF (1 to 3 pages).
