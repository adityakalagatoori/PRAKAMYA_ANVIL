"""
Edit decision list for the in-VS-Code product film.

All rects are (x, y, w, h) in padded source pixels (1920x1080; recordings are 1920x1020 padded by 30px at
the top). Times are SOURCE times in each clip (seconds), so annotations stay locked to what actually
happened on screen. Positions were calibrated from the recorded layout snapshots and frames.
"""

P = 30  # vertical padding added on top of the 1920x1020 recordings
FULL = (0, 0, 1920, 1080)


def R(x, y, w, h):
    return (x, y + P, w, h)


# VS Code layout (identical across recordings: maximized window, 125% DPI)
SIDEBAR = R(60, 38, 375, 943)
EDITOR = R(441, 39, 1473, 941)
ANVIL_ICON = R(10, 317, 45, 45)
PANEL_HEADER = R(66, 80, 365, 70)
PANEL_INPUT = R(70, 848, 355, 82)
PANEL_STOP_SEND = R(298, 938, 128, 28)
EDITOR_LEFT_HALF = R(441, 60, 900, 900)


def line_rect(top_line, top_y, n, x=520, w=1340, count=1, h=25):
    """Rect for editor line n given that `top_line` is centred at y=top_y (source)."""
    y = top_y + (n - top_line) * h - h / 2
    return R(x, y, w, h * count)


def T(timeline, what):
    return next(e["t"] for e in timeline if e["what"] == what)


def make_edl(tour):
    t = {e["what"]: e["t"] for e in tour}
    segs = []

    # 1 — Intro: the product, inside VS Code -------------------------------------------------
    a = t["intro"]
    segs.append(dict(
        id="intro", clip="tour.mp4", src=(a, a + 7.5),
        text="This is Anvil. A coding agent that lives right inside VS Code, with its agent loop running on TrueForge. Everything you'll see here is the real product, running live.",
        camera=[(a, FULL), (a + 3.0, FULL), (a + 6.5, R(0, 20, 900, 506))],
        ann=[
            dict(k="title", t=(a, a + 3.6), title="Anvil", sub="An editor-native coding agent, built on TrueForge"),
            dict(k="cursor", t=(a + 3.6, a + 7.5), path=[(a + 3.6, (900, 600)), (a + 5.0, (32, 370))], clicks=[a + 5.1]),
            dict(k="box", t=(a + 5.0, a + 12.0), r=ANVIL_ICON, label="Anvil in the Activity Bar", side="right"),
            dict(k="box", t=(a + 5.6, a + 12.0), r=SIDEBAR, label=None),
        ],
    ))

    # 2 — Install: README setup ------------------------------------------------------------------
    a = t["readme"]
    L = lambda n, c=1: line_rect(21, 242, n, count=c, w=700)
    segs.append(dict(
        id="install", clip="tour.mp4", src=(a, a + 16.5),
        text="Getting started takes four steps, all in the README. Start TrueForge locally. Register a model provider, with your keys kept in environment variables. Build the extension. Then open your project, and press F5.",
        camera=[(a, EDITOR), (a + 1.8, R(441, 360, 1200, 675)), (a + 9.5, R(441, 420, 1200, 675)), (a + 13.5, R(441, 560, 1300, 731))],
        ann=[
            dict(k="chapter", t=(a, a + 4.0), num="01", title="Install", sub="Four steps from a clean clone"),
            dict(k="box", t=(a + 2.2, a + 5.6), r=L(28, 3), label="1 · Start TrueForge", side="right"),
            dict(k="box", t=(a + 5.6, a + 9.4), r=L(32, 3), label="2 · Register a model provider", side="right"),
            dict(k="box", t=(a + 9.4, a + 12.6), r=L(37, 2), label="3 · Build the extension", side="right"),
            dict(k="box", t=(a + 12.6, a + 16.5), r=line_rect(21, 242, 46, count=1, w=760), label="4 · Press F5", side="right"),
        ],
    ))

    # 3 — Agent definition ----------------------------------------------------------------------
    a = t["agentdef"]
    L = lambda n, c=1, w=1300: line_rect(7, 242, n, count=c, w=w)
    segs.append(dict(
        id="agentdef", clip="tour.mp4", src=(a, a + 12.5),
        text="The agent itself is defined in plain JSON. The editor's tools plug in as an MCP server. File writes and terminal commands always require your approval. And TrueForge's sub-agents and context compaction are switched on.",
        camera=[(a, R(441, 160, 1250, 703)), (a + 7.0, R(441, 200, 1250, 703))],
        ann=[
            dict(k="box", t=(a + 0.8, a + 4.0), r=L(7, 1, 300), label="Editor tools via MCP", side="right"),
            dict(k="box", t=(a + 4.0, a + 7.6), r=L(13, 1), label="Writes & commands need approval"),
            dict(k="box", t=(a + 7.6, a + 12.5), r=L(17, 3), label="Sub-agents + compaction on"),
        ],
    ))

    # 4 — Models & fallback chain -----------------------------------------------------------------
    a = t["settings"]
    L = lambda n, c=1, w=820: line_rect(1, 117, n, count=c, w=w)
    segs.append(dict(
        id="models", clip="tour.mp4", src=(a, a + 10.5),
        text="You choose the models. List them in order. The first is primary, and the rest are automatic fallbacks, from a cloud model all the way down to one running locally with Ollama.",
        camera=[(a, EDITOR), (a + 1.5, R(441, 560, 1000, 562))],
        ann=[
            dict(k="chapter", t=(a, a + 3.5), num="02", title="Configure", sub="Any model TrueForge serves"),
            dict(k="box", t=(a + 1.8, a + 4.6), r=L(24), label="Primary", side="right"),
            dict(k="box", t=(a + 4.6, a + 7.4), r=L(25, 2), label="Automatic fallbacks", side="right"),
            dict(k="box", t=(a + 7.4, a + 10.5), r=L(28, 5), label="Per-model tuning", side="right"),
        ],
    ))

    # 5 — Panel anatomy ---------------------------------------------------------------------------
    a = t["panel"]
    segs.append(dict(
        id="panel", clip="tour.mp4", src=(a, a + 10.5),
        text="This is the agent panel. At the top, the live status, the active model, and token usage. Undo and revert are always one click away. And at the bottom, you talk to the agent, or stop it at any moment.",
        camera=[(a, FULL), (a + 1.2, R(0, 20, 760, 1060))],
        ann=[
            dict(k="spot", t=(a + 1.2, a + 10.5), r=SIDEBAR),
            dict(k="box", t=(a + 1.8, a + 4.6), r=R(66, 84, 365, 30), label="Status · model · tokens", side="right"),
            dict(k="box", t=(a + 4.6, a + 7.2), r=R(195, 112, 240, 30), label="Undo · Revert run", side="right"),
            dict(k="box", t=(a + 7.2, a + 10.5), r=R(66, 845, 365, 125), label="Ask · Stop · Send", side="right"),
            dict(k="cursor", t=(a + 7.2, a + 10.5), path=[(a + 7.2, (600, 700)), (a + 8.6, (330, 982))], clicks=[]),
        ],
    ))

    # 5b — Context engine + cancellation (live) --------------------------------------------------
    c0, c1 = t["context"], t["cancel"]
    segs.append(dict(
        id="context", clip="tour.mp4", src=(c0 - 7.0, c1 + 1.8),
        text="Before the model writes a single token, Anvil's context engine decides what it should see. The most relevant functions, the matching tests and docs, all under a strict token budget, with the reason for every choice. And if you change your mind, Stop cancels instantly. Pending changes are discarded, and nothing is ever half applied.",
        camera=[(c0 - 7.0, R(0, 20, 760, 1060)), (c0 - 1.0, R(0, 230, 700, 600)), (c1 - 1.5, R(0, 230, 700, 600)), (c1 + 0.5, R(0, 380, 900, 700))],
        ann=[
            dict(k="chapter", t=(c0 - 7.0, c0 - 3.0), num="02b", title="Context engine", sub="What the model sees, and why"),
            dict(k="box", t=(c0 - 0.6, c1 - 1.0), r=R(72, 283, 352, 358), label="Files chosen · reasons · budget", side="right"),
            dict(k="cursor", t=(c1 - 2.6, c1 + 0.8), path=[(c1 - 2.6, (650, 700)), (c1 - 0.6, (328, 981))], clicks=[c1]),
            dict(k="box", t=(c1 - 0.8, c1 + 1.8), r=R(300, 940, 58, 24), label="Stop", side="right"),
            dict(k="box", t=(c1 + 0.2, c1 + 1.8), r=R(70, 650, 335, 45), label="Nothing half-applied", side="right"),
        ],
    ))

    # 6 — Task A: inline edit (live) ----------------------------------------------------------------
    segs.append(dict(
        id="taskA", live=True, clip="taskA.mp4", src=(0.3, 29.8), tail=1.2,
        text="Inline edit. Select a function, press Control Alt K, and describe the change in plain English. The edit streams into a side by side diff, opened right at the change. Accept it, hunk by hunk. Then verify. With FLASK DEBUG set to off, the function now returns False. And one click reverts it.",
        camera=[
            (0.3, R(441, 140, 1300, 731)),
            (2.6, R(300, 20, 1320, 742)),
            (8.6, EDITOR),
            (11.3, R(1150, 330, 770, 433)),
            (16.2, R(1150, 330, 770, 433)),
            (17.5, FULL),
            (20.3, R(441, 560, 1100, 619)),
            (26.6, R(441, 560, 1100, 619)),
            (28.0, FULL),
        ],
        ann=[
            dict(k="chapter", t=(0.3, 4.0), num="03", title="Inline edit", sub="Task A · live on Gemini"),
            dict(k="box", t=(0.4, 2.6), r=R(520, 228, 820, 205), label="Selected function", side="right"),
            dict(k="keys", t=(1.6, 4.4), keys=["Ctrl", "Alt", "K"]),
            dict(k="box", t=(9.0, 11.2), r=R(1180, 60, 730, 880), label="Streaming diff"),
            dict(k="box", t=(11.4, 15.9), r=R(1265, 462, 640, 150), label="Per-hunk Accept / Reject", side="above"),
            dict(k="cursor", t=(11.4, 16.0), path=[(11.4, (1700, 750)), (13.3, (1292, 509)), (14.6, (1292, 509)), (15.4, (1292, 630))], clicks=[14.1, 15.6]),
            dict(k="box", t=(21.6, 27.0), r=R(460, 725, 260, 34), label="FLASK_DEBUG=off → False", side="right"),
        ],
    ))

    # 7 — Task B: agent mode (live, edited) ------------------------------------------------------
    segs.append(dict(
        id="taskB", live=True, clip="agent.mp4", src=(0.0, 70.6), tail=1.2, badge="model time sped up up to 40x",
        text="Now a multi-file change, with no files named. Add a flask config command that masks secrets, tested and documented. The agent explores the codebase on its own, and every tool call appears as a card in the panel. Each edit opens as a diff for review. The command, its test, and the docs. When it's done, Anvil lists exactly what changed. Three files. All fifty-nine tests pass. And the new command prints the configuration, with every secret masked.",
        camera=[
            (0.0, R(0, 20, 760, 1060)),
            (4.0, R(0, 20, 760, 1060)),
            (12.0, R(0, 60, 900, 900)),
            (17.0, EDITOR),
            (38.0, EDITOR),
            (46.0, R(0, 380, 760, 700)),
            (50.0, R(441, 30, 1100, 619)),
            (59.0, R(441, 120, 1100, 619)),
            (68.0, R(441, 120, 1100, 619)),
        ],
        ann=[
            dict(k="chapter", t=(0.0, 4.2), num="04", title="Agent mode", sub="Task B · one request, no files named"),
            dict(k="box", t=(0.5, 5.5), r=R(66, 845, 365, 125), label="One request", side="right"),
            dict(k="box", t=(7.0, 16.5), r=R(62, 160, 370, 650), label="Tool cards, live", side="right"),
            dict(k="box", t=(18.0, 29.5), r=R(441, 60, 1473, 900), label="Every edit is a reviewed diff", side="below"),
            dict(k="box", t=(46.0, 50.0), r=R(66, 672, 345, 152), label="Changes in this run", side="right"),
            dict(k="box", t=(51.5, 58.5), r=R(460, 225, 330, 32), label="59 passed", side="right"),
            dict(k="box", t=(61.0, 70.4), r=R(460, 335, 760, 120), label="Secrets masked as ***", side="right"),
        ],
    ))

    # 8 — TrueForge sessions, inside VS Code -----------------------------------------------------
    a = t["trueforge"]
    b = t.get("tfsession", a + 6)
    segs.append(dict(
        id="trueforge", clip="tour.mp4", src=(a, b + 12.0),
        text="Every run is a real TrueForge session. Here's the sessions dashboard, opened right inside VS Code. And here's the Task B session, with the agent's own summary of what it built.",
        camera=[(a, EDITOR), (a + 2.0, R(441, 120, 1000, 562)), (b - 0.2, EDITOR), (b + 3.0, R(900, 150, 1000, 562))],
        ann=[
            dict(k="chapter", t=(a, a + 3.6), num="05", title="TrueForge", sub="Sessions, turns and tool calls"),
            dict(k="box", t=(a + 2.2, b - 0.4), r=R(545, 210, 480, 320), label="Real agent sessions", side="right"),
            dict(k="box", t=(b + 3.2, b + 11.6), r=R(945, 200, 840, 420), label="Agent's own summary", side="below"),
        ],
    ))

    # 9 — Task C: resilience (live) --------------------------------------------------------------
    segs.append(dict(
        id="taskC", live=True, clip="taskC.mp4", src=(0.5, 52.0), tail=1.2,
        text="Models fail, so Anvil plans for it. Here, the primary model points at an endpoint that's down. Anvil retries with backoff, then switches to the next model on its own, and the edit still lands. With no model left, you get a clear error. Nothing changes on disk, and the editor never freezes.",
        camera=[
            (0.5, R(441, 560, 900, 506)),
            (5.6, R(0, 380, 900, 700)),
            (16.8, R(0, 380, 900, 700)),
            (17.6, R(1150, 330, 770, 433)),
            (22.5, FULL),
            (26.8, R(441, 560, 1100, 619)),
            (31.0, FULL),
            (44.2, R(0, 380, 900, 700)),
            (49.0, R(1100, 640, 820, 461)),
        ],
        ann=[
            dict(k="chapter", t=(0.5, 4.5), num="06", title="Resilience", sub="Task C · primary model unreachable"),
            dict(k="box", t=(1.0, 5.4), r=line_rect(1, 117, 24, w=700), label="Broken primary first", side="right"),
            dict(k="box", t=(7.0, 16.6), r=R(66, 470, 365, 340), label="Retry → automatic fallback", side="right"),
            dict(k="box", t=(17.8, 22.0), r=R(1265, 462, 640, 150), label="Fallback model's edit", side="above"),
            dict(k="box", t=(44.6, 48.8), r=R(66, 720, 365, 105), label="Clear error", side="right"),
            dict(k="box", t=(49.2, 51.8), r=R(1340, 920, 570, 60), label="Workspace untouched", side="above"),
        ],
    ))

    # 10 — Security: SECURITY.md --------------------------------------------------------------------
    a = t["securitymd"]
    segs.append(dict(
        id="sec_doc", clip="tour.mp4", src=(a, a + 14.5),
        text="Security is built in. We studied real attacks on AI coding tools, and closed thirteen classes of them. Each one is documented here, next to the incident it comes from, and the control that stops it.",
        camera=[(a, EDITOR), (a + 2.5, R(441, 300, 1450, 815))],
        ann=[
            dict(k="chapter", t=(a, a + 3.8), num="07", title="Security", sub="13 vulnerability classes, each with a test"),
            dict(k="box", t=(a + 3.0, a + 8.0), r=R(525, 335, 1370, 190), label="Config tampering → code execution", side="below"),
            dict(k="box", t=(a + 8.0, a + 14.3), r=R(525, 685, 1370, 140), label="Secrets never reach the model", side="above"),
        ],
    ))

    # 11 — Security: policy code -------------------------------------------------------------------
    a = t["policy"]
    segs.append(dict(
        id="sec_policy", clip="tour.mp4", src=(a, a + 10.5),
        text="In code, sensitive paths like VS Code settings, CI workflows, git hooks and agent rule files are protected by policy.",
        camera=[(a, R(441, 160, 1250, 703))],
        ann=[dict(k="box", t=(a + 1.0, a + 10.3), r=line_rect(26, 242, 26, count=10, w=1360), label="Protected paths", side="above")],
    ))

    # 12 — Security: flagged injected edit + audit + tests ----------------------------------------
    a = t["flagged"]
    segs.append(dict(
        id="sec_flagged", clip="tour.mp4", src=(a, a + 8.0),
        text="So when a prompt-injected edit tries to turn on auto-approval in VS Code settings, Anvil flags it before anything touches disk, and you decide.",
        camera=[(a, EDITOR), (a + 1.2, R(1160, 60, 760, 427))],
        ann=[
            dict(k="box", t=(a + 1.4, a + 7.8), r=R(1236, 78, 649, 24), label="Sensitive file · needs confirmation", side="below"),
            dict(k="box", t=(a + 3.8, a + 7.8), r=R(1236, 170, 640, 32), label="auto-approve injected", side="below"),
        ],
    ))
    a = t["audit"]
    segs.append(dict(
        id="sec_audit", clip="tour.mp4", src=(a, a + 8.0),
        text="Every action is written to an audit log, with secrets redacted.",
        camera=[(a, R(441, 60, 1300, 731))],
        ann=[dict(k="box", t=(a + 0.8, a + 7.8), r=R(520, 105, 1380, 80), label="Audit trail", side="below")],
    ))
    a = t["tests"]
    segs.append(dict(
        id="sec_tests", clip="tour.mp4", src=(a, a + 9.5),
        text="And every control is backed by a test, including live attack simulations. Forty unit tests, and ten more inside a real VS Code.",
        camera=[(a, R(441, 90, 1300, 731))],
        ann=[
            dict(k="box", t=(a + 0.8, a + 5.4), r=R(462, 145, 940, 250), label="Attack simulations", side="right"),
            dict(k="box", t=(a + 5.4, a + 9.3), r=R(462, 410, 200, 50), label="12 / 12 pass", side="right"),
        ],
    ))

    # 13 — Outro ---------------------------------------------------------------------------------------
    a = t["outro"]
    segs.append(dict(
        id="outro", clip="tour.mp4", src=(a, a + 6.0), tail=1.6,
        text="Anvil. Context you can see. Changes you control. And an agent that keeps working when models fail. Built on TrueForge.",
        camera=[(a, R(0, 20, 900, 506)), (a + 2.5, FULL)],
        ann=[dict(k="title", t=(a + 1.5, a + 8.0), title="Anvil", sub="Context you can see · Changes you control · Built on TrueForge")],
    ))
    return segs
