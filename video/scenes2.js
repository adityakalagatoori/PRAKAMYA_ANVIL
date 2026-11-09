// Pitch scenes (loaded after scenes.html's main script; reuses its helpers and `scenes` table).
Object.assign(scenes, {
  hook(t) {
    const lines = [
      ['Editing src/utils.py', 'you asked about cli.py'],
      ['Rewrote 240 lines', 'you asked to change one function'],
      ['Calling helpers.get_flagz()', 'that symbol does not exist'],
    ];
    const head = ease(k(t, 0.2, 0.6));
    const out = lines
      .map(([a, b], i) => {
        const st = 0.8 + i * 2.4;
        const typed = Math.floor(clamp((t - st) / 1.0) * a.length);
        const strike = ease(k(t, st + 1.3, 0.4));
        return `<div class="abs card mono" style="left:260px; top:${300 + i * 140}px; width:1400px; display:flex; align-items:center; gap:24px; opacity:${t > st ? 1 : 0}">
          <span style="color:var(--violet); font-size:28px">assistant ›</span>
          <span style="font-size:34px; position:relative">${a.slice(0, typed)}<span style="position:absolute; left:0; top:50%; height:3px; background:var(--bad); width:${strike * 100}%"></span></span>
          <span class="bad" style="font-size:26px; opacity:${strike}; margin-left:auto; font-family:'Segoe UI'">✕ ${b}</span></div>`;
      })
      .join('');
    const end = ease(k(t, 9.5, 0.9));
    return `
      <div class="abs sub" style="left:260px; top:200px; opacity:${head}">Every engineer has seen this:</div>
      ${out}
      <div class="abs h1" style="width:100%; text-align:center; top:780px; opacity:${end}; transform: translateY(${(1 - end) * 20}px)">We built the coding agent <span class="accent">we wanted to use.</span></div>`;
  },

  solution(t) {
    const a = outBack(k(t, 0.2, 0.9)),
      b = ease(k(t, 0.8, 0.7));
    const pillars = [
      ['🎯', 'Finds the right code', 'even when the repo outgrows the context window'],
      ['🔍', 'Shows every change', 'per-hunk review · nothing silent · one-click revert'],
      ['🛟', 'Survives model failure', 'retry · rate-limit resume · automatic fallback'],
      ['🛡️', 'Secure by design', '13 vulnerability classes closed, each with a test'],
    ];
    return `
      <div class="abs" style="left:180px; top:110px; transform: scale(${a})">${anvilMark(120)}</div>
      <div class="abs title" style="left:330px; top:95px; font-size:110px; opacity:${b}">Anvil</div>
      <div class="abs sub" style="left:336px; top:240px; opacity:${b}">An editor-native coding agent for VS Code</div>
      ${pillars
        .map(([ic, h, d], i) => {
          const p = ease(k(t, 4.0 + i * 2.6, 0.7));
          return `<div class="abs card" style="left:${180 + (i % 2) * 800}px; top:${380 + Math.floor(i / 2) * 260}px; width:760px; height:220px; opacity:${p}; transform: translateY(${(1 - p) * 30}px)">
            <div style="font-size:52px">${ic}</div><div class="h2" style="margin-top:10px">${h}</div><div class="sub" style="font-size:26px; margin-top:6px">${d}</div></div>`;
        })
        .join('')}`;
  },

  context(t) {
    const head = ease(k(t, 0.1, 0.6));
    const q = 'Add a flask config command that masks secrets, with a test and docs';
    const qp = ease(k(t, 0.8, 0.6));
    const idx = ease(k(t, 2.6, 0.6));
    const ranked = [
      ['src/flask/cli.py', 'FlaskGroup.list_commands', 18.9],
      ['src/flask/cli.py', 'FlaskGroup.get_command', 18.2],
      ['src/flask/config.py', 'Config', 25.0],
      ['docs/config.rst', 'Builtin Configuration Values', 23.6],
    ];
    const cps = [
      ['tests/test_cli.py', 'test counterpart of cli.py'],
      ['docs/cli.rst', 'docs page for cli.py'],
    ];
    const used = Math.round(5855 * ease(k(t, 12.5, 3.5)));
    return `
      <div class="abs h1" style="left:140px; top:70px; opacity:${head}">The context engine</div>
      <div class="abs card" style="left:140px; top:190px; width:1640px; opacity:${qp}"><span class="sub" style="font-size:24px">request · no files named</span><div class="h2" style="margin-top:6px">“${q}”</div></div>
      <div class="abs chip" style="left:140px; top:360px; opacity:${idx}"><span class="dot"></span>Flask index · 200 files · 1,672 function / class / section chunks · BM25</div>
      ${ranked
        .map(([f, sym, sc], i) => {
          const p = ease(k(t, 4.2 + i * 0.7, 0.5));
          return `<div class="abs card" style="left:140px; top:${450 + i * 92}px; width:980px; padding:16px 26px; opacity:${p}; transform: translateX(${(1 - p) * -40}px); display:flex; gap:20px; align-items:center">
            <span class="mono" style="font-size:24px; width:330px">${f}</span><span style="font-size:24px; color:var(--muted); flex:1">${sym}</span>
            <span class="mono accent" style="font-size:24px">${sc.toFixed(1)}</span></div>`;
        })
        .join('')}
      <div class="abs sub" style="left:1180px; top:445px; font-size:26px; opacity:${ease(k(t, 7.5, 0.6))}">+ structural counterparts</div>
      ${cps
        .map(([f, why], i) => {
          const p = ease(k(t, 8.2 + i * 1.2, 0.6));
          return `<div class="abs card" style="left:1180px; top:${500 + i * 120}px; width:600px; padding:18px 26px; border-color:var(--ok); opacity:${p}; transform: translateX(${(1 - p) * 40}px)">
            <div class="mono ok" style="font-size:26px">${f}</div><div style="font-size:22px; color:var(--muted)">${why}</div></div>`;
        })
        .join('')}
      <div class="abs" style="left:140px; top:900px; width:1640px; opacity:${ease(k(t, 12, 0.5))}">
        <div style="display:flex; justify-content:space-between; font-size:26px"><span>token budget · every choice shown with its reason</span><span class="mono">${used.toLocaleString('en-US')} / 6,000</span></div>
        <div style="height:16px; background:var(--line); border-radius:8px; margin-top:10px"><div style="height:100%; width:${(used / 6000) * 100}%; background:linear-gradient(90deg,var(--accent),var(--accent2)); border-radius:8px"></div></div>
      </div>`;
  },

  reliability(t) {
    const head = ease(k(t, 0.1, 0.6));
    const cards = [
      ['⏱', 'Rate limits', 'honours “retry in Xs”, resumes the same session'],
      ['⚡', 'Daily quota', 'instant fallback, no futile waiting'],
      ['🔁', 'Model fallback', 'primary → fallback chain, automatic'],
      ['🧭', 'Text tool calls', 'detected and steered to real function calls'],
      ['▶', 'Stalled agents', 'auto-continue when no change was attempted'],
      ['🧯', 'Runaway loops', 'circuit breaker + per-run call budget'],
    ];
    return `
      <div class="abs h1" style="left:140px; top:90px; opacity:${head}">Built for <span class="accent">real-world</span> models</div>
      <div class="abs sub" style="left:140px; top:190px; opacity:${head}">Each came from a failure we hit in live runs, and each is now covered by a test</div>
      ${cards
        .map(([ic, h, d], i) => {
          const p = ease(k(t, 2.0 + i * 2.6, 0.6));
          return `<div class="abs card" style="left:${140 + (i % 3) * 555}px; top:${300 + Math.floor(i / 3) * 320}px; width:520px; height:290px; opacity:${p}; transform: scale(${0.92 + 0.08 * p})">
            <div style="font-size:54px">${ic}</div><div class="h2" style="margin-top:14px">${h}</div><div class="sub" style="font-size:26px; margin-top:8px">${d}</div></div>`;
        })
        .join('')}`;
  },

  proof(t) {
    const head = ease(k(t, 0.1, 0.6));
    const stats = [
      ['40', 'unit tests', 'incl. attack simulations over HTTP'],
      ['10', 'VS Code integration tests', 'real editor, real diff review'],
      ['3 / 3', 'demo tasks', 'verified live on TrueForge'],
      ['0', 'known vulnerabilities', 'npm audit · exact-pinned deps'],
    ];
    return `
      <div class="abs h1" style="width:100%; text-align:center; top:130px; opacity:${head}">Every claim, <span class="accent">backed by a test</span></div>
      ${stats
        .map(([n, l, d], i) => {
          const st = 1.5 + i * 1.6;
          const p = ease(k(t, st, 0.6));
          const num = /^\d+$/.test(n) ? Math.round(parseInt(n, 10) * ease(k(t, st, 1.0))) : n;
          return `<div class="abs card" style="left:${140 + i * 415}px; top:360px; width:385px; height:400px; text-align:center; opacity:${p}; transform: translateY(${(1 - p) * 30}px)">
            <div class="accent" style="font-size:110px; font-weight:800; margin-top:20px">${num}</div><div class="h2" style="font-size:32px">${l}</div><div class="sub" style="font-size:22px; margin-top:12px">${d}</div></div>`;
        })
        .join('')}`;
  },
});
