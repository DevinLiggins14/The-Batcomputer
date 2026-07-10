/* Local LLM IDE frontend */
'use strict';

const $ = (sel) => document.querySelector(sel);
const state = {
  workspace: localStorage.getItem('fc.workspace') || '',
  model: localStorage.getItem('fc.model') || 'ds4:deepseek-v4-flash',
  tabs: [], // {path, model, viewState, dirty}
  activePath: null,
  chat: [], // {role, content}
  sessionId: null,
  attachments: [], // {label, content}
  streaming: false,
  abort: null,
};
let editor = null;
let monacoReady = null;

// ---------- API helpers ----------

async function api(url, opts) {
  const r = await fetch(url, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}
const q = (obj) => new URLSearchParams(obj).toString();

function setStatus(left, right) {
  if (left !== undefined) $('#status-left').textContent = left;
  if (right !== undefined) $('#status-right').textContent = right;
}

// ---------- Monaco ----------

function initMonaco() {
  monacoReady = new Promise((resolve) => {
    require.config({ paths: { vs: '/vendor/monaco/vs' } });
    require(['vs/editor/editor.main'], () => {
      monaco.editor.defineTheme('batcave', {
        base: 'vs-dark',
        inherit: true,
        rules: [],
        colors: {
          'editor.background': '#010a13',
          'editor.lineHighlightBackground': '#051a2b',
          'editorLineNumber.foreground': '#254866',
          'editorLineNumber.activeForeground': '#4fb3ff',
          'editorCursor.foreground': '#4fb3ff',
          'editor.selectionBackground': '#10456f66',
          'editorIndentGuide.background1': '#0a2036',
        },
      });
      editor = monaco.editor.create($('#editor'), {
        theme: 'batcave',
        automaticLayout: true,
        fontSize: 13,
        minimap: { enabled: false },
        model: null,
      });
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, saveActiveFile);
      resolve();
    });
  });
}

// ---------- File tree ----------

async function loadTree() {
  const tree = $('#file-tree');
  tree.innerHTML = '';
  if (!state.workspace) return;
  await renderDir(tree, '.', 0);
}

async function renderDir(container, relPath, depth) {
  let items;
  try {
    ({ items } = await api(`/api/tree?${q({ root: state.workspace, path: relPath })}`));
  } catch (err) {
    setStatus(`tree error: ${err.message}`);
    return;
  }
  for (const item of items) {
    const itemPath = relPath === '.' ? item.name : `${relPath}/${item.name}`;
    const row = document.createElement('div');
    row.className = 'tree-item';
    row.style.paddingLeft = 6 + depth * 14 + 'px';
    row.dataset.path = itemPath;
    const icon = document.createElement('span');
    icon.className = 'icon';
    icon.textContent = item.type === 'dir' ? '▸' : '·';
    const name = document.createElement('span');
    name.textContent = item.name;
    row.append(icon, name);
    container.appendChild(row);

    if (item.type === 'dir') {
      const children = document.createElement('div');
      children.className = 'tree-children';
      container.appendChild(children);
      row.addEventListener('click', async () => {
        const open = children.classList.toggle('open');
        icon.textContent = open ? '▾' : '▸';
        if (open && !children.childElementCount) await renderDir(children, itemPath, depth + 1);
      });
    } else {
      row.addEventListener('click', () => openFile(itemPath));
    }
  }
}

// ---------- Tabs / editor ----------

function langFromPath(p) {
  return undefined; // let monaco infer from the URI
}

async function openFile(relPath) {
  await monacoReady;
  let tab = state.tabs.find((t) => t.path === relPath);
  if (!tab) {
    let content;
    try {
      ({ content } = await api(`/api/file?${q({ root: state.workspace, path: relPath })}`));
    } catch (err) {
      setStatus(`open failed: ${err.message}`);
      return;
    }
    const uri = monaco.Uri.file(`${state.workspace}/${relPath}`);
    const model = monaco.editor.getModel(uri) || monaco.editor.createModel(content, langFromPath(relPath), uri);
    tab = { path: relPath, model, viewState: null, dirty: false };
    model.onDidChangeContent(() => {
      if (!tab.dirty) { tab.dirty = true; renderTabs(); }
    });
    state.tabs.push(tab);
  }
  activateTab(relPath);
}

function activateTab(relPath) {
  const prev = state.tabs.find((t) => t.path === state.activePath);
  if (prev && editor.getModel() === prev.model) prev.viewState = editor.saveViewState();
  const tab = state.tabs.find((t) => t.path === relPath);
  if (!tab) return;
  state.activePath = relPath;
  editor.setModel(tab.model);
  if (tab.viewState) editor.restoreViewState(tab.viewState);
  editor.focus();
  $('#editor-empty').style.display = 'none';
  renderTabs();
  document.querySelectorAll('.tree-item').forEach((el) =>
    el.classList.toggle('active', el.dataset.path === relPath));
}

function closeTab(relPath) {
  const idx = state.tabs.findIndex((t) => t.path === relPath);
  if (idx < 0) return;
  const [tab] = state.tabs.splice(idx, 1);
  tab.model.dispose();
  if (state.activePath === relPath) {
    state.activePath = null;
    const next = state.tabs[idx] || state.tabs[idx - 1];
    if (next) activateTab(next.path);
    else { editor.setModel(null); $('#editor-empty').style.display = 'flex'; }
  }
  renderTabs();
}

function renderTabs() {
  const tabsEl = $('#tabs');
  tabsEl.innerHTML = '';
  for (const tab of state.tabs) {
    const el = document.createElement('div');
    el.className = 'tab' + (tab.path === state.activePath ? ' active' : '');
    const name = document.createElement('span');
    name.textContent = tab.path.split('/').pop();
    el.appendChild(name);
    if (tab.dirty) {
      const dot = document.createElement('span');
      dot.className = 'dirty';
      dot.textContent = '●';
      el.appendChild(dot);
    }
    const close = document.createElement('span');
    close.className = 'close';
    close.textContent = '✕';
    close.addEventListener('click', (e) => { e.stopPropagation(); closeTab(tab.path); });
    el.appendChild(close);
    el.title = tab.path;
    el.addEventListener('click', () => activateTab(tab.path));
    tabsEl.appendChild(el);
  }
}

async function saveActiveFile() {
  const tab = state.tabs.find((t) => t.path === state.activePath);
  if (!tab) return;
  try {
    await api('/api/file', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root: state.workspace, path: tab.path, content: tab.model.getValue() }),
    });
    tab.dirty = false;
    renderTabs();
    setStatus(`saved ${tab.path}`);
  } catch (err) {
    setStatus(`save failed: ${err.message}`);
  }
}

// Reload a file's model from disk if it's open (after agent writes).
async function refreshOpenFile(relPath) {
  const tab = state.tabs.find((t) => t.path === relPath);
  if (!tab || tab.dirty) return;
  try {
    const { content } = await api(`/api/file?${q({ root: state.workspace, path: relPath })}`);
    if (tab.model.getValue() !== content) {
      tab.model.setValue(content);
      tab.dirty = false;
      renderTabs();
    }
  } catch { /* file may have been deleted */ }
}

// ---------- Chat rendering ----------

function addUserBubble(text) {
  const el = document.createElement('div');
  el.className = 'msg user';
  el.textContent = text;
  $('#chat-messages').appendChild(el);
  scrollChat();
}

function addErrorBubble(text) {
  const el = document.createElement('div');
  el.className = 'msg error';
  el.textContent = text;
  $('#chat-messages').appendChild(el);
  scrollChat();
}

function scrollChat() {
  const box = $('#chat-messages');
  box.scrollTop = box.scrollHeight;
}

// A live assistant message that can interleave thinking, tool cards and markdown segments.
function createAssistantView() {
  const root = document.createElement('div');
  root.className = 'msg assistant';
  $('#chat-messages').appendChild(root);

  let thinkBox = null, thinkText = null;
  let mdEl = null, mdBuf = '';
  let renderQueued = false;

  const renderMd = () => {
    renderQueued = false;
    if (!mdEl) return;
    mdEl.innerHTML = marked.parse(mdBuf, { breaks: true });
    enhanceCodeBlocks(mdEl);
    scrollChat();
  };
  const queueRender = () => {
    if (!renderQueued) { renderQueued = true; requestAnimationFrame(renderMd); }
  };

  return {
    thinking(text) {
      if (!thinkBox) {
        thinkBox = document.createElement('details');
        thinkBox.className = 'thinking-box';
        thinkBox.open = true;
        const sum = document.createElement('summary');
        sum.textContent = '▸ THINKING…';
        thinkText = document.createElement('div');
        thinkText.className = 'thinking-text';
        thinkBox.append(sum, thinkText);
        root.appendChild(thinkBox);
        mdEl = null;
      }
      thinkText.textContent += text;
      thinkText.scrollTop = thinkText.scrollHeight;
      scrollChat();
    },
    token(text) {
      if (thinkBox && thinkBox.open) {
        thinkBox.open = false;
        thinkBox.querySelector('summary').textContent = '▸ THOUGHTS (CLICK TO EXPAND)';
      }
      if (!mdEl) {
        mdEl = document.createElement('div');
        root.appendChild(mdEl);
        mdBuf = '';
      }
      mdBuf += text;
      queueRender();
    },
    toolCall(name, args) {
      const card = document.createElement('div');
      card.className = 'tool-card';
      const argStr = JSON.stringify(args);
      card.innerHTML = `<span class="tool-name">» ${escapeHtml(name)}</span> <span class="tool-args"></span><pre class="tool-output">running…</pre>`;
      card.querySelector('.tool-args').textContent = argStr.length > 120 ? argStr.slice(0, 120) + '…' : argStr;
      root.appendChild(card);
      mdEl = null; // next tokens start a fresh markdown segment after the card
      thinkBox = null;
      scrollChat();
      return card;
    },
    toolResult(card, result) {
      if (card) card.querySelector('.tool-output').textContent = result;
      scrollChat();
    },
    finish() {
      renderMd();
      if (thinkBox && thinkBox.open) thinkBox.open = false;
    },
  };
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function enhanceCodeBlocks(container) {
  container.querySelectorAll('pre').forEach((pre) => {
    if (pre.parentElement.classList.contains('codeblock-wrap')) return;
    const wrap = document.createElement('div');
    wrap.className = 'codeblock-wrap';
    const actions = document.createElement('div');
    actions.className = 'codeblock-actions';
    const code = () => pre.textContent;

    const mkBtn = (label, fn) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.addEventListener('click', fn);
      actions.appendChild(b);
    };
    mkBtn('Copy', (e) => {
      navigator.clipboard.writeText(code());
      e.target.textContent = 'Copied ✓';
      setTimeout(() => (e.target.textContent = 'Copy'), 1200);
    });
    mkBtn('Insert at cursor', () => {
      if (!editor || !editor.getModel()) return setStatus('no file open');
      editor.executeEdits('chat', [{ range: editor.getSelection(), text: code(), forceMoveMarkers: true }]);
      editor.focus();
    });
    mkBtn('Replace file', () => {
      const tab = state.tabs.find((t) => t.path === state.activePath);
      if (!tab) return setStatus('no file open');
      tab.model.setValue(code());
      setStatus(`replaced contents of ${tab.path} (unsaved — ⌘S to save)`);
    });

    pre.replaceWith(wrap);
    wrap.append(actions, pre);
  });
}

// ---------- Chat send / stream ----------

function systemPrompt() {
  const agentOn = $('#agent-toggle').checked;
  let p = 'You are a coding assistant embedded in Local LLM IDE, a lightweight IDE on the user\'s Mac.';
  if (state.workspace) p += ` The current workspace folder is ${state.workspace}.`;
  if (agentOn) {
    p += ' You have tools to read/write files, list directories, and run shell commands in the workspace. ' +
      'Use them proactively to complete tasks. Paths are relative to the workspace root. ' +
      'After changing files, briefly summarize what you changed.';
  } else {
    p += ' When suggesting code changes, use fenced code blocks.';
  }
  return p;
}

async function sendChat() {
  if (state.streaming) return;
  const input = $('#chat-input');
  const text = input.value.trim();
  if (!text) return;

  let userContent = text;
  if (state.attachments.length) {
    const ctx = state.attachments
      .map((a) => `\n\n[Attached: ${a.label}]\n\`\`\`\n${a.content}\n\`\`\``)
      .join('');
    userContent += ctx;
    state.attachments = [];
    renderChips();
  }

  addUserBubble(text);
  state.chat.push({ role: 'user', content: userContent });
  input.value = '';

  const view = createAssistantView();
  const think = $('#think-select').value || false;
  const agent = $('#agent-toggle').checked;
  state.streaming = true;
  state.abort = new AbortController();
  $('#send-btn').classList.add('hidden');
  $('#stop-btn').classList.remove('hidden');
  setStatus(agent ? 'agent working…' : 'thinking…', '');

  let assistantText = '';
  let currentCard = null;
  const touchedFiles = new Set();

  try {
    const r = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: state.model,
        think,
        agent,
        workspace: state.workspace,
        messages: [{ role: 'system', content: systemPrompt() }, ...state.chat],
      }),
      signal: state.abort.signal,
    });
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const ev = JSON.parse(line);
        switch (ev.type) {
          case 'thinking': view.thinking(ev.content); break;
          case 'token': view.token(ev.content); assistantText += ev.content; break;
          case 'tool_call':
            currentCard = view.toolCall(ev.name, ev.args);
            if (ev.name === 'write_file' && ev.args?.path) touchedFiles.add(ev.args.path);
            break;
          case 'tool_result': view.toolResult(currentCard, ev.result); currentCard = null; break;
          case 'stats':
            if (ev.eval_count && ev.eval_duration) {
              const tps = (ev.eval_count / (ev.eval_duration / 1e9)).toFixed(1);
              setStatus(undefined, `${ev.eval_count} tok @ ${tps} tok/s`);
            }
            break;
          case 'error': addErrorBubble(ev.error); break;
        }
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError') addErrorBubble(String(err.message || err));
  } finally {
    view.finish();
    state.streaming = false;
    state.abort = null;
    $('#send-btn').classList.remove('hidden');
    $('#stop-btn').classList.add('hidden');
    setStatus('ready');
    if (assistantText) state.chat.push({ role: 'assistant', content: assistantText });
    saveSession();
    for (const p of touchedFiles) refreshOpenFile(p);
    if (touchedFiles.size) loadTree();
  }
}

// ---------- chat sessions ----------

async function saveSession() {
  if (!state.chat.length) return;
  if (!state.sessionId) {
    state.sessionId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
  const firstUser = state.chat.find((m) => m.role === 'user');
  const title = (firstUser?.content || 'untitled').split('\n')[0].slice(0, 60);
  try {
    await api(`/api/chats/${state.sessionId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, model: state.model, messages: state.chat }),
    });
  } catch (err) {
    setStatus(`chat save failed: ${err.message}`);
  }
}

function newChat() {
  state.chat = [];
  state.sessionId = null;
  $('#chat-messages').innerHTML = '';
  $('#chat-history').classList.add('hidden');
}

function renderStoredMessages() {
  $('#chat-messages').innerHTML = '';
  for (const m of state.chat) {
    if (m.role === 'user') {
      // strip attached-file blocks from the display copy
      addUserBubble(m.content.split('\n\n[Attached:')[0]);
    } else if (m.role === 'assistant') {
      const el = document.createElement('div');
      el.className = 'msg assistant';
      const md = document.createElement('div');
      md.innerHTML = marked.parse(m.content, { breaks: true });
      el.appendChild(md);
      enhanceCodeBlocks(md);
      $('#chat-messages').appendChild(el);
    }
  }
  scrollChat();
}

async function toggleHistory() {
  const panel = $('#chat-history');
  if (!panel.classList.contains('hidden')) {
    panel.classList.add('hidden');
    return;
  }
  panel.classList.remove('hidden');
  const list = $('#chat-history-list');
  list.innerHTML = '';
  try {
    const { chats } = await api('/api/chats');
    if (!chats.length) {
      list.innerHTML = '<div class="history-empty">NO STORED SESSIONS</div>';
      return;
    }
    for (const c of chats) {
      const item = document.createElement('div');
      item.className = 'history-item';
      const title = document.createElement('span');
      title.className = 'h-title';
      title.textContent = c.title || 'untitled';
      const meta = document.createElement('span');
      meta.className = 'h-meta';
      meta.textContent = `${c.count} msg · ${new Date(c.updatedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
      const del = document.createElement('span');
      del.className = 'h-del';
      del.textContent = '✕';
      del.title = 'Delete this chat';
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          await api(`/api/chats/${c.id}`, { method: 'DELETE' });
          item.remove();
          if (state.sessionId === c.id) newChat();
          if (!list.childElementCount) list.innerHTML = '<div class="history-empty">NO STORED SESSIONS</div>';
        } catch (err) {
          setStatus(`delete failed: ${err.message}`);
        }
      });
      item.append(title, meta, del);
      item.addEventListener('click', async () => {
        try {
          const session = await api(`/api/chats/${c.id}`);
          state.chat = session.messages || [];
          state.sessionId = session.id;
          renderStoredMessages();
          $('#chat-history').classList.add('hidden');
          setStatus(`loaded chat: ${session.title}`);
        } catch (err) {
          setStatus(`load failed: ${err.message}`);
        }
      });
      list.appendChild(item);
    }
  } catch (err) {
    list.innerHTML = `<div class="history-empty">FAILED TO LOAD: ${escapeHtml(err.message)}</div>`;
  }
}

// ---------- Attachments ----------

function renderChips() {
  const box = $('#context-chips');
  box.innerHTML = '';
  state.attachments.forEach((a, i) => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = a.label + ' ';
    const x = document.createElement('span');
    x.className = 'x';
    x.textContent = '✕';
    x.addEventListener('click', () => { state.attachments.splice(i, 1); renderChips(); });
    chip.appendChild(x);
    box.appendChild(chip);
  });
}

function attachActiveFile() {
  const tab = state.tabs.find((t) => t.path === state.activePath);
  if (!tab) return setStatus('no file open to attach');
  state.attachments.push({ label: tab.path, content: tab.model.getValue() });
  renderChips();
}

function attachSelection() {
  const tab = state.tabs.find((t) => t.path === state.activePath);
  if (!tab || !editor) return setStatus('no file open');
  const sel = editor.getSelection();
  const text = sel && editor.getModel().getValueInRange(sel);
  if (!text) return setStatus('nothing selected');
  state.attachments.push({ label: `${tab.path} (selection)`, content: text });
  renderChips();
}

// ---------- Workspace / models ----------

async function pickWorkspace() {
  let dir = null;
  if (window.localllm?.pickFolder) {
    dir = await window.localllm.pickFolder();
  } else {
    const { home } = await api('/api/home');
    dir = prompt('Workspace folder (absolute path):', state.workspace || home);
  }
  if (!dir) return;
  state.workspace = dir;
  localStorage.setItem('fc.workspace', dir);
  // Reset editor state for the new workspace
  state.tabs.forEach((t) => t.model.dispose());
  state.tabs = [];
  state.activePath = null;
  if (editor) editor.setModel(null);
  $('#editor-empty').style.display = 'flex';
  renderTabs();
  updateWsLabel();
  await loadTree();
}

function updateWsLabel() {
  const el = $('#ws-path');
  el.textContent = state.workspace ? state.workspace.replace(/^\/Users\/[^/]+/, '~') : 'no folder open';
  el.title = state.workspace;
  const name = $('#ws-name');
  name.textContent = state.workspace ? state.workspace.split('/').filter(Boolean).pop().toUpperCase() : 'NO FOLDER OPEN';
  name.title = state.workspace || '';
}

function updateModelLabel() {
  const label = state.model.startsWith('ds4:')
    ? state.model.slice(4) + ' · local'
    : state.model;
  $('#chat-model-label').textContent = label.toUpperCase();
}

async function loadModels() {
  try {
    const { models } = await api('/api/models');
    const sel = $('#model-select');
    sel.innerHTML = '';
    for (const m of models) {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = m;
      sel.appendChild(opt);
    }
    if (models.includes(state.model)) sel.value = state.model;
    else if (models.length) { state.model = models[0]; sel.value = models[0]; }
    updateModelLabel();
    sel.addEventListener('change', () => {
      state.model = sel.value;
      localStorage.setItem('fc.model', sel.value);
      updateModelLabel();
    });
  } catch (err) {
    setStatus(`Ollama unreachable: ${err.message}`);
  }
}

// ---------- drag & drop attachments ----------

const BINARY_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|icns|pdf|zip|gz|bz2|xz|tar|7z|rar|dmg|pkg|app|exe|dll|dylib|so|o|a|woff2?|ttf|otf|eot|mp[34]|m4[av]|mov|avi|mkv|wav|flac|ogg|gguf|safetensors|bin|pt|onnx|sqlite|db)$/i;

function wireDropZone() {
  const panel = $('#chat-panel');
  // stop the browser/Electron from navigating to a dropped file
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  ['dragenter', 'dragover'].forEach((ev) =>
    panel.addEventListener(ev, (e) => {
      e.preventDefault();
      panel.classList.add('dragover');
    })
  );
  panel.addEventListener('dragleave', (e) => {
    if (!panel.contains(e.relatedTarget)) panel.classList.remove('dragover');
  });
  panel.addEventListener('drop', async (e) => {
    e.preventDefault();
    panel.classList.remove('dragover');
    let attached = 0;
    for (const f of e.dataTransfer?.files || []) {
      if (f.size > 2 * 1024 * 1024) { setStatus(`${f.name}: too large to attach (>2MB)`); continue; }
      if (BINARY_EXT.test(f.name)) { setStatus(`${f.name}: binary file — can't attach as text`); continue; }
      try {
        state.attachments.push({ label: f.name, content: await f.text() });
        attached++;
      } catch (err) {
        setStatus(`${f.name}: ${err.message}`);
      }
    }
    if (attached) {
      renderChips();
      setStatus(`attached ${attached} file${attached > 1 ? 's' : ''} — sends with your next message`);
      $('#chat-input').focus();
    }
  });
}

// ---------- system HUD ----------

let ds4Status = null;
async function pollSystem() {
  try {
    const sys = await api('/api/system');
    $('#cpu-bar').style.width = sys.cpu + '%';
    $('#cpu-bar').style.background = sys.cpu > 85 ? 'var(--red)' : 'var(--accent-dim)';
    $('#cpu-val').textContent = sys.cpu + '%';
    $('#ram-bar').style.width = sys.ram + '%';
    $('#ram-bar').style.background = sys.ram > 90 ? 'var(--red)' : 'var(--accent-dim)';
    $('#ram-val').textContent = sys.ram + '%';
    $('#ram-bar').parentElement.title = `${sys.ramUsedGB} / ${sys.ramTotalGB} GB`;
    if (sys.gpu !== null) {
      $('#gpu-bar').style.width = sys.gpu + '%';
      $('#gpu-bar').style.background = sys.gpu > 85 ? 'var(--red)' : 'var(--accent-dim)';
      $('#gpu-val').textContent = sys.gpu + '%';
    } else {
      $('#gpu-val').textContent = 'n/a';
    }
  } catch { /* backend gone; leave last values */ }
  try {
    ds4Status = await api('/api/ds4/status');
    const el = $('#ds4-state');
    el.classList.remove('offline', 'loading');
    if (ds4Status.alive) {
      const ktok = ds4Status.ctx ? Math.round(ds4Status.ctx / 1000) + 'K' : '?';
      el.textContent = `ONLINE · CTX ${ktok}${ds4Status.thinkMaxCapable ? ' · TMAX' : ''}`;
    } else if (ds4Status.loading) {
      el.textContent = 'LOADING MODEL…';
      el.classList.add('loading');
    } else {
      el.textContent = 'OFFLINE';
      el.classList.add('offline');
    }
  } catch { /* ignore */ }
}

// ---------- DS4 launch config ----------

function ds4CmdPreview() {
  const ctx = $('#ds4-ctx').value || '393216';
  const power = $('#ds4-power').value;
  const extra = $('#ds4-extra').value.trim();
  let cmd = `ds4-server -m <gguf> --host 127.0.0.1 --port 8000 --kv-disk-dir ~/.ds4-server-kv --ctx ${ctx}`;
  if (power && power !== '100') cmd += ` --power ${power}`;
  if (extra) cmd += ` ${extra}`;
  $('#ds4-cmd').textContent = cmd;
}

function openDs4Modal() {
  $('#ds4-modal').classList.remove('hidden');
  const saved = JSON.parse(localStorage.getItem('fc.ds4cfg') || '{}');
  if (saved.ctx) $('#ds4-ctx').value = saved.ctx;
  if (saved.power) $('#ds4-power').value = saved.power;
  if (saved.extra) $('#ds4-extra').value = saved.extra;
  const presetSel = $('#ds4-preset');
  const match = [...presetSel.options].find((o) => o.value === String($('#ds4-ctx').value));
  presetSel.value = match ? match.value : 'custom';
  ds4CmdPreview();
  renderDs4Status();
}

function renderDs4Status() {
  const line = $('#ds4-status-line');
  if (!ds4Status) { line.textContent = 'querying server…'; return; }
  if (ds4Status.alive) {
    line.innerHTML = `<span class="online">ONLINE</span> · pid ${ds4Status.pid} · ctx ${ds4Status.ctx ?? '?'} · think max ${ds4Status.thinkMaxCapable ? 'available' : 'unavailable (ctx too small)'}<br>`;
    line.appendChild(document.createTextNode(ds4Status.args || ''));
  } else if (ds4Status.loading) {
    line.innerHTML = `<span class="online">LOADING</span> · pid ${ds4Status.pid} — model is being paged in`;
  } else {
    line.innerHTML = `<span class="offline">OFFLINE</span> — apply a configuration to launch`;
  }
}

async function applyDs4Config() {
  const cfg = {
    ctx: parseInt($('#ds4-ctx').value, 10) || 393216,
    power: parseInt($('#ds4-power').value, 10) || undefined,
    extra: $('#ds4-extra').value.trim() || undefined,
  };
  localStorage.setItem('fc.ds4cfg', JSON.stringify(cfg));
  const btn = $('#ds4-apply');
  btn.disabled = true;
  btn.textContent = 'Restarting…';
  try {
    await api('/api/ds4/restart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cfg),
    });
    setStatus('ds4-server restarting — model loading');
    // poll until it comes back
    for (let i = 0; i < 240; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      await pollSystem();
      renderDs4Status();
      if (ds4Status?.alive) break;
    }
    setStatus(ds4Status?.alive ? 'ds4-server online' : 'ds4-server still loading (see ~/.ds4-server.log)');
  } catch (err) {
    setStatus(`restart failed: ${err.message}`);
    renderDs4Status();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Apply & Restart';
  }
}

function wireDs4Modal() {
  $('#ds4-config').addEventListener('click', openDs4Modal);
  $('#ds4-cancel').addEventListener('click', () => $('#ds4-modal').classList.add('hidden'));
  $('#ds4-modal').addEventListener('click', (e) => {
    if (e.target === $('#ds4-modal')) $('#ds4-modal').classList.add('hidden');
  });
  $('#ds4-preset').addEventListener('change', (e) => {
    if (e.target.value !== 'custom') $('#ds4-ctx').value = e.target.value;
    ds4CmdPreview();
  });
  for (const id of ['#ds4-ctx', '#ds4-power', '#ds4-extra']) {
    $(id).addEventListener('input', () => {
      $('#ds4-preset').value = [...$('#ds4-preset').options].find((o) => o.value === $('#ds4-ctx').value)?.value || 'custom';
      ds4CmdPreview();
    });
  }
  $('#ds4-apply').addEventListener('click', applyDs4Config);
}

// ---------- wire up ----------

function init() {
  initMonaco();
  loadModels();
  updateWsLabel();
  if (state.workspace) loadTree();

  $('#open-folder').addEventListener('click', pickWorkspace);
  $('#send-btn').addEventListener('click', sendChat);
  $('#stop-btn').addEventListener('click', () => state.abort?.abort());
  $('#attach-file').addEventListener('click', attachActiveFile);
  $('#attach-selection').addEventListener('click', attachSelection);
  $('#clear-chat').addEventListener('click', newChat);
  $('#chat-history-btn').addEventListener('click', toggleHistory);
  $('#chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
  });
  const thinkSel = $('#think-select');
  thinkSel.value = localStorage.getItem('fc.think') || '';
  thinkSel.addEventListener('change', () => localStorage.setItem('fc.think', thinkSel.value));

  wireDs4Modal();
  wireDropZone();
  pollSystem();
  setInterval(pollSystem, 5000);
}

init();
