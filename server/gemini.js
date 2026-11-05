// Gemini access with automatic fallback: when a model hits its quota or is overloaded,
// it is put on cooldown and the next available model answers instead.
'use strict';

const API = (process.env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');
const KEY = process.env.GEMINI_API_KEY || '';
const PREFERRED = (process.env.GEMINI_MODELS || '').split(',').map(s => s.trim().replace(/^models\//, '')).filter(Boolean);
const FALLBACK_LIST = ['gemini-flash-latest', 'gemini-flash-lite-latest', 'gemini-pro-latest'];
const MAX_TOKENS = +(process.env.GEMINI_MAX_OUTPUT_TOKENS || 2048);
// Models that can't answer text questions (image, speech, live audio, embeddings, …)
const NOT_TEXT = /(image|tts|live|transcribe|embed|translate|banana|audio|aqa|robotics|computer-use|veo|imagen|learnlm|gemma)/i;

let models = [];          // [{ id, label }]
let listedAt = 0;
const cooldown = {};      // id → { until: ms, reason: 'daily'|'busy'|'unavailable', message }

const enabled = () => !!KEY;

function rank(id) {
  // lower sorts first: preferred list, then flash > flash-lite > pro > other, stable before preview, newer first
  const p = PREFERRED.indexOf(id);
  if (p >= 0) return [0, p, 0, 0];
  const tier = /flash-lite/.test(id) ? 1 : /flash/.test(id) ? 0 : /pro/.test(id) ? 2 : 3;
  const preview = /preview|exp|experimental/.test(id) ? 1 : 0;
  const ver = parseFloat((/gemini-(\d+(?:\.\d+)?)/.exec(id) || [])[1] || (/latest/.test(id) ? '99' : '0'));
  return [1, tier, preview, -ver];
}
const cmp = (a, b) => { const x = rank(a.id), y = rank(b.id); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i]; return a.id.localeCompare(b.id); };

async function listModels(force) {
  if (!enabled()) return [];
  if (!force && models.length && Date.now() - listedAt < 6 * 3600e3) return models;
  try {
    const res = await fetch(`${API}/models?pageSize=1000`, { headers: { 'x-goog-api-key': KEY }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    let list = (j.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => ({ id: m.name.replace(/^models\//, ''), label: m.displayName || m.name.replace(/^models\//, '') }))
      .filter(m => /gemini/i.test(m.id) && !NOT_TEXT.test(m.id));
    if (PREFERRED.length) {
      const pref = list.filter(m => PREFERRED.includes(m.id));
      if (pref.length) list = pref; // only offer the models the user chose
    }
    models = list.sort(cmp);
    listedAt = Date.now();
  } catch (e) {
    console.warn(`[gemini] could not list models: ${e.message}`);
    if (!models.length) models = (PREFERRED.length ? PREFERRED : FALLBACK_LIST).map(id => ({ id, label: id }));
  }
  return models;
}

function nextPacificMidnight() {
  // Free-tier daily quotas reset at midnight Pacific time.
  const now = new Date();
  const pt = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const msToMidnight = (24 * 3600e3) - (pt.getHours() * 3600e3 + pt.getMinutes() * 60e3 + pt.getSeconds() * 1e3);
  return Date.now() + msToMidnight + 60e3;
}

function statusOf(id) {
  const c = cooldown[id];
  if (!c || c.until <= Date.now()) { delete cooldown[id]; return { status: 'ok' }; }
  return { status: c.reason, until: new Date(c.until).toISOString(), message: c.message };
}
async function modelStatus() {
  const list = await listModels();
  return list.map(m => ({ ...m, ...statusOf(m.id) }));
}

function parseFailure(status, body) {
  let err = {};
  try { err = JSON.parse(body).error || {}; } catch (e) { /* not JSON */ }
  const details = err.details || [];
  const quota = details.find(d => /QuotaFailure/.test(d['@type'] || ''));
  const retry = details.find(d => /RetryInfo/.test(d['@type'] || ''));
  const msg = err.message || body.slice(0, 200);
  if (status === 429) {
    const ids = ((quota && quota.violations) || []).map(v => v.quotaId || '').join(' ');
    if (/PerDay/i.test(ids) || /per day|daily/i.test(msg)) return { reason: 'daily', until: nextPacificMidnight(), message: 'Daily free limit reached' };
    const secs = retry ? parseFloat(retry.retryDelay) : 0;
    return { reason: 'busy', until: Date.now() + Math.max(15, Math.min(secs || 60, 3600)) * 1000, message: 'Per-minute limit reached' };
  }
  if (status === 503 || status === 500 || status === 502 || status === 504) return { reason: 'busy', until: Date.now() + 30e3, message: 'Overloaded right now' };
  if (status === 404 || (status === 400 && /model|not found|not supported/i.test(msg))) return { reason: 'unavailable', until: Date.now() + 6 * 3600e3, message: 'Not available to this key' };
  if (status === 401 || status === 403) return { fatal: true, code: 'bad_key', message: 'Google rejected the API key. Check GEMINI_API_KEY in the container settings.' };
  return { fatal: true, code: 'upstream_error', message: `Gemini error ${status}: ${msg}` };
}

/**
 * Ask a question, falling back across models.
 * emit(event) receives: {type:'model', model, label, requested, switchedFrom:[{model,reason}]}, {type:'text', text}, {type:'done', truncated}
 * Throws {code, message} when nothing could answer.
 */
async function ask({ system, contents, model, signal, emit }) {
  if (!enabled()) throw { code: 'no_key', message: 'Add GEMINI_API_KEY in the container settings to turn on questions.' };
  const list = await listModels();
  const order = [];
  if (model && model !== 'auto') order.push(model);
  for (const m of list) if (!order.includes(m.id)) order.push(m.id);
  const skipped = [];
  for (const id of order) {
    const st = statusOf(id);
    if (st.status !== 'ok') { skipped.push({ model: id, reason: st.status }); continue; }
    const res = await fetch(`${API}/models/${encodeURIComponent(id)}:streamGenerateContent?alt=sse`, {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents,
        generationConfig: { temperature: 0.4, maxOutputTokens: MAX_TOKENS },
      }),
    });
    if (!res.ok) {
      const f = parseFailure(res.status, await res.text());
      if (f.fatal) throw { code: f.code, message: f.message };
      cooldown[id] = { until: f.until, reason: f.reason, message: f.message };
      skipped.push({ model: id, reason: f.reason });
      continue;
    }
    const label = (list.find(m => m.id === id) || {}).label || id;
    emit({ type: 'model', model: id, label, requested: model || 'auto', switchedFrom: skipped });
    let truncated = false, buf = '', any = false;
    const dec = new TextDecoder();
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        let j; try { j = JSON.parse(line.slice(5)); } catch (e) { continue; }
        if (j.error) throw { code: 'upstream_error', message: j.error.message || 'Gemini stream error' };
        const cand = (j.candidates || [])[0] || {};
        const text = ((cand.content || {}).parts || []).filter(p => !p.thought).map(p => p.text || '').join('');
        if (text) { any = true; emit({ type: 'text', text }); }
        if (cand.finishReason === 'MAX_TOKENS') truncated = true;
        if (cand.finishReason === 'SAFETY' || cand.finishReason === 'PROHIBITED_CONTENT') throw { code: 'refused', message: 'Gemini declined to answer that one. Try asking it a different way.' };
      }
    }
    if (!any) throw { code: 'empty', message: 'Gemini returned an empty answer. Try asking again.' };
    emit({ type: 'done', truncated });
    return;
  }
  const daily = skipped.length && skipped.every(s => s.reason === 'daily');
  throw {
    code: 'all_busy',
    message: daily ? 'Every Gemini model has hit its daily free limit. Limits reset at midnight Pacific time.' : 'Every Gemini model is busy or at its limit right now. Try again in a minute.',
  };
}

module.exports = { enabled, listModels, modelStatus, ask };
