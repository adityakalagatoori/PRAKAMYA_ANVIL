// Anvil agent panel (webview). Renders TrueForge stream events relayed by the extension.
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const log = $('log');
  const input = $('input');
  const mentionsBox = $('mentions');
  let running = false;
  let currentAssistant = {}; // threadId -> element
  const toolCards = {}; // tool call id -> card
  const threadCards = {}; // subagent thread id -> card
  let mentionItems = [];
  let mentionSel = 0;

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const scroll = () => {
    if (log.scrollHeight - log.scrollTop - log.clientHeight < 160) log.scrollTop = log.scrollHeight;
  };
  const clearEmpty = () => {
    const e = log.querySelector('.empty');
    if (e) e.remove();
  };

  function card(title, sub, cls, collapsed = true) {
    const c = el('div', 'card ' + (cls || '') + (collapsed ? ' collapsed' : ''));
    const head = el('div', 'head');
    const dot = el('span', 'dot run');
    const t = el('span', 'title', title);
    const s = el('span', 'sub', sub || '');
    head.append(dot, t, s);
    const body = el('div', 'body');
    head.onclick = () => c.classList.toggle('collapsed');
    c.append(head, body);
    c._dot = dot;
    c._sub = s;
    c._body = body;
    return c;
  }

  function container(threadId) {
    if (threadId && threadId !== 'main' && threadCards[threadId]) return threadCards[threadId]._body;
    return log;
  }

  function setRunning(on, label) {
    running = on;
    $('stop').disabled = !on;
    $('send').disabled = on;
    const st = $('status');
    st.textContent = label || (on ? 'running' : 'idle');
    st.className = 'pill' + (on ? ' running' : label === 'error' ? ' error' : '');
  }

  function summarizeArgs(name, a) {
    if (!a || typeof a !== 'object') return '';
    if (a.path && name === 'read_file') return a.path + (a.start_line ? `:${a.start_line}-${a.end_line || ''}` : '');
    if (a.path) return a.path;
    if (a.query) return '“' + a.query + '”';
    if (a.pattern) return '/' + a.pattern + '/' + (a.path_glob ? ' in ' + a.path_glob : '');
    if (a.name) return a.name;
    if (a.command) return '$ ' + a.command;
    if (a.dir) return a.dir;
    return JSON.stringify(a).slice(0, 80);
  }

  function renderContext(s) {
    const c = card('Context', `${s.items.length} chunks · ${new Set(s.items.map((i) => i.path)).size} files · ${s.used}/${s.budget} tokens`, 'context', false);
    c._dot.className = 'dot ok';
    const b = c._body;
    b.style.fontFamily = 'var(--vscode-font-family)';
    const bar = el('div', 'budget');
    const fill = el('div');
    fill.style.width = Math.min(100, (100 * s.used) / s.budget) + '%';
    bar.append(fill);
    b.append(el('div', 'muted', 'Selected by Anvil’s retriever before the first model call (query terms: ' + s.queryTerms.slice(0, 12).join(', ') + ')'), bar);
    const table = el('table', 'ctx-table');
    for (const it of s.items) {
      const tr = el('tr');
      const p = el('td', 'path');
      const a = el('a', '', `${it.path}:${it.lines}`);
      a.onclick = () => vscode.postMessage({ type: 'open', path: it.path, line: it.lines.split('-')[0] });
      p.append(el('span', 'tag', it.source), a);
      const why = el('td', 'why', (it.symbol ? it.symbol + ' — ' : '') + it.reason);
      tr.append(p, why, el('td', 'tok', it.tokens + 't'));
      table.append(tr);
    }
    b.append(table);
    if (s.candidates.length) {
      b.append(el('div', 'muted', 'Also relevant, left out for budget (agent can read them): '));
      b.append(el('div', '', s.candidates.map((c) => `${c.path} (${c.reason})`).join('\n')));
    }
    log.append(c);
  }

  function onUi(e) {
    clearEmpty();
    switch (e.t) {
      case 'run.start':
        setRunning(true, e.kind === 'inline' ? 'inline edit' : 'running');
        currentAssistant = {};
        break;
      case 'session': {
        $('model').textContent = `${e.model}${e.slot ? ' (fallback #' + e.slot + ')' : ''} · ${e.agent}`;
        const a = $('session');
        a.textContent = 'TrueForge session ' + e.sessionId.slice(0, 12) + '… ↗';
        a.onclick = (ev) => {
          ev.preventDefault();
          vscode.postMessage({ type: 'open', url: e.url });
        };
        break;
      }
      case 'context':
        renderContext(e.summary);
        break;
      case 'delta': {
        const parent = container(e.threadId);
        let m = currentAssistant[e.threadId];
        if (!m) {
          m = el('div', 'msg assistant');
          parent.append(m);
          currentAssistant[e.threadId] = m;
        }
        m.textContent += e.text;
        scroll();
        break;
      }
      case 'message.done':
        delete currentAssistant[e.threadId];
        break;
      case 'tool.start': {
        delete currentAssistant[e.threadId];
        const c = card(e.name, summarizeArgs(e.name, e.args));
        c._body.textContent = JSON.stringify(e.args, null, 2);
        toolCards[e.id] = c;
        container(e.threadId).append(c);
        scroll();
        break;
      }
      case 'tool.result': {
        const c = toolCards[e.id];
        if (!c) break;
        c._dot.className = 'dot ' + (e.ok ? 'ok' : 'err');
        const res = el('div');
        res.style.marginTop = '6px';
        res.textContent = '→ ' + (e.content.length > 6000 ? e.content.slice(0, 6000) + '\n…' : e.content);
        c._body.append(res);
        if (/^(edit_file|create_file|retrieve_context)$/.test(c.querySelector('.title').textContent)) {
          c._sub.textContent += ' — ' + e.content.split('\n')[0].slice(0, 120);
        }
        break;
      }
      case 'approval': {
        const c = toolCards[e.id];
        if (c) {
          c._dot.className = 'dot wait';
          c._sub.textContent = e.summary;
        }
        if (e.name === 'run_command') {
          const box = el('div', 'card');
          const row = el('div', 'approval');
          row.append(el('span', '', '⚠ ' + e.summary));
          const ok = el('button', 'primary', 'Run');
          const no = el('button', '', 'Deny');
          const done = (v) => {
            vscode.postMessage({ type: 'approveCommand', id: e.id, ok: v });
            box.remove();
          };
          ok.onclick = () => done(true);
          no.onclick = () => done(false);
          box.dataset.approval = e.id;
          row.append(ok, no);
          box.append(row);
          log.append(box);
          scroll();
        }
        break;
      }
      case 'approval.resolved': {
        const c = toolCards[e.id];
        if (c) {
          c._dot.className = 'dot ' + (e.allowed ? 'run' : 'err');
          c._sub.textContent = e.summary;
        }
        const box = log.querySelector(`[data-approval="${e.id}"]`);
        if (box) box.remove();
        break;
      }
      case 'thread': {
        const c = card('sub-agent', e.title || e.threadId, 'thread', false);
        if (e.input) c._body.append(el('div', 'muted', e.input.slice(0, 600)));
        threadCards[e.threadId] = c;
        log.append(c);
        scroll();
        break;
      }
      case 'thread.done': {
        const c = threadCards[e.threadId];
        if (c) {
          c._dot.className = 'dot ' + (e.status === 'error' ? 'err' : 'ok');
          c.classList.add('collapsed');
        }
        break;
      }
      case 'compaction':
        log.append(el('div', 'notice info', e.phase === 'start' ? '⟳ TrueForge is compacting the context window…' : '✓ Context compacted (' + e.detail + ')'));
        break;
      case 'notice':
        log.append(el('div', 'notice ' + e.level, e.text));
        scroll();
        break;
      case 'fallback':
        log.append(el('div', 'notice warn', `⚠ ${e.from} failed (${(e.reason || '').slice(0, 140)}). Falling back automatically to ${e.to}.`));
        scroll();
        break;
      case 'run.end':
        setRunning(false, e.status === 'done' ? 'idle' : e.status);
        currentAssistant = {};
        Object.values(toolCards).forEach((c) => {
          if (c._dot.classList.contains('run') || c._dot.classList.contains('wait')) c._dot.className = 'dot ' + (e.status === 'done' ? 'ok' : 'err');
        });
        log.querySelectorAll('[data-approval]').forEach((b) => b.remove());
        if (e.status === 'cancelled') log.append(el('div', 'notice warn', '■ Cancelled. Pending hunks were discarded; nothing half-applied.'));
        if (e.status === 'error') log.append(el('div', 'notice error', '✖ ' + (e.message || 'Run failed') + '\nThe workspace was not changed by this failure.'));
        scroll();
        break;
    }
  }

  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (m.type === 'ui') onUi(m.event);
    else if (m.type === 'user') {
      clearEmpty();
      log.append(el('div', 'msg user', m.text));
      scroll();
    } else if (m.type === 'cleared') {
      log.innerHTML = '';
      log.append(el('div', 'empty', 'New conversation.'));
      $('session').textContent = '';
    } else if (m.type === 'config') {
      $('model').textContent = m.models.length ? m.models.join(' → ') : 'no model configured (set anvil.models)';
    } else if (m.type === 'mentionResults') showMentions(m.items);
    else if (m.type === 'undoState') $('revert').disabled = !m.count;
    else if (m.type === 'changes') {
      const c = card('Changes in this run', `${m.files.length} file(s) changed — all reviewed by you`, 'context', false);
      c._dot.className = 'dot ok';
      const t = el('table', 'ctx-table');
      for (const f of m.files) {
        const tr = el('tr');
        const td = el('td', 'path');
        const a = el('a', '', f.path);
        a.onclick = () => vscode.postMessage({ type: 'open', path: f.path, line: 1 });
        if (f.created) td.append(el('span', 'tag', 'new'));
        td.append(a);
        const stat = el('td', 'tok');
        stat.innerHTML = '';
        stat.append(el('span', 'add', '+' + f.added), document.createTextNode(' '), el('span', 'del', '−' + f.removed));
        tr.append(td, el('td', 'why', f.applies + ' accepted change' + (f.applies > 1 ? 's' : '')), stat);
        t.append(tr);
      }
      c._body.style.fontFamily = 'var(--vscode-font-family)';
      c._body.append(t, el('div', 'muted', 'Undo: Ctrl+Z in the file, “Undo” (last change) or “Revert run” above.'));
      log.append(c);
      scroll();
    }
    else if (m.type === 'commandDecided') {
      const b = log.querySelector(`[data-approval="${m.id}"]`);
      if (b) b.remove();
    }
  });

  // ---- input + @mentions ----
  function send() {
    const text = input.value.trim();
    if (!text || running) return;
    vscode.postMessage({ type: 'send', text });
    input.value = '';
    hideMentions();
  }
  function mentionToken() {
    const upto = input.value.slice(0, input.selectionStart);
    const m = /(^|\s)@([\w./\\-]*)$/.exec(upto);
    return m ? m[2] : null;
  }
  function showMentions(items) {
    mentionItems = items;
    mentionSel = 0;
    if (!items.length || mentionToken() === null) return hideMentions();
    mentionsBox.innerHTML = '';
    items.forEach((it, i) => {
      const d = el('div', i === 0 ? 'sel' : '');
      d.append(el('span', 'k', it.kind === 'file' ? 'file' : 'sym'), el('span', '', it.label));
      if (it.detail) d.append(el('span', 'k', it.detail));
      d.onmousedown = (ev) => {
        ev.preventDefault();
        pick(i);
      };
      mentionsBox.append(d);
    });
    mentionsBox.classList.remove('hidden');
  }
  function hideMentions() {
    mentionsBox.classList.add('hidden');
    mentionItems = [];
  }
  function pick(i) {
    const it = mentionItems[i];
    if (!it) return;
    const pos = input.selectionStart;
    const upto = input.value.slice(0, pos).replace(/@([\w./\\-]*)$/, '@' + it.label + ' ');
    input.value = upto + input.value.slice(pos);
    input.selectionStart = input.selectionEnd = upto.length;
    hideMentions();
    input.focus();
  }
  input.addEventListener('input', () => {
    const tok = mentionToken();
    if (tok === null) return hideMentions();
    vscode.postMessage({ type: 'mention', q: tok });
  });
  input.addEventListener('keydown', (ev) => {
    if (mentionItems.length && !mentionsBox.classList.contains('hidden')) {
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault();
        mentionSel = (mentionSel + (ev.key === 'ArrowDown' ? 1 : -1) + mentionItems.length) % mentionItems.length;
        [...mentionsBox.children].forEach((c, i) => c.classList.toggle('sel', i === mentionSel));
        return;
      }
      if (ev.key === 'Enter' || ev.key === 'Tab') {
        ev.preventDefault();
        pick(mentionSel);
        return;
      }
      if (ev.key === 'Escape') return hideMentions();
    }
    if (ev.key === 'Escape' && running) {
      vscode.postMessage({ type: 'cancel' });
      return;
    }
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      send();
    }
  });
  $('send').onclick = send;
  $('stop').onclick = () => vscode.postMessage({ type: 'cancel' });
  $('new').onclick = () => vscode.postMessage({ type: 'new' });
  $('undo').onclick = () => vscode.postMessage({ type: 'undoLast' });
  $('revert').onclick = () => vscode.postMessage({ type: 'revertRun' });
  vscode.postMessage({ type: 'ready' });
})();
