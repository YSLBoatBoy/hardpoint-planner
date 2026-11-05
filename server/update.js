// Builds data.json: ship hardpoints + component stats from the unpacked game files,
// store listings from UEX. Run directly (`node server/update.js`) or via the server's scheduler.
'use strict';
const fs = require('fs');
const path = require('path');

const GAME_REPO = process.env.GAME_DATA_REPO || 'StarCitizenWiki/scunpacked-data';
const GAME_BRANCH = process.env.GAME_DATA_BRANCH || 'master';
const UEX_BASE = (process.env.UEX_API_BASE || 'https://api.uexcorp.uk/2.0').replace(/\/$/, '');
const PRICE_MAX_AGE_DAYS = +(process.env.PRICE_MAX_AGE_DAYS || 180);
const UA = 'hardpoint-planner (self-hosted loadout tool)';

const GRADE = { 1: 'A', 2: 'B', 3: 'C', 4: 'D' };
const r1 = (x, d = 1) => Math.round((+x || 0) * 10 ** d) / 10 ** d;
const badName = n => !n || n.includes('PLACEHOLDER') || n.startsWith('@') || !n.trim();

async function getJSON(url, opts = {}) {
  const headers = { 'User-Agent': UA, Accept: 'application/json', ...(opts.headers || {}) };
  let res;
  try { res = await fetch(url, { headers, signal: AbortSignal.timeout(opts.timeout || 300000) }); }
  catch (e) { throw new Error(`${new URL(url).host}: ${(e.cause && (e.cause.code || e.cause.message)) || e.message}`); }
  if (!res.ok) throw new Error(`${new URL(url).host} → HTTP ${res.status}`);
  return res.json();
}

// ---------------- game files ----------------
async function fetchGameFiles(log) {
  let ver = null;
  try {
    const c = await getJSON(`https://api.github.com/repos/${GAME_REPO}/commits/${GAME_BRANCH}`, { timeout: 30000 });
    const m = /(\d+\.\d+(?:\.\d+)?-[A-Za-z]+)/.exec(c.commit.message || '');
    ver = m ? m[1].toUpperCase() : (c.commit.message || '').split('\n')[0].slice(0, 40);
    log(`game data commit: ${c.commit.message.split('\n')[0]} (${c.commit.committer.date})`);
  } catch (e) { log(`could not read game data version: ${e.message}`); }
  const base = (process.env.GAME_DATA_BASE || `https://raw.githubusercontent.com/${GAME_REPO}/${GAME_BRANCH}`).replace(/\/$/, '');
  const raw = f => `${base}/${f}`;
  log('downloading ship-items.json …');
  const items = await getJSON(raw('ship-items.json'));
  log('downloading ships.json …');
  const ships = await getJSON(raw('ships.json'));
  return { ver, items, ships };
}

function buildItems(items) {
  const out = {};
  for (const it of items) {
    const s = it.stdItem || {};
    const t = it.type;
    const n = s.Name || it.name;
    if (badName(n)) continue;
    const dd = s.DescriptionData || {};
    const base = { n, s: s.Size || it.size, m: (s.Manufacturer || {}).Name || '', u: s.UUID };
    const emMax = ((s.Emission || {}).Em || {}).Maximum || 0;
    if (t === 'WeaponGun' && it.subType === 'Gun') {
      const w = s.Weapon || {}; const dmg = w.Damage || {};
      if (!dmg.DpsTotal) continue;
      const dps = dmg.Dps || {};
      const dtype = ['Physical', 'Energy', 'Distortion', 'Thermal'].reduce((a, k) => ((dps[k] || 0) > (dps[a] || 0) ? k : a), 'Physical');
      const ammo = s.Ammunition || {};
      Object.assign(base, {
        cat: 'gun', k: dd['Item Type'] || '',
        dt: { Physical: 'Ballistic', Energy: 'Energy', Distortion: 'Distortion', Thermal: 'Thermal' }[dtype],
        a: r1(dmg.AlphaTotal), b: r1(dmg.Burst || dmg.DpsTotal), su: r1(dmg.Sustained || dmg.DpsTotal),
        rg: Math.round(w.EffectiveRange || ammo.Range || 0), v: Math.round(ammo.Speed || 0),
        rof: Math.round(w.RateOfFire || 0), cap: w.Capacity || 0,
      });
    } else if (t === 'Shield') {
      const sh = s.Shield || {}; if (!sh.MaxShieldHealth) continue;
      const ab = ((sh.Absorption || {}).Physical) || {};
      Object.assign(base, {
        cat: 'shield', g: GRADE[s.Grade] || '?', c: dd.Class || '',
        hp: Math.round(sh.MaxShieldHealth), rg: Math.round(sh.MaxShieldRegen || 0),
        dd: r1(sh.DownedDelay, 2), dmd: r1(sh.DamagedDelay, 2), pa: r1(ab.Maximum, 2), em: Math.round(emMax),
      });
    } else if (t === 'PowerPlant') {
      const gen = ((s.ResourceNetwork || {}).Generation || {}).Power; if (!gen) continue;
      Object.assign(base, { cat: 'power', g: GRADE[s.Grade] || '?', c: dd.Class || '', out: r1(gen), em: Math.round(emMax) });
    } else if (t === 'Cooler') {
      const gen = ((s.ResourceNetwork || {}).Generation || {}).Coolant; if (!gen) continue;
      Object.assign(base, { cat: 'cooler', g: GRADE[s.Grade] || '?', c: dd.Class || '', out: r1(gen), ir: Math.round((s.Emission || {}).Ir || 0), em: Math.round(emMax) });
    } else if (t === 'QuantumDrive') {
      const q = s.QuantumDrive || {}; const sj = q.StandardJump || {}; if (!sj.DriveSpeed) continue;
      Object.assign(base, {
        cat: 'qd', g: GRADE[s.Grade] || '?', c: dd.Class || '',
        sp: Math.round(sj.DriveSpeed / 1000), spool: r1(sj.SpoolUpTime), cd: r1(sj.CooldownTime), fuel: r1((q.QuantumFuelRequirement || 0) * 1000, 3),
      });
    } else continue;
    out[it.className] = base;
  }
  return out;
}

const SKIP = /(_AI_|_AI$|Unmanned|_PU_|Template|NPC|Derelict|Hijacked|Boarding|Tutorial|Wreck|_Drug|Swarm|_FW_|Showdown|_Exec|Fleetweek|_Display|_BIS)/i;
const MAP_CAT = { Shield: 'shield', PowerPlant: 'power', Cooler: 'cooler', QuantumDrive: 'qd' };
const pretty = hp => { const h = hp.replace(/^hardpoint_/i, '').replace(/_+/g, ' ').trim(); return h.charAt(0).toUpperCase() + h.slice(1); };

function buildShips(ships, items) {
  const out = {};
  for (const sh of ships) {
    if (!sh.IsSpaceship || SKIP.test(sh.ClassName)) continue;
    const slots = [];
    const walk = (node, top, anc) => {
      const ctypes = (node.CompatibleTypes || []).map(c => c.Type);
      const ntype = node.Type || '';
      const kids = node.Loadout || [];
      const isGun = ntype.startsWith('WeaponGun') ||
        (ctypes.includes('WeaponGun') && !ntype.startsWith('Turret') && !kids.some(k => (k.Type || '').startsWith('WeaponGun')));
      if (isGun) {
        const ancTypes = anc.map(a => a.Type || '');
        const ancNames = anc.map(a => a.Name || '').join(' ');
        const parent = anc[anc.length - 1] || {};
        const pname = parent.Name || '';
        const crew = ancTypes.some(t => t.startsWith('TurretBase')) || ancNames.includes('Remote Turret') || ancNames.includes('Manned');
        const mount = pname.includes('Gimbal') ? 'Gimbal' : (ancTypes.some(t => t.startsWith('Turret')) ? 'Turret' : 'Fixed');
        slots.push({ cat: 'gun', grp: pretty(top.HardpointName), s: node.MaxSize, mn: node.MinSize || node.MaxSize, ed: !!node.Editable, crew, mt: mount, st: items[node.ClassName] ? node.ClassName : null });
        return;
      }
      const baseType = ntype ? ntype.split('.')[0] : (ctypes.length === 1 ? ctypes[0] : '');
      if (MAP_CAT[baseType] && !anc.length) {
        slots.push({ cat: MAP_CAT[baseType], grp: pretty(node.HardpointName), s: node.MaxSize, mn: node.MaxSize, ed: !!node.Editable, st: items[node.ClassName] ? node.ClassName : null });
        return;
      }
      if (/^(MissileLauncher|WeaponAttachment|BombLauncher)/.test(ntype)) return;
      for (const k of kids) walk(k, top, anc.concat([node]));
    };
    for (const p of sh.Loadout || []) walk(p, p, []);
    if (!slots.length) continue;
    const ag = sh.Agility || {}; const ifcs = (sh.FlightCharacteristics || {}).IFCS || {};
    const cs = sh.CrossSection || {}; const pw = sh.Power || {}; const qt = sh.QuantumTravel || {}; const em = sh.Emission || {};
    const rec = {
      n: sh.Name, cn: sh.ClassName, m: (sh.Manufacturer || {}).Name || '', car: sh.Career || '', role: sh.Role || '', sz: sh.Size, slots,
      st: {
        pitch: ag.Pitch || 0, yaw: ag.Yaw || 0, roll: ag.Roll || 0, acc: r1((ag.Acceleration || {}).Main),
        scm: ifcs.ScmSpeed || 0, boost: ifcs.BoostSpeedForward || 0,
        cs: Math.round(Math.max(cs.X || 0, cs.Y || 0, cs.Z || 0)),
        hull: Math.round(sh.Health || 0), armor: Math.round((sh.Armor || {}).Health || 0), shield: Math.round(sh.ShieldHp || 0),
        cargo: Math.round(sh.Cargo || 0), crew: sh.Crew || 1,
        wpip: (pw.MaxSegments || {}).WeaponGun || 0, gen: pw.GenerationSegments || 0,
        em: Math.round(em.EmShields || 0), ir: Math.round(em.IrShields || 0), qspool: qt.SpoolTime || 0, mass: Math.round(sh.MassTotal || 0),
      },
    };
    const prev = out[sh.Name];
    if (!prev || sh.ClassName.length < prev.cn.length) out[sh.Name] = rec; // keep the base variant
  }
  return Object.values(out).sort((a, b) => a.n.localeCompare(b.n));
}

// ---------------- UEX store listings ----------------
function terminalLocation(t) {
  const name = t.name || t.displayname || t.fullname || '';
  const parts = name.split(' - ').map(x => x.trim()).filter(Boolean);
  const shop = parts.length > 1 ? parts[0] : (t.nickname || name);
  const place = t.space_station_name || t.city_name || t.outpost_name || (parts.length > 1 ? parts[parts.length - 1] : name);
  let body = t.moon_name || t.planet_name || t.orbit_name || '';
  if (t.moon_name && t.planet_name) body = `${t.moon_name} (${t.planet_name} moon)`;
  else if (t.space_station_name && t.planet_name && !t.city_name) body = `${t.planet_name} orbit`;
  if (t.is_jump_point && !body) body = 'Jump point station';
  return [shop, place, body || '—', t.star_system_name || '—'];
}

async function fetchStoreListings(itemsByUuid, log) {
  const headers = process.env.UEX_API_TOKEN ? { Authorization: `Bearer ${process.env.UEX_API_TOKEN}` } : {};
  log('downloading UEX terminals …');
  const tj = await getJSON(`${UEX_BASE}/terminals`, { headers, timeout: 120000 });
  if (tj.status && tj.status !== 'ok') throw new Error(`UEX terminals: ${tj.status}`);
  const terms = {};
  for (const t of tj.data || []) if (t.is_available !== 0 && t.is_available_live !== 0) terms[t.id] = t;
  log('downloading UEX item prices …');
  const pj = await getJSON(`${UEX_BASE}/items_prices_all`, { headers, timeout: 180000 });
  if (pj.status && pj.status !== 'ok') throw new Error(`UEX prices: ${pj.status}`);
  const cutoff = Date.now() / 1000 - PRICE_MAX_AGE_DAYS * 86400;
  const stores = []; const storeIdx = {}; const shops = {};
  let used = 0;
  for (const p of pj.data || []) {
    if (!p.price_buy || !p.item_uuid) continue;
    if ((p.date_modified || p.date_added || 0) < cutoff) continue;
    const cn = itemsByUuid[p.item_uuid]; if (!cn) continue;
    const t = terms[p.id_terminal]; if (!t) continue;
    const loc = terminalLocation(t); const key = loc.join('|');
    if (storeIdx[key] === undefined) { storeIdx[key] = stores.length; stores.push(loc); }
    const sid = String(storeIdx[key]); const price = Math.round(p.price_buy);
    shops[cn] = shops[cn] || {};
    if (!(sid in shops[cn]) || price < shops[cn][sid]) shops[cn][sid] = price;
    used++;
  }
  log(`UEX: ${used} listings for ${Object.keys(shops).length} ship parts at ${stores.length} stores`);
  if (!used) throw new Error('UEX returned no usable listings');
  return { stores, shops };
}

// ---------------- main ----------------
async function buildData({ dataDir, log = console.log }) {
  const file = path.join(dataDir, 'data.json');
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { /* first run */ }

  const game = await fetchGameFiles(log);
  const items = buildItems(game.items);
  const ships = buildShips(game.ships, items);
  log(`game data: ${ships.length} ships, ${Object.keys(items).length} parts`);
  const byUuid = {}; for (const [cn, it] of Object.entries(items)) if (it.u) byUuid[it.u] = cn;

  let stores, pricesUpdated, priceSource;
  try {
    const sl = await fetchStoreListings(byUuid, log);
    stores = sl.stores;
    for (const [cn, sh] of Object.entries(sl.shops)) items[cn].sh = sh;
    pricesUpdated = new Date().toISOString(); priceSource = 'UEX';
  } catch (e) {
    log(`store listings not refreshed (${e.message}); keeping previous listings`);
    stores = (prev && prev.stores) || [];
    if (prev) for (const [cn, it] of Object.entries(prev.items || {})) if (it.sh && items[cn]) items[cn].sh = it.sh;
    pricesUpdated = prev && prev.pricesUpdated || null; priceSource = prev && prev.priceSource || 'snapshot';
  }
  for (const it of Object.values(items)) delete it.u;
  const data = {
    ver: game.ver || (prev && prev.ver) || 'unknown', items, ships, stores,
    gameUpdated: new Date().toISOString(), pricesUpdated, priceSource,
  };
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(data));
  fs.renameSync(file + '.tmp', file);
  log(`wrote ${file}`);
  return data;
}

module.exports = { buildData, buildItems, buildShips, terminalLocation };

if (require.main === module) {
  buildData({ dataDir: process.env.DATA_DIR || path.join(__dirname, '..', 'data') })
    .catch(e => { console.error(e); process.exit(1); });
}
