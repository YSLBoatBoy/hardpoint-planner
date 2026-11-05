// Hardpoint Planner server: serves the app, refreshes data on a schedule, proxies questions to Gemini.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { buildData } = require('./update');
const gemini = require('./gemini');

const PORT = +(process.env.PORT || 8080);
const DATA_DIR = process.env.DATA_DIR || '/data';
const SEED = path.join(__dirname, '..', 'seed', 'data.json');
const TEMPLATE = path.join(__dirname, '..', 'public', 'index.html');
const UPDATE_HOURS = +(process.env.UPDATE_INTERVAL_HOURS || 12);
const ASK_PER_10MIN = +(process.env.ASK_LIMIT_PER_10MIN || 30);
const DATA_FILE = path.join(DATA_DIR, 'data.json');

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------------- data ----------------
let data = null, page = null, pageEtag = '';
const updater = { running: false, lastRun: null, lastError: null, log: [] };

function loadData() {
  try { data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch (e) {
    log('no saved data yet, using the bundled snapshot');
    data = JSON.parse(fs.readFileSync(SEED, 'utf8'));
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.copyFileSync(SEED, DATA_FILE); } catch (err) { log(`cannot write ${DATA_DIR}: ${err.message}`); }
  }
  renderPage();
}
function renderPage() {
  const cfg = { ai: gemini.enabled(), ver: data.ver, gameUpdated: data.gameUpdated || null, pricesUpdated: data.pricesUpdated || null, priceSource: data.priceSource || 'snapshot' };
  const safe = s => s.replace(/</g, '\\u003c');
  page = fs.readFileSync(TEMPLATE, 'utf8')
    .replace('/*DATA*/', () => safe(JSON.stringify({ ver: data.ver, items: data.items, ships: data.ships, stores: data.stores, liveries: data.liveries || [] })))
    .replace('/*CFG*/', () => safe(JSON.stringify(cfg)));
  pageEtag = `"${Buffer.byteLength(page)}-${data.gameUpdated || ''}-${data.pricesUpdated || ''}-${cfg.ai}"`;
}

async function runUpdate(reason) {
  if (updater.running) return false;
  updater.running = true; updater.log = [];
  const ulog = m => { log(`[update] ${m}`); updater.log.push(m); };
  ulog(`starting (${reason})`);
  try {
    data = await buildData({ dataDir: DATA_DIR, log: ulog });
    renderPage();
    updater.lastError = null;
  } catch (e) {
    updater.lastError = e.message || String(e);
    ulog(`failed: ${updater.lastError}`);
  } finally {
    updater.running = false; updater.lastRun = new Date().toISOString();
  }
  return true;
}
function dataAgeHours() {
  const t = Date.parse(data.gameUpdated || 0);
  return t ? (Date.now() - t) / 3600e3 : Infinity;
}

// ---------------- helpers ----------------
function send(res, code, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function readBody(req, max = 96 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > max) { reject(new Error('too_large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now(); const arr = (hits.get(ip) || []).filter(t => now - t < 600e3);
  arr.push(now); hits.set(ip, arr);
  return arr.length > ASK_PER_10MIN;
}

// ---------------- fleet ----------------
const FLEET_FILE = path.join(DATA_DIR, 'fleet.json');
function readFleet() {
  try { return JSON.parse(fs.readFileSync(FLEET_FILE, 'utf8')); } catch (e) { return { ships: [], updated: null }; }
}
function cleanFleet(f) {
  const str = (v, n) => String(v == null ? '' : v).slice(0, n);
  const ships = (Array.isArray(f && f.ships) ? f.ships : []).slice(0, 300).map(s => {
    const picks = {};
    if (s && s.picks && typeof s.picks === 'object') for (const [k, v] of Object.entries(s.picks).slice(0, 200)) if (/^\d+$/.test(k)) picks[k] = str(v, 120);
    return { id: str(s.id, 40), cn: str(s.cn, 120), name: str(s.name, 60), livery: str(s.livery, 120), notes: str(s.notes, 500), picks, added: str(s.added, 40) };
  }).filter(s => s.id && s.cn);
  return { ships, updated: new Date().toISOString() };
}

const SYSTEM_GENERAL = 'You are a Star Citizen ship advisor inside a self-hosted fleet and loadout app. The user message contains the player\'s fleet (with their chosen parts), a stat table of every flyable ship from the game files, and full details for any ship the question names. Use that data as the source of truth and cite its numbers. When the player asks which ship to use, recommend from THEIR fleet first, then mention a better ship they don\'t own only if it is clearly better. Your own Star Citizen knowledge may be out of date: when an answer depends on things not in the data (how a ship feels to fly, the current meta, prices to buy ships, recent or upcoming changes), say so briefly. Answer directly in under 220 words. Plain text only: short paragraphs or lines starting with "- ", **bold** for key terms, no headings, no tables.';

const SYSTEM = 'You are a Star Citizen ship-fitting advisor inside a self-hosted loadout planner app. Use the game data in the user message as the source of truth and cite its numbers. Your own Star Citizen knowledge may be out of date: when an answer depends on things not in the data (how a ship feels to fly, the current meta, recent or upcoming changes), say so briefly. Answer the question directly in under 170 words. Plain text only: short paragraphs or lines starting with "- ", **bold** for key terms, no headings, no tables.';

async function handleAsk(req, res) {
  const ip = req.socket.remoteAddress || 'x';
  if (rateLimited(ip)) return send(res, 429, { code: 'rate_limited', message: 'Too many questions in a short time. Wait a few minutes and ask again.' });
  let body;
  try { body = JSON.parse(await readBody(req, 200 * 1024)); } catch (e) { return send(res, 400, { code: 'bad_request', message: 'Could not read the question.' }); }
  const question = String(body.question || '').slice(0, 2000).trim();
  const general = body.mode === 'general';
  const context = String(body.context || '').slice(0, general ? 140000 : 60000);
  if (!question) return send(res, 400, { code: 'bad_request', message: 'Type a question first.' });
  const history = Array.isArray(body.history) ? body.history.slice(-4) : [];
  const contents = [];
  for (const h of history) {
    if (!h || !h.q || !h.a) continue;
    contents.push({ role: 'user', parts: [{ text: String(h.q).slice(0, 2000) }] });
    contents.push({ role: 'model', parts: [{ text: String(h.a).slice(0, 6000) }] });
  }
  contents.push({ role: 'user', parts: [{ text: `${context}\n\nQUESTION: ${question}` }] });

  const ctl = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ctl.abort(); });
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
  const emit = ev => { if (!res.writableEnded) res.write(JSON.stringify(ev) + '\n'); };
  try {
    await gemini.ask({ system: general ? SYSTEM_GENERAL : SYSTEM, contents, model: String(body.model || 'auto'), signal: ctl.signal, emit });
  } catch (e) {
    if (ctl.signal.aborted) return;
    emit({ type: 'error', code: e.code || 'upstream_error', message: e.message || 'Something went wrong asking Gemini. Try again.' });
  }
  emit({ type: 'models', models: await gemini.modelStatus() });
  res.end();
}

// ---------------- routes ----------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      if (req.headers['if-none-match'] === pageEtag) return send(res, 304, '');
      return send(res, 200, page, 'text/html; charset=utf-8', { ETag: pageEtag, 'Cache-Control': 'no-cache' });
    }
    if (req.method === 'GET' && url.pathname === '/api/status') {
      return send(res, 200, {
        ver: data.ver, gameUpdated: data.gameUpdated || null, pricesUpdated: data.pricesUpdated || null, priceSource: data.priceSource || 'snapshot',
        updating: updater.running, lastRun: updater.lastRun, lastError: updater.lastError, ai: gemini.enabled(),
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/models') {
      return send(res, 200, { enabled: gemini.enabled(), models: await gemini.modelStatus() });
    }
    if (req.method === 'POST' && url.pathname === '/api/ask') return handleAsk(req, res);
    if (req.method === 'GET' && url.pathname === '/api/fleet') return send(res, 200, readFleet());
    if (req.method === 'PUT' && url.pathname === '/api/fleet') {
      let f;
      try { f = cleanFleet(JSON.parse(await readBody(req, 512 * 1024))); } catch (e) { return send(res, 400, { message: 'Could not read the fleet.' }); }
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(FLEET_FILE + '.tmp', JSON.stringify(f, null, 1));
      fs.renameSync(FLEET_FILE + '.tmp', FLEET_FILE);
      return send(res, 200, { ok: true, updated: f.updated, count: f.ships.length });
    }
    if (req.method === 'POST' && url.pathname === '/api/refresh') {
      if (updater.running) return send(res, 202, { started: false, message: 'An update is already running.' });
      if (updater.lastRun && Date.now() - Date.parse(updater.lastRun) < 10 * 60e3) return send(res, 429, { started: false, message: 'Data was refreshed in the last 10 minutes.' });
      runUpdate('requested from the page');
      return send(res, 202, { started: true });
    }
    if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, { ok: true });
    send(res, 404, { message: 'Not found' });
  } catch (e) {
    log(`error on ${req.method} ${url.pathname}: ${e.stack || e}`);
    if (!res.headersSent) send(res, 500, { message: 'Server error' }); else res.end();
  }
});

loadData();
server.listen(PORT, () => {
  log(`Hardpoint Planner on http://0.0.0.0:${PORT} · data ${data.ver} · AI ${gemini.enabled() ? 'on (Gemini)' : 'off (no GEMINI_API_KEY)'}`);
  if (gemini.enabled()) gemini.listModels(true).then(m => log(`Gemini models: ${m.map(x => x.id).join(', ') || 'none'}`));
  if (UPDATE_HOURS > 0) {
    if (dataAgeHours() >= UPDATE_HOURS) setTimeout(() => runUpdate('startup: data older than the update interval'), 5000);
    setInterval(() => {
      const recentFail = updater.lastError && Date.now() - Date.parse(updater.lastRun) < 3600e3; // back off an hour after a failure
      if (dataAgeHours() >= UPDATE_HOURS && !recentFail) runUpdate('scheduled');
    }, 15 * 60e3).unref();
  }
});
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { log('shutting down'); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); });
