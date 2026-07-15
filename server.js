// Local LLM IDE backend: serves the UI, exposes workspace file APIs, and proxies
// streaming chat (with an agent tool loop) to the local Ollama daemon.
const express = require('express');
const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');
const os = require('os');
const dns = require('node:dns');
const { execFile, spawn } = require('child_process');

// Prefer IPv4 — broken IPv6 routes are a classic cause of intermittent
// "fetch failed" from Node's fetch on macOS.
dns.setDefaultResultOrder?.('ipv4first');

const OLLAMA = process.env.OLLAMA_HOST_URL || 'http://127.0.0.1:11434';
// DwarfStar (ds4) — local DeepSeek V4 Flash server, fully offline.
const DS4 = {
  url: process.env.DS4_URL || 'http://127.0.0.1:8000',
  bin: process.env.DS4_BIN || `${os.homedir()}/ds4/ds4-server`,
  dir: process.env.DS4_DIR || `${os.homedir()}/ds4`,
  gguf: process.env.DS4_GGUF || 'gguf/DeepSeek-V4-Flash-IQ2XXS-w2Q2K-AProjQ8-SExpQ8-OutQ8-chat-v2-imatrix.gguf',
  // >= 393216 enables Think Max per the model card; smaller falls back to high.
  ctx: process.env.DS4_CTX || '393216',
  autoStart: process.env.DS4_AUTOSTART !== '0',
};
const DS4_PREFIX = 'ds4:';
const DEFAULT_MODEL = DS4_PREFIX + 'deepseek-v4-flash';
// DeepSeek's recommended sampling — pinned so no client default drifts.
const SAMPLING = { temperature: 1.0, top_p: 1.0 };
// LM Studio — OpenAI-compatible local server (MLX engine), e.g. Qwen3.6 NVFP4.
const LMS = { url: process.env.LMSTUDIO_URL || 'http://127.0.0.1:1234' };
const LMS_PREFIX = 'lms:';
// Hermes Agent — Nous Research's agent CLI (own tools/memory/skills), driven
// through one-shot `hermes -z` runs. It uses whatever model its own config
// points at (currently the LM Studio Qwen), so it needs LM Studio up too.
const HERMES = { bin: process.env.HERMES_BIN || `${os.homedir()}/.local/bin/hermes` };
const HERMES_PREFIX = 'hermes:';
// Qwen3.6's recommended thinking-mode sampling. LM Studio's API has no
// thinking toggle (the chat template's default — on — always applies).
const LMS_SAMPLING = { temperature: 1.0, top_p: 0.95 };

let ds4Spawned = false;
async function ds4Alive() {
  try {
    const r = await fetch(`${DS4.url}/v1/models`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

const ds4Port = () => new URL(DS4.url).port || '8000';

function spawnDs4(opts = {}) {
  const kvDir = path.join(os.homedir(), '.ds4-server-kv');
  fsSync.mkdirSync(kvDir, { recursive: true });
  const log = fsSync.openSync(path.join(os.homedir(), '.ds4-server.log'), 'a');
  const args = ['--chdir', DS4.dir, '-m', DS4.gguf, '--host', '127.0.0.1', '--port', ds4Port(),
    '--kv-disk-dir', kvDir, '--kv-disk-space-mb', '8192', '--ctx', String(opts.ctx || DS4.ctx)];
  if (opts.power) args.push('--power', String(opts.power));
  if (opts.extra) args.push(...String(opts.extra).split(/\s+/).filter(Boolean));
  const child = spawn(DS4.bin, args, { detached: true, stdio: ['ignore', log, log] });
  child.unref();
  ds4Spawned = true;
  console.log(`spawned ds4-server pid ${child.pid}: ${args.join(' ')}`);
  return child.pid;
}

// If no ds4-server is listening, launch one detached so it outlives the IDE.
async function ensureDs4() {
  if (await ds4Alive()) return 'running';
  if (!DS4.autoStart || ds4Spawned) return 'down';
  if (!fsSync.existsSync(DS4.bin)) return 'missing';
  spawnDs4();
  return 'starting';
}

// pid + args of the ds4-server: the port listener if bound, otherwise any
// ds4-server process (it loads the model BEFORE binding the port, so a
// loading server has a process but no listener).
function ds4Process() {
  return new Promise((resolve) => {
    execFile('lsof', ['-ti', `tcp:${ds4Port()}`, '-sTCP:LISTEN'], (err, out) => {
      const pid = parseInt(out, 10);
      if (pid) {
        execFile('ps', ['-p', String(pid), '-o', 'args='], (err2, args) => {
          resolve({ pid, args: (args || '').trim(), listening: true });
        });
        return;
      }
      execFile('pgrep', ['-fl', 'ds4-server'], (err3, out2) => {
        const line = (out2 || '').split('\n').find((l) => l.includes('ds4-server'));
        if (!line) return resolve(null);
        const pid2 = parseInt(line, 10);
        resolve({ pid: pid2, args: line.replace(/^\d+\s+/, '').trim(), listening: false });
      });
    });
  });
}


const app = express();
app.use(express.json({ limit: '50mb' }));
app.use('/vendor/monaco', express.static(path.join(__dirname, 'node_modules/monaco-editor/min')));
app.use('/vendor/marked', express.static(path.join(__dirname, 'node_modules/marked')));
app.use('/', express.static(path.join(__dirname, 'ui')));

// ---------- helpers ----------

const IGNORED = new Set(['.git', '.DS_Store']);

function safeResolve(root, rel) {
  if (!root) throw new Error('no workspace root provided');
  const abs = path.resolve(root, rel || '.');
  const normRoot = path.resolve(root);
  if (abs !== normRoot && !abs.startsWith(normRoot + path.sep)) {
    throw new Error(`path escapes workspace: ${rel}`);
  }
  return abs;
}

function sendErr(res, err, code = 400) {
  res.status(code).json({ error: String(err.message || err) });
}

// ---------- workspace / files ----------

app.get('/api/home', (req, res) => {
  res.json({ home: os.homedir(), cwd: process.cwd() });
});

app.get('/api/tree', async (req, res) => {
  try {
    const abs = safeResolve(req.query.root, req.query.path || '.');
    const entries = await fs.readdir(abs, { withFileTypes: true });
    const items = entries
      .filter((e) => !IGNORED.has(e.name))
      .map((e) => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' }))
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    res.json({ items });
  } catch (err) {
    sendErr(res, err);
  }
});

app.get('/api/file', async (req, res) => {
  try {
    const abs = safeResolve(req.query.root, req.query.path);
    const stat = await fs.stat(abs);
    if (stat.size > 2 * 1024 * 1024) throw new Error('file too large to open (>2MB)');
    const content = await fs.readFile(abs, 'utf8');
    res.json({ content });
  } catch (err) {
    sendErr(res, err);
  }
});

app.put('/api/file', async (req, res) => {
  try {
    const { root, path: rel, content } = req.body;
    const abs = safeResolve(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
    res.json({ ok: true });
  } catch (err) {
    sendErr(res, err);
  }
});

app.get('/api/models', async (req, res) => {
  const models = [];
  const ds4Status = await ensureDs4();
  if (ds4Status === 'running' || ds4Status === 'starting') models.push(DS4_PREFIX + 'deepseek-v4-flash');
  try {
    const r = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(1500) });
    const data = await r.json();
    for (const m of data.models || []) models.push(m.name);
  } catch { /* Ollama not running — ds4 alone is fine */ }
  try {
    const r = await fetch(`${LMS.url}/v1/models`, { signal: AbortSignal.timeout(1500) });
    const data = await r.json();
    for (const m of data.data || []) {
      if (/embed/i.test(m.id)) continue; // embedding models can't chat
      models.push(LMS_PREFIX + m.id);
    }
  } catch { /* LM Studio not running — fine */ }
  if (fsSync.existsSync(HERMES.bin)) models.push(HERMES_PREFIX + 'agent');
  res.json({ models, ds4: ds4Status });
});

// Engine status for whichever model the UI has selected.
app.get('/api/engine/status', async (req, res) => {
  const model = String(req.query.model || DEFAULT_MODEL);
  if (model.startsWith(DS4_PREFIX)) {
    const [proc, alive] = await Promise.all([ds4Process(), ds4Alive()]);
    const ctxMatch = proc?.args.match(/--ctx\s+(\d+)/);
    const ctx = ctxMatch ? parseInt(ctxMatch[1], 10) : null;
    return res.json({ engine: 'DS4', alive, loading: !!proc && !alive, ctx, thinkMaxCapable: ctx !== null && ctx >= 393216 });
  }
  if (model.startsWith(LMS_PREFIX)) {
    try {
      const r = await fetch(`${LMS.url}/v1/models`, { signal: AbortSignal.timeout(1500) });
      const d = await r.json();
      const listed = (d.data || []).some((m) => m.id === model.slice(LMS_PREFIX.length));
      return res.json({ engine: 'LM STUDIO', alive: listed, loading: false, loaded: listed, reason: listed ? '' : 'model not loaded in LM Studio' });
    } catch {
      return res.json({ engine: 'LM STUDIO', alive: false, loading: false, loaded: false, reason: 'LM Studio server not running' });
    }
  }
  if (model.startsWith(HERMES_PREFIX)) {
    const binOk = fsSync.existsSync(HERMES.bin);
    let lmsUp = false;
    try { lmsUp = (await fetch(`${LMS.url}/v1/models`, { signal: AbortSignal.timeout(1500) })).ok; } catch { /* down */ }
    return res.json({ engine: 'HERMES', alive: binOk && lmsUp, loading: false, loaded: binOk && lmsUp, reason: binOk ? (lmsUp ? '' : 'needs LM Studio running') : 'hermes binary missing' });
  }
  try {
    const [tagsR, psR] = await Promise.all([
      fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(1500) }),
      fetch(`${OLLAMA}/api/ps`, { signal: AbortSignal.timeout(1500) }),
    ]);
    const tags = await tagsR.json();
    const ps = await psR.json();
    const installed = (tags.models || []).some((m) => m.name === model);
    res.json({
      engine: 'OLLAMA',
      alive: installed,
      loading: false,
      loaded: (ps.models || []).some((m) => m.name === model),
      reason: installed ? '' : 'model not installed in Ollama',
    });
  } catch {
    res.json({ engine: 'OLLAMA', alive: false, loading: false, loaded: false, reason: 'Ollama daemon not running' });
  }
});

app.get('/api/ds4/status', async (req, res) => {
  const [proc, alive] = await Promise.all([ds4Process(), ds4Alive()]);
  const ctxMatch = proc?.args.match(/--ctx\s+(\d+)/);
  const ctx = ctxMatch ? parseInt(ctxMatch[1], 10) : null;
  res.json({
    alive,
    loading: !!proc && !alive,
    pid: proc?.pid || null,
    args: proc?.args || null,
    ctx,
    thinkMaxCapable: ctx !== null && ctx >= 393216,
  });
});

// Restart ds4-server with a new launch configuration: kills the ds4-server
// that owns the port, then spawns a fresh detached one with the new flags.
app.post('/api/ds4/restart', async (req, res) => {
  try {
    const { ctx, power, extra } = req.body || {};
    if (!fsSync.existsSync(DS4.bin)) throw new Error(`ds4-server binary not found at ${DS4.bin}`);
    const proc = await ds4Process();
    if (proc && !/ds4-server/.test(proc.args)) {
      throw new Error(`port ${ds4Port()} is held by a non-ds4 process (pid ${proc.pid}); not touching it`);
    }
    if (proc) {
      process.kill(proc.pid, 'SIGTERM');
      for (let i = 0; i < 30 && (await ds4Process()); i++) {
        await new Promise((r) => setTimeout(r, 500));
      }
      if (await ds4Process()) throw new Error('old ds4-server did not release the port');
    }
    const pid = spawnDs4({ ctx, power, extra });
    res.json({ ok: true, pid });
  } catch (err) {
    sendErr(res, err, 500);
  }
});

// True CPU %: diff cumulative per-core tick counters between polls.
let lastCpuTimes = null;
function cpuPercent() {
  const now = os.cpus().map((c) => c.times);
  let pct = Math.min(100, Math.round((os.loadavg()[0] / now.length) * 100)); // first-call fallback
  if (lastCpuTimes) {
    let busy = 0, total = 0;
    for (let i = 0; i < now.length; i++) {
      const a = lastCpuTimes[i], b = now[i];
      const dBusy = b.user - a.user + (b.nice - a.nice) + (b.sys - a.sys) + (b.irq - a.irq);
      const dTotal = dBusy + (b.idle - a.idle);
      busy += dBusy; total += dTotal;
    }
    if (total > 0) pct = Math.round((busy / total) * 100);
  }
  lastCpuTimes = now;
  return pct;
}

const run = (cmd, args) => new Promise((r) => execFile(cmd, args, (err, out) => r(err ? '' : out)));

app.get('/api/system', async (req, res) => {
  const total = os.totalmem();
  const cpu = cpuPercent();
  // vm_stat gives real pressure; os.freemem() would count file cache as used.
  // ioreg exposes Apple Silicon GPU utilization without sudo.
  const [vm, accel] = await Promise.all([
    run('vm_stat', []),
    run('ioreg', ['-r', '-d', '1', '-w', '0', '-c', 'IOAccelerator']),
  ]);
  let used = total - os.freemem();
  if (vm) {
    const page = parseInt(vm.match(/page size of (\d+)/)?.[1] || '16384', 10);
    const grab = (label) => parseInt(vm.match(new RegExp(`${label}:\\s+(\\d+)`))?.[1] || '0', 10);
    used = (grab('Pages active') + grab('Pages wired down') + grab('Pages occupied by compressor')) * page;
  }
  const gpuMatch = accel.match(/"Device Utilization %"=(\d+)/);
  res.json({
    cpu,
    gpu: gpuMatch ? parseInt(gpuMatch[1], 10) : null,
    ram: Math.round((used / total) * 100),
    ramUsedGB: +(used / 1e9).toFixed(1),
    ramTotalGB: Math.round(total / 1e9),
  });
});

// ---------- git ----------

function git(root, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', root, ...args], { maxBuffer: 8 * 1024 * 1024, timeout: opts.timeout || 15000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).trim().slice(0, 400)));
      resolve(stdout);
    });
  });
}

app.post('/api/git/clone', async (req, res) => {
  try {
    const url = String(req.body.url || '').trim();
    if (!/^(https:\/\/|git@|ssh:\/\/)[\w.@:/~+-]+$/.test(url)) throw new Error('that does not look like a git URL');
    const name = (url.split('/').pop() || 'repo').replace(/\.git$/, '') || 'repo';
    let dest = path.join(os.homedir(), 'Downloads', name);
    for (let n = 1; fsSync.existsSync(dest); n++) dest = path.join(os.homedir(), 'Downloads', `${name}-${n}`);
    await new Promise((resolve, reject) => {
      execFile('git', ['clone', url, dest], { timeout: 300000, maxBuffer: 8 * 1024 * 1024 }, (err, so, se) =>
        err ? reject(new Error((se || err.message).trim().slice(0, 400))) : resolve());
    });
    res.json({ ok: true, path: dest });
  } catch (err) {
    sendErr(res, err);
  }
});

app.get('/api/git/status', async (req, res) => {
  try {
    const root = String(req.query.root || '');
    if (!root) return res.json({ isRepo: false });
    const inside = await git(root, ['rev-parse', '--is-inside-work-tree']).catch(() => '');
    if (!inside.trim()) return res.json({ isRepo: false });
    const out = await git(root, ['status', '--porcelain=v1', '-b']);
    const lines = out.split('\n').filter(Boolean);
    let branch = '', ahead = 0, behind = 0;
    if (lines[0]?.startsWith('## ')) {
      const b = lines.shift().slice(3);
      branch = b.split('...')[0].trim();
      ahead = +(b.match(/ahead (\d+)/)?.[1] || 0);
      behind = +(b.match(/behind (\d+)/)?.[1] || 0);
    }
    const files = lines.map((l) => {
      const x = l[0], y = l[1];
      let p = l.slice(3);
      if (p.includes(' -> ')) p = p.split(' -> ')[1];
      p = p.replace(/^"|"$/g, '');
      return { path: p, status: x === '?' ? 'U' : (x !== ' ' ? x : y) };
    });
    res.json({ isRepo: true, branch, ahead, behind, files });
  } catch (err) {
    sendErr(res, err);
  }
});

// Working-tree file vs HEAD, for the Monaco diff editor.
app.get('/api/git/diff', async (req, res) => {
  try {
    const root = String(req.query.root || '');
    const rel = String(req.query.path || '');
    const abs = safeResolve(root, rel);
    // HEAD:./path resolves relative to -C root, so subdirectory workspaces work
    const original = await git(root, ['show', `HEAD:./${rel}`]).catch(() => ''); // empty = new/untracked
    let modified = '';
    try { modified = await fs.readFile(abs, 'utf8'); } catch { /* deleted from working tree */ }
    const clean = (s) => (s.includes('\u0000') ? '[binary file]' : s.slice(0, 2_000_000));
    res.json({ original: clean(original), modified: clean(modified) });
  } catch (err) {
    sendErr(res, err);
  }
});

// ---------- chat sessions (persisted to disk) ----------

const CHATS_DIR = path.join(os.homedir(), '.local-llm-ide', 'chats');
fsSync.mkdirSync(CHATS_DIR, { recursive: true });

function chatFile(id) {
  if (!/^[a-z0-9-]{1,64}$/i.test(id)) throw new Error('invalid chat id');
  return path.join(CHATS_DIR, `${id}.json`);
}

app.get('/api/chats', async (req, res) => {
  try {
    const files = (await fs.readdir(CHATS_DIR)).filter((f) => f.endsWith('.json'));
    const chats = [];
    let totalBytes = 0;
    for (const f of files) {
      try {
        const file = path.join(CHATS_DIR, f);
        const data = JSON.parse(await fs.readFile(file, 'utf8'));
        totalBytes += (await fs.stat(file)).size;
        chats.push({ id: data.id, title: data.title, updatedAt: data.updatedAt, model: data.model, count: (data.messages || []).length });
      } catch { /* skip corrupt file */ }
    }
    chats.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    res.json({ chats, totalBytes });
  } catch (err) {
    sendErr(res, err);
  }
});

// Delete ALL stored chats.
app.delete('/api/chats', async (req, res) => {
  try {
    const files = (await fs.readdir(CHATS_DIR)).filter((f) => f.endsWith('.json'));
    await Promise.all(files.map((f) => fs.unlink(path.join(CHATS_DIR, f))));
    res.json({ ok: true, deleted: files.length });
  } catch (err) {
    sendErr(res, err);
  }
});

app.get('/api/chats/:id', async (req, res) => {
  try {
    res.json(JSON.parse(await fs.readFile(chatFile(req.params.id), 'utf8')));
  } catch (err) {
    sendErr(res, err, 404);
  }
});

app.put('/api/chats/:id', async (req, res) => {
  try {
    const file = chatFile(req.params.id);
    let createdAt = Date.now();
    try { createdAt = JSON.parse(await fs.readFile(file, 'utf8')).createdAt || createdAt; } catch { /* new chat */ }
    const { title, model, messages } = req.body;
    await fs.writeFile(file, JSON.stringify({ id: req.params.id, title, model, messages, createdAt, updatedAt: Date.now() }));
    res.json({ ok: true });
  } catch (err) {
    sendErr(res, err);
  }
});

app.delete('/api/chats/:id', async (req, res) => {
  try {
    await fs.unlink(chatFile(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    sendErr(res, err, 404);
  }
});

// ---------- web tools (always available — the model is offline, the Mac isn't) ----------

const WEB_TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        'Search the live web. Use for anything time-sensitive or uncertain: schedules, news, prices, versions, docs. ' +
        'Write SHORT keyword queries (3-7 words, no quote marks). Returns titles, URLs, and snippets.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Short keyword query, e.g. "England Norway kickoff time"' },
          freshness: {
            type: 'string',
            enum: ['day', 'week', 'month'],
            description: "Restrict results by age. Use 'day' for today's events, schedules, scores; 'week' for recent news.",
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_url',
      description: 'Fetch a web page and return its readable text content. Use after web_search to read a promising result.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'The http(s) URL to fetch' } },
        required: ['url'],
      },
    },
  },
];

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(+d))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ');
}

function htmlToText(html) {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<\/(p|div|h[1-6]|li|tr|section|article)>/gi, '\n')
      .replace(/<(br|hr)[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function assertPublicHttpUrl(raw) {
  const u = new URL(raw);
  if (!/^https?:$/.test(u.protocol)) throw new Error('only http/https URLs are allowed');
  if (/^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|\[?::1)/.test(u.hostname) || u.hostname.endsWith('.local')) {
    throw new Error('local/private addresses are not fetchable');
  }
  return u;
}

const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const errCode = (err) => err.cause?.code || err.cause?.message || err.message;

async function engineFetch(url) {
  const r = await fetch(url, {
    headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'en-US,en;q=0.9' },
    signal: AbortSignal.timeout(12000),
    redirect: 'follow',
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return await r.text();
}

function decodeDdgHref(url) {
  const uddg = url.match(/[?&]uddg=([^&]+)/);
  return uddg ? decodeURIComponent(uddg[1]) : url;
}

// Long quoted queries make scraped engines return keyword soup — keep it short and bare.
function sanitizeQuery(q) {
  return String(q).replace(/["'“”‘’]/g, ' ').replace(/\s+/g, ' ').trim().split(' ').slice(0, 10).join(' ');
}

function assertNotChallenged(html) {
  if (/anomaly|challenge-form|captcha|unusual traffic|verify you are human/i.test(html)) {
    throw new Error('engine bot-challenged us');
  }
}

const FRESH_DDG = { day: 'd', week: 'w', month: 'm' };
const FRESH_BING = { day: 'ez1', week: 'ez2', month: 'ez3' };

async function searchDdgHtml(query, freshness) {
  const df = FRESH_DDG[freshness] ? `&df=${FRESH_DDG[freshness]}` : '';
  const html = await engineFetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}${df}`);
  assertNotChallenged(html);
  const links = [...html.matchAll(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)]
    .map((m) => ({ url: decodeDdgHref(m[1]), title: htmlToText(m[2]) }));
  const snips = [...html.matchAll(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => htmlToText(m[1]));
  return links.slice(0, 6).map((l, i) => `${i + 1}. ${l.title}\n   ${l.url}\n   ${snips[i] || ''}`);
}

async function searchMojeek(query) {
  const html = await engineFetch(`https://www.mojeek.com/search?q=${encodeURIComponent(query)}`);
  assertNotChallenged(html);
  const links = [...html.matchAll(/<h2><a[^>]*class="title"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)]
    .map((m) => ({ url: m[1], title: htmlToText(m[2]) }));
  const snips = [...html.matchAll(/<p class="s">([\s\S]*?)<\/p>/g)].map((m) => htmlToText(m[1]));
  return links.slice(0, 6).map((l, i) => `${i + 1}. ${l.title}\n   ${l.url}\n   ${snips[i] || ''}`);
}

// Bing wraps result links in a redirect: /ck/a?...&u=a1<url-safe base64>.
function decodeBingHref(url) {
  url = decodeEntities(url);
  const m = url.match(/[?&]u=a1([^&]+)/);
  if (m) {
    try {
      let b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      const decoded = Buffer.from(b64, 'base64').toString('utf8');
      if (/^https?:\/\//.test(decoded)) return decoded;
    } catch { /* keep redirect url */ }
  }
  return url;
}

async function searchBing(query, freshness) {
  const fr = FRESH_BING[freshness] ? `&filters=ex1%3a%22${FRESH_BING[freshness]}%22` : '';
  const html = await engineFetch(`https://www.bing.com/search?q=${encodeURIComponent(query)}&count=8${fr}`);
  assertNotChallenged(html);
  const blocks = html.split(/<li class="b_algo"/).slice(1, 7);
  return blocks
    .map((b, i) => {
      const a = b.match(/<h2[^>]*><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
      if (!a) return null;
      const p = b.match(/<p[^>]*>([\s\S]*?)<\/p>/);
      return `${i + 1}. ${htmlToText(a[2])}\n   ${decodeBingHref(a[1])}\n   ${p ? htmlToText(p[1]).slice(0, 300) : ''}`;
    })
    .filter(Boolean);
}

// Three independent engines in preference order, each tried twice with
// backoff — but a bot-challenge skips straight to the next engine (retrying
// a challenge just digs the hole deeper).
async function webSearch(query, freshness) {
  const q = sanitizeQuery(query);
  const engines = [searchDdgHtml, searchBing, searchMojeek];
  const errors = [];
  for (const engine of engines) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const results = await engine(q, freshness);
        if (results.length) return results.join('\n\n');
        errors.push(`${engine.name}: no results parsed`);
        break; // parsed fine but empty — try next engine, not same one again
      } catch (err) {
        errors.push(`${engine.name}: ${errCode(err)}`);
        if (/challenged/.test(err.message)) break;
        await new Promise((r) => setTimeout(r, 350 * (attempt + 1)));
      }
    }
  }
  console.warn('web_search exhausted:', errors.join(' | '));
  return `Search is unreachable right now (${errors.slice(-3).join('; ')}). Tell the user rather than guessing.`;
}

async function fetchUrl(raw) {
  const u = assertPublicHttpUrl(raw);
  let r, lastErr;
  for (let attempt = 0; attempt < 3 && !r; attempt++) {
    try {
      r = await fetch(u, {
        headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.5' },
        signal: AbortSignal.timeout(20000),
        redirect: 'follow',
      });
    } catch (err) {
      lastErr = err;
      await new Promise((res) => setTimeout(res, 400 * (attempt + 1)));
    }
  }
  if (!r) throw new Error(`could not reach ${u.hostname}: ${errCode(lastErr)}`);
  const type = r.headers.get('content-type') || '';
  if (!/text\/|json|xml/.test(type)) throw new Error(`unsupported content-type: ${type}`);
  let body = await r.text();
  if (body.length > 800_000) body = body.slice(0, 800_000);
  const text = /html/.test(type) ? htmlToText(body) : body;
  const out = text.slice(0, 10_000);
  return `[${r.status}] ${u.href}\n\n${out}${text.length > 10_000 ? '\n… [truncated]' : ''}`;
}

// Direct search access for diagnostics (and future UI use): /api/search?q=…
app.get('/api/search', async (req, res) => {
  try {
    const q = String(req.query.q || '');
    if (!q) throw new Error('missing q');
    const engine = { html: searchDdgHtml, bing: searchBing, mojeek: searchMojeek }[req.query.engine];
    const results = engine ? (await engine(q, req.query.freshness)).join('\n\n') : await webSearch(q, req.query.freshness);
    res.type('text/plain').send(results);
  } catch (err) {
    sendErr(res, err, 502);
  }
});

// ---------- agent tools ----------

const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a text file from the workspace. Path is relative to the workspace root.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Relative path of the file to read' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create or overwrite a text file in the workspace. Path is relative to the workspace root.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path of the file to write' },
          content: { type: 'string', description: 'Full new content of the file' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description: 'List files and subdirectories at a path relative to the workspace root.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Relative directory path, "." for the root' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description:
        'Run a shell command with the workspace root as the working directory. Returns stdout and stderr. 120s timeout.',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string', description: 'The shell command to run' } },
        required: ['command'],
      },
    },
  },
];

function requireArg(args, key, { allowEmpty = false } = {}) {
  const v = args?.[key];
  if (typeof v !== 'string' || (!allowEmpty && !v.trim())) {
    const got = Object.keys(args || {}).join(', ') || 'none';
    throw new Error(`missing required parameter "${key}" (got parameters: ${got}) — retry with the correct parameter name`);
  }
  return v;
}

async function runTool(name, args, workspace) {
  switch (name) {
    case 'web_search':
      return await webSearch(requireArg(args, 'query'), args.freshness);
    case 'fetch_url':
      return await fetchUrl(requireArg(args, 'url'));
    case 'read_file': {
      const abs = safeResolve(workspace, requireArg(args, 'path'));
      return await fs.readFile(abs, 'utf8');
    }
    case 'write_file': {
      const abs = safeResolve(workspace, requireArg(args, 'path'));
      requireArg(args, 'content', { allowEmpty: true });
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, args.content, 'utf8');
      return `wrote ${args.content.length} chars to ${args.path}`;
    }
    case 'list_directory': {
      const abs = safeResolve(workspace, args.path || '.');
      const entries = await fs.readdir(abs, { withFileTypes: true });
      return entries
        .filter((e) => !IGNORED.has(e.name))
        .map((e) => (e.isDirectory() ? e.name + '/' : e.name))
        .join('\n');
    }
    case 'run_command': {
      requireArg(args, 'command');
      return await new Promise((resolve) => {
        execFile(
          '/bin/zsh',
          ['-lc', args.command],
          { cwd: workspace, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
          (err, stdout, stderr) => {
            let out = '';
            if (stdout) out += stdout;
            if (stderr) out += (out ? '\n--- stderr ---\n' : '') + stderr;
            if (err && err.killed) out += '\n[command timed out after 120s]';
            else if (err && err.code) out += `\n[exit code ${err.code}]`;
            resolve(out || '[no output]');
          }
        );
      });
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

// ---------- chat (streaming NDJSON to the client) ----------

// One Ollama /api/chat round. Streams tokens to `emit`, returns the final
// assistant message (content + thinking + any tool calls).
async function ollamaRound(payload, emit, signal) {
  const attempt = async (body) =>
    fetch(`${OLLAMA}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });

  let r = await attempt(payload);
  if (!r.ok) {
    let errText = await r.text();
    // Some model/server combos want boolean think, or none at all — degrade gracefully.
    if (payload.think !== undefined && /think/i.test(errText)) {
      const fallback = { ...payload, think: !!payload.think };
      r = await attempt(fallback);
      if (!r.ok) {
        delete fallback.think;
        r = await attempt(fallback);
      }
      if (!r.ok) errText = await r.text();
    }
    // Models without tool support: retry the round without tools.
    if (!r.ok && payload.tools && /tool/i.test(errText)) {
      const fallback = { ...payload };
      delete fallback.tools;
      r = await attempt(fallback);
      if (!r.ok) errText = await r.text();
    }
    if (!r.ok) throw new Error(`Ollama error ${r.status}: ${errText.slice(0, 400)}`);
  }

  const msg = { role: 'assistant', content: '', thinking: '', tool_calls: [] };
  let buf = '';
  for await (const chunk of r.body) {
    buf += Buffer.from(chunk).toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const data = JSON.parse(line);
      if (data.error) throw new Error(data.error);
      const m = data.message || {};
      if (m.thinking) {
        msg.thinking += m.thinking;
        emit({ type: 'thinking', content: m.thinking });
      }
      if (m.content) {
        msg.content += m.content;
        emit({ type: 'token', content: m.content });
      }
      if (m.tool_calls) msg.tool_calls.push(...m.tool_calls);
      if (data.done) {
        emit({
          type: 'stats',
          eval_count: data.eval_count,
          eval_duration: data.eval_duration,
          prompt_eval_count: data.prompt_eval_count,
        });
      }
    }
  }
  return msg;
}

// One OpenAI-compatible /v1/chat/completions round over SSE (ds4-server and
// LM Studio both speak this). Streams tokens/thinking to `emit`, returns the
// final assistant message with OpenAI-format tool calls.
async function openAiRound(base, label, body, emit, signal) {
  const r = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!r.ok) throw new Error(`${label} error ${r.status}: ${(await r.text()).slice(0, 400)}`);

  const msg = { role: 'assistant', content: '', thinking: '', tool_calls: [] };
  const started = Date.now();
  let buf = '';
  for await (const chunk of r.body) {
    buf += Buffer.from(chunk).toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      const ev = JSON.parse(data);
      if (ev.error) throw new Error(ev.error.message || JSON.stringify(ev.error));
      const delta = ev.choices?.[0]?.delta || {};
      if (delta.reasoning_content) {
        msg.thinking += delta.reasoning_content;
        emit({ type: 'thinking', content: delta.reasoning_content });
      }
      if (delta.content) {
        msg.content += delta.content;
        emit({ type: 'token', content: delta.content });
      }
      for (const tc of delta.tool_calls || []) {
        const slot = (msg.tool_calls[tc.index] ||= { id: tc.id, type: 'function', function: { name: '', arguments: '' } });
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.function.name = tc.function.name;
        if (tc.function?.arguments) slot.function.arguments += tc.function.arguments;
      }
      if (ev.usage) {
        emit({
          type: 'stats',
          eval_count: ev.usage.completion_tokens,
          eval_duration: (Date.now() - started) * 1e6, // approx; includes prefill
          prompt_eval_count: ev.usage.prompt_tokens,
        });
      }
    }
  }
  msg.tool_calls = msg.tool_calls.filter(Boolean);
  return msg;
}

async function ds4Round(payload, emit, signal) {
  const body = {
    model: 'deepseek-v4-flash',
    messages: payload.messages,
    stream: true,
    stream_options: { include_usage: true },
    ...SAMPLING, // ignored by the server in thinking mode, applied in non-think
  };
  // Server default is high-effort thinking; map the UI's three modes.
  if (payload.think === false || payload.think === undefined) body.think = false;
  else if (payload.think === 'max') body.reasoning_effort = 'max';
  if (payload.tools) body.tools = payload.tools;
  return openAiRound(DS4.url, 'ds4-server', body, emit, signal);
}

async function lmsRound(payload, emit, signal) {
  const body = {
    model: payload.model,
    messages: payload.messages,
    stream: true,
    stream_options: { include_usage: true },
    ...LMS_SAMPLING,
  };
  if (payload.tools) body.tools = payload.tools;
  return openAiRound(LMS.url, 'LM Studio', body, emit, signal);
}

// Hermes runs one agent turn per `-z` invocation and only prints the final
// answer, so prior turns are inlined into the prompt to keep the chat coherent
// (Hermes named sessions don't carry -z context across runs).
function hermesPrompt(messages) {
  const last = messages[messages.length - 1]?.content || '';
  const hist = messages.slice(0, -1).filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content);
  if (!hist.length) return last;
  const lines = hist.map((m) => `${m.role === 'user' ? 'User' : 'You'}: ${m.content}`);
  return `Conversation so far:\n${lines.join('\n\n')}\n\nUser's new message (respond to this one):\n${last}`;
}

// --yolo mirrors the IDE's own agent mode, where tools run without per-call
// approval. stdout in non-TTY mode is the final answer only — no streaming.
function hermesRound(messages, workspace, emit, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(HERMES.bin, ['--yolo', '-z', hermesPrompt(messages)], {
      cwd: workspace || os.homedir(),
      env: { ...process.env, NO_COLOR: '1' },
    });
    emit({ type: 'thinking', content: '[hermes agent is working — tools may run before the answer appears]\n' });
    let out = '';
    let err = '';
    const onAbort = () => child.kill('SIGTERM');
    signal.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => reject(new Error(`hermes failed to start: ${e.message}`)));
    child.on('close', (code) => {
      signal.removeEventListener('abort', onAbort);
      if (signal.aborted) return resolve('');
      const clean = out.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim();
      if (!clean && code !== 0) return reject(new Error(`hermes exited ${code}: ${err.trim().slice(0, 300)}`));
      emit({ type: 'token', content: clean || '[hermes returned no output]' });
      resolve(clean);
    });
  });
}

app.post('/api/chat', async (req, res) => {
  const { messages, model = DEFAULT_MODEL, think = false, agent = false, workspace } = req.body;
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  const emit = (obj) => res.write(JSON.stringify(obj) + '\n');

  const abort = new AbortController();
  // res 'close' fires on client disconnect; req 'close' would fire as soon as
  // the request body is consumed (Node 16+), aborting every call instantly.
  res.on('close', () => {
    if (!res.writableEnded) abort.abort();
  });

  try {
    // Hermes is a whole agent, not a model: hand it the conversation and let
    // it run its own tool loop; the IDE's tools stay out of the way.
    if (model.startsWith(HERMES_PREFIX)) {
      await hermesRound(messages, workspace, emit, abort.signal);
      emit({ type: 'done' });
      return;
    }
    const isDs4 = model.startsWith(DS4_PREFIX);
    const isLms = model.startsWith(LMS_PREFIX);
    const openAiHistory = isDs4 || isLms; // both keep OpenAI-format tool history
    const convo = [...messages];
    // Web tools ride along on every request; file/shell tools only in agent mode.
    const allTools = [...WEB_TOOL_DEFS, ...(agent && workspace ? TOOL_DEFS : [])];
    // Loop guards: dedupe repeated searches, and past the budget stop offering
    // tools entirely so the model must answer with what it has.
    const searchesSeen = new Set();
    const fetchesSeen = new Set();
    const MAX_SEARCHES = 5;
    const TOOL_ROUNDS = agent && workspace ? 24 : 8;
    const normQuery = (q) => sanitizeQuery(q).toLowerCase().split(' ').sort().join(' ');

    for (let round = 0; round < 25; round++) {
      const tools = round < TOOL_ROUNDS ? allTools : undefined;
      const offered = new Set((tools || []).map((t) => t.function.name));
      const msg = isDs4
        ? await ds4Round({ messages: convo, think, tools }, emit, abort.signal)
        : isLms
          ? await lmsRound({ model: model.slice(LMS_PREFIX.length), messages: convo, tools }, emit, abort.signal)
          : await ollamaRound(
              { model, stream: true, options: { ...SAMPLING }, think, tools, messages: convo },
              emit, abort.signal
            );
      if (!msg.tool_calls.length) break;

      if (openAiHistory) {
        // OpenAI-format history; keep the server-issued ids so ds4's exact
        // DSML replay can reuse its KV cache.
        convo.push({ role: 'assistant', content: msg.content || null, tool_calls: msg.tool_calls });
      } else {
        convo.push({ role: 'assistant', content: msg.content, thinking: msg.thinking || undefined, tool_calls: msg.tool_calls });
      }
      for (const tc of msg.tool_calls) {
        const name = tc.function?.name;
        let args = tc.function?.arguments;
        if (typeof args === 'string') {
          try { args = JSON.parse(args); } catch { args = {}; }
        }
        emit({ type: 'tool_call', name, args });
        let result;
        try {
          if (!offered.has(name)) {
            result = TOOL_DEFS.some((t) => t.function.name === name)
              ? `ERROR: "${name}" is not available right now — file and shell tools require Agent mode ON and a workspace folder open. ` +
                'Tell the user to click Open Folder (and enable the Agent toggle), then try again. Do not retry until they have.'
              : `ERROR: "${name}" is not a tool that exists here. Available tools: ${[...offered].join(', ') || 'none this round'}.`;
          } else if (name === 'web_search') {
            const norm = normQuery(args?.query || '');
            if (searchesSeen.has(norm)) {
              result = 'DUPLICATE SEARCH — you already ran an equivalent query in this turn and the results will not change. ' +
                'Do NOT search again. Answer from the results you already have, or if the question is ambiguous, ask the user to clarify.';
            } else if (searchesSeen.size >= MAX_SEARCHES) {
              result = `SEARCH LIMIT REACHED (${MAX_SEARCHES} searches this turn). Do NOT search again. ` +
                'Answer from what you have, state what you could not confirm, or ask the user to clarify.';
            } else {
              searchesSeen.add(norm);
              result = await runTool(name, args || {}, workspace);
            }
          } else if (name === 'fetch_url' && fetchesSeen.has(String(args?.url || '').trim())) {
            result = 'DUPLICATE FETCH — you already fetched this exact URL this turn. Reuse that content instead of fetching again.';
          } else {
            if (name === 'fetch_url') fetchesSeen.add(String(args?.url || '').trim());
            result = await runTool(name, args || {}, workspace);
          }
        } catch (err) {
          result = `ERROR: ${err.message}`;
        }
        const preview = result.length > 1500 ? result.slice(0, 1500) + `\n… [${result.length} chars total]` : result;
        emit({ type: 'tool_result', name, result: preview });
        if (openAiHistory) convo.push({ role: 'tool', tool_call_id: tc.id, content: String(result) });
        else convo.push({ role: 'tool', tool_name: name, name, content: String(result) });
      }
    }
    emit({ type: 'done' });
  } catch (err) {
    if (!abort.signal.aborted) emit({ type: 'error', error: String(err.message || err) });
  } finally {
    res.end();
  }
});

const PORT = process.env.PORT || 4517;
if (require.main === module) {
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`Local LLM IDE running at http://127.0.0.1:${PORT}`);
  });
}
module.exports = { app, PORT };
