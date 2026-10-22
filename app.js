(() => {
'use strict';

/* ================= Konstanten & Zustand ================= */
const ZRH = { lat: 47.4647, lon: 8.5492 };          // Flughafen Zürich (ARP)
const FT = 0.3048, KT = 0.514444, R_EARTH = 6371000;
const GEOID_M = 48;                                  // Geoidhöhe (Ellipsoid – Meereshöhe) im Raum Zürich
const EYE_M = 1.5;                                   // Augenhöhe über Boden
const RANGES = [5, 10, 20, 40];                      // Radar-Reichweiten in km
const FETCH_MS = 10000;
const KEEP_MS = 35000;                               // Flugzeug nach so langer Funkstille entfernen
const MAX_ALT_M = 5000;                              // darüber nur mit Schalter «Alle» im Radar
const API_BASES = window.API_BASES || ['/adsb'];
// Pistenanflüge (Landerichtung) von ZRH -> Konzept
const RWY = [
  { name: '14', min: 120, max: 160, concept: 'nord' },
  { name: '28', min: 262, max: 298, concept: 'ost' },
  { name: '34', min: 322, max: 358, concept: 'sued' },
];

const $ = id => document.getElementById(id);
const qp = new URLSearchParams(location.search);
const state = {
  user: { lat: 47.45, lon: 8.575, alt: 430, acc: null, real: false },
  aircraft: new Map(),     // hex -> Datensatz
  routes: new Map(),       // callsign -> {codes:[], ap:{icao:{iata,city}}} | null
  routePending: new Set(),
  rangeIdx: 2, showAll: false,
  sel: 'auto',             // 'auto' | 'none' | hex
  lastFetch: 0, err: null,
};
try { const s = JSON.parse(localStorage.getItem('fl-settings') || '{}'); if (s.rangeIdx != null) state.rangeIdx = s.rangeIdx; state.showAll = !!s.showAll; } catch (e) {}
const saveSettings = () => { try { localStorage.setItem('fl-settings', JSON.stringify({ rangeIdx: state.rangeIdx, showAll: state.showAll })); } catch (e) {} };

/* ================= Geometrie ================= */
const rad = d => d * Math.PI / 180, deg = r => r * 180 / Math.PI;
function enu(lat, lon, o = state.user) {               // km Ost/Nord relativ zum Ursprung
  const dy = rad(lat - o.lat) * R_EARTH / 1000;
  const dx = rad(lon - o.lon) * Math.cos(rad(o.lat)) * R_EARTH / 1000;
  return { x: dx, y: dy };
}
function destPoint(lat, lon, trackDeg, meters) {
  const d = meters / R_EARTH, b = rad(trackDeg), p1 = rad(lat), l1 = rad(lon);
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return { lat: deg(p2), lon: deg(l2) };
}
const compass8 = b => ['N', 'NO', 'O', 'SO', 'S', 'SW', 'W', 'NW'][Math.round(((b % 360) + 360) % 360 / 45) % 8];
const angDiffIn = (a, min, max) => a >= min && a <= max;

/* ================= Daten holen ================= */
async function getJSON(path, opts) {
  let last;
  for (const base of API_BASES) {
    try {
      const r = await fetch(base + path, opts);
      if (!r.ok) throw new Error(r.status);
      return await r.json();
    } catch (e) { last = e; }
  }
  throw last;
}
// Eine einzige Abfrage pro Zyklus: Mittelpunkt Standort, Radius so gross, dass auch der Flughafen (Landekonzept) drin liegt
async function fetchTraffic() {
  const u = state.user;
  const z = enu(ZRH.lat, ZRH.lon);
  const nm = Math.min(100, Math.max(25, Math.ceil((Math.hypot(z.x, z.y) + 22) / 1.852)));
  const res = await getJSON(`/v2/point/${u.lat.toFixed(4)}/${u.lon.toFixed(4)}/${nm}`);
  const now = Date.now();
  for (const p of (res.ac || res.aircraft || [])) {
    if (p.lat == null || p.lon == null) continue;
    state.aircraft.set(p.hex, { raw: p, t: now - (p.seen_pos || 0) * 1000, seen: now });
  }
  state.lastFetch = now; state.err = null;
  lookupRoutes();
}

// Routen-Cache (bleibt über App-Starts erhalten; Routen ändern sich selten)
const ROUTE_TTL = 12 * 3600e3, NULL_TTL = 2 * 3600e3;
const routeFail = new Map();
try {
  const saved = JSON.parse(localStorage.getItem('fl-routes') || '{}'), now = Date.now();
  for (const [cs, e] of Object.entries(saved)) if (now - e.t < (e.v ? ROUTE_TTL : NULL_TTL)) state.routes.set(cs, e.v);
} catch (e) {}
const routeStamp = {};
function saveRoutes() {
  try {
    const out = {}, now = Date.now();
    for (const [cs, v] of state.routes) out[cs] = { t: routeStamp[cs] || now, v };
    localStorage.setItem('fl-routes', JSON.stringify(out));
  } catch (e) {}
}
async function lookupRoutes() {
  const todo = [], now = Date.now();
  for (const { raw: p } of state.aircraft.values()) {
    const cs = (p.flight || '').trim();
    if (!cs || state.routes.has(cs) || state.routePending.has(cs) || now - (routeFail.get(cs) || 0) < 60000) continue;
    if (/^[A-Z]{1,2}-?[A-Z0-9]{3,4}$/.test(cs) && !/^[A-Z]{3}\d/.test(cs)) continue; // Immatrikulation statt Flugnummer
    const alt = typeof p.alt_baro === 'number' ? p.alt_baro : 0;
    const zz = enu(p.lat, p.lon, ZRH), uu = enu(p.lat, p.lon);
    if (alt * FT > MAX_ALT_M || Math.min(Math.hypot(zz.x, zz.y), Math.hypot(uu.x, uu.y)) > 45) continue; // nur Relevantes abfragen
    todo.push({ cs, d: Math.hypot(uu.x, uu.y) });
  }
  todo.sort((a, b) => a.d - b.d); todo.length = Math.min(todo.length, 4);
  todo.forEach((t, i) => todo[i] = t.cs);
  await Promise.all(todo.map(async cs => {
    state.routePending.add(cs);
    try {
      const res = await getJSON('/api/0/route/' + encodeURIComponent(cs));
      state.routes.set(cs, parseRoute(res)); routeStamp[cs] = Date.now();
    } catch (e) {
      if (String(e.message) === '404') { state.routes.set(cs, null); routeStamp[cs] = Date.now(); }
      else routeFail.set(cs, Date.now());                         // später erneut versuchen
    }
    state.routePending.delete(cs);
  }));
  if (todo.length) { saveRoutes(); tick(); }
}

// Genauer Typ & Betreiber aus der Registrierungsdatenbank (pro Flugzeug einmal, dann gecacht)
const hexInfo = new Map(), hexPending = new Set();
try { for (const [h, v] of Object.entries(JSON.parse(localStorage.getItem('fl-hex') || '{}'))) hexInfo.set(h, v); } catch (e) {}
async function lookupHex(hex) {
  if (hexInfo.has(hex) || hexPending.has(hex)) return;
  hexPending.add(hex);
  try {
    const r = await fetch('https://hexdb.io/api/v1/aircraft/' + hex);
    if (r.status === 404) hexInfo.set(hex, null);
    else if (r.ok) { const j = await r.json(); hexInfo.set(hex, { type: j.Type || '', icao: j.ICAOTypeCode || '', owner: j.RegisteredOwners || '' }); }
    if (hexInfo.has(hex)) {
      try { localStorage.setItem('fl-hex', JSON.stringify(Object.fromEntries(hexInfo))); } catch (e) {}
      tick();
    }
  } catch (e) {}
  hexPending.delete(hex);
}
function parseRoute(r) {
  if (!r || !r.airport_codes || /unknown/i.test(r.airport_codes) || r.plausible === 0) return null;
  const codes = String(r.airport_codes).split('-').filter(Boolean);
  if (codes.length < 2) return null;
  const ap = {};
  for (const a of (r._airports || [])) ap[a.icao] = { iata: a.iata, city: a.location || a.name };
  return { codes, ap };
}

/* ================= Aufbereitung ================= */
function airportLabel(rt, icao) {
  const a = rt && rt.ap[icao];
  if (!a) return icao;
  const city = (a.city || '').replace(/ \(.*\)/, '');
  return city ? `${city}${a.iata ? ' (' + a.iata + ')' : ''}` : (a.iata || icao);
}
// aktuelle (extrapolierte) Position und Kennzahlen eines Flugzeugs
function derive(rec, now) {
  const p = rec.raw;
  if (p.alt_baro === 'ground') return null;
  const dt = Math.max(0, Math.min((now - rec.t) / 1000, 45));
  const gs = (p.gs || 0) * KT, trk = p.track ?? 0;
  const pos = gs > 5 ? destPoint(p.lat, p.lon, trk, gs * dt) : { lat: p.lat, lon: p.lon };
  const rate = p.baro_rate ?? p.geom_rate ?? 0;                       // ft/min
  const altFt = (p.alt_baro ?? p.alt_geom ?? 0) + rate * dt / 60;      // Anzeige & Logik: barometrisch
  const altM = altFt * FT;
  // für die Distanz: Höhe über Meer (GPS-Höhe des Flugzeugs minus Geoidhöhe), sonst barometrisch
  const altMsl = p.alt_geom != null ? (p.alt_geom + rate * dt / 60) * FT - GEOID_M : altM;
  const e = enu(pos.lat, pos.lon);
  const horiz = Math.hypot(e.x, e.y) * 1000;
  const dz = altMsl - state.user.alt;
  const cs = (p.flight || '').trim();
  const rt = state.routes.get(cs) || null;
  const zE = enu(pos.lat, pos.lon, ZRH), dZrh = Math.hypot(zE.x, zE.y);
  let zrh = false, status = '?', from = null, to = null;
  if (rt) {
    const i = rt.codes.indexOf('LSZH');
    if (i >= 0) {
      zrh = true;
      if (i === rt.codes.length - 1) status = 'arr'; else if (i === 0) status = 'dep';
      else status = rate < 0 ? 'arr' : 'dep';
      from = status === 'arr' ? rt.codes[i - 1] : 'LSZH';
      to = status === 'arr' ? 'LSZH' : rt.codes[i + 1];
    }
  } else if (dZrh < 25 && altM < 3000 && !['A1', 'A7', 'B2'].includes(p.category) && (p.gs || 0) > 100) {
    // Route (noch) unbekannt: Verkehrsflugzeug nahe ZRH im Auf-/Abstieg oder auf einer Pistenachse
    const onAxis = RWY.some(r => angDiffIn(trk, r.min, r.max));
    if (Math.abs(rate) > 200 || (onAxis && altM < 1800)) { zrh = true; status = rate < 0 || (rate === 0 && onAxis) ? 'arr' : 'dep'; }
  }
  return {
    hex: p.hex, cs, reg: p.r || '', type: p.t || '', lat: pos.lat, lon: pos.lon, x: e.x, y: e.y,
    altFt, altM, gs: p.gs || 0, trk, rate, horiz, dz,
    d3: Math.hypot(horiz, dz), az: (deg(Math.atan2(e.x, e.y)) + 360) % 360,
    el: deg(Math.atan2(dz, Math.max(horiz, 1))), zrh, status, from, to, rt, dZrh,
  };
}
function airlineOf(cs, hex) {
  const m = /^([A-Z]{3})\d/.exec(cs), owner = hexInfo.get(hex)?.owner;
  const own = owner && !/^private$/i.test(owner) ? owner : '';
  return (m && window.AIRLINES[m[1]]) || own || (m ? m[1] : '');
}
// Typname; bei Grundtypen (z.B. «Airbus A320») Serie aus hexdb ergänzen: A320-232 -> «Airbus A320-200»
function typeOf(t, hex) {
  const hi = hexInfo.get(hex);
  const base = window.TYPES[t] || window.TYPES[hi?.icao] || t || hi?.icao || 'Unbekannter Typ';
  const ht = hi?.type;
  if (ht && !base.includes('-')) {
    const model = base.split(' ').pop(), m = ht.startsWith(model) && /^[ -](\d)/.exec(ht.slice(model.length));  // hexdb: «A321 231»
    if (m) return `${base}-${m[1]}00`;
  }
  return base;
}

/* ================= Landekonzept ================= */
let hist = {};
try { hist = JSON.parse(localStorage.getItem('fl-arr') || '{}'); } catch (e) {}
function updateConcept(list, now) {
  for (const d of list) {
    if (d.status === 'dep' || d.altFt > 4500 || d.rate > -150 && d.altFt > 2000 || d.gs < 80 || d.dZrh > 22) continue;
    if (d.rt && d.rt.codes.indexOf('LSZH') !== d.rt.codes.length - 1) continue;
    if (!d.rt && ['A1', 'A7', 'B2'].includes(state.aircraft.get(d.hex)?.raw.category)) continue;
    const r = RWY.find(r => angDiffIn(d.trk, r.min, r.max));
    if (r) hist[d.hex] = { t: now, c: r.concept, r: r.name };
  }
  const counts = { nord: 0, ost: 0, sued: 0 };
  for (const h of Object.keys(hist)) {
    if (now - hist[h].t > 30 * 60000) delete hist[h]; else counts[hist[h].c]++;
  }
  try { localStorage.setItem('fl-arr', JSON.stringify(hist)); } catch (e) {}
  const tot = counts.nord + counts.ost + counts.sued;
  const el = $('concept');
  el.className = 'concept';
  if (!tot) {
    el.classList.add('unknown'); $('conceptName').textContent = 'Unklar';
    $('conceptSub').textContent = 'Keine Landungen in den letzten 30 min'; el.querySelector('i').textContent = '?';
    return;
  }
  const best = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
  const names = { nord: ['Nordkonzept', 'N', 'Landungen auf Piste 14'], ost: ['Ostkonzept', 'O', 'Landungen auf Piste 28'], sued: ['Südanflug', 'S', 'Landungen auf Piste 34'] };
  el.classList.add(best);
  $('conceptName').textContent = names[best][0];
  $('conceptSub').textContent = `${names[best][2]} · ${counts[best]} von ${tot} Anflügen`;
  el.querySelector('i').textContent = names[best][1];
}

/* ================= Liste ================= */
const rows = new Map();
function buildRow(hex) {
  const el = document.createElement('article');
  el.className = 'ac';
  el.innerHTML = `<div class="row"><div class="rank"></div><div class="main"><div class="l1"></div><div class="l2"></div></div>
    <div class="dist"><span></span></div></div>
    <div class="detail"><div><div class="grid">
      <div class="wide"><b>Route</b><span class="route" data-f="route"></span></div>
      <div><b>Flug</b><span data-f="cs"></span></div><div><b>Registrierung</b><span data-f="reg"></span></div>
      <div><b>Höhe</b><span data-f="alt"></span></div><div><b>Geschwindigkeit</b><span data-f="gs"></span></div>
      <div><b>Steigen / Sinken</b><span data-f="rate"></span></div><div><b>Richtung vom Standort</b><span data-f="dir"></span></div>
      <div><b>Horizontal</b><span data-f="horiz"></span></div><div><b>Kurs</b><span data-f="trk"></span></div>
    </div></div></div>`;
  el.querySelector('.row').addEventListener('click', () => select(hex, true));
  return el;
}
function select(hex, fromList) {
  state.sel = (state.sel === hex && fromList) ? 'none' : hex;
  renderList(lastList);
  drawRadar(); updateMap();
  if (!fromList) { const el = rows.get(hex); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
}
let lastList = [];
const fmtKm = m => m < 1000 ? Math.round(m / 10) * 10 + ' m' : (m / 1000).toFixed(1) + ' km';
function renderList(list) {
  lastList = list;
  const box = $('list');
  const selHex = state.sel === 'auto' ? (list[0] && list[0].hex) : state.sel;
  const keep = new Set(list.map(d => d.hex));
  for (const [h, el] of rows) if (!keep.has(h)) { el.remove(); rows.delete(h); }
  list.forEach((d, i) => {
    let el = rows.get(d.hex);
    if (!el) { el = buildRow(d.hex); rows.set(d.hex, el); }
    if (box.children[i] !== el) box.insertBefore(el, box.children[i] || null);
    el.className = 'ac ' + d.status + (d.hex === selHex ? ' open sel' : '');
    el.querySelector('.rank').textContent = i + 1;
    lookupHex(d.hex);
    const air = airlineOf(d.cs, d.hex);
    el.querySelector('.l1').textContent = typeOf(d.type, d.hex) + (air ? ' · ' + air : '');
    const where = d.status === 'arr' ? (d.from ? 'Von ' + airportLabel(d.rt, d.from) : 'Landeanflug auf Zürich')
      : d.status === 'dep' ? (d.to ? 'Nach ' + airportLabel(d.rt, d.to) : 'Abflug ab Zürich') : '';
    el.querySelector('.l2').textContent = where || (d.cs || d.reg);
    el.querySelector('.dist span').textContent = fmtKm(d.d3);
    const set = (f, v) => { el.querySelector(`[data-f="${f}"]`).textContent = v; };
    set('route', d.rt ? `${airportLabel(d.rt, d.rt.codes[0])} → ${airportLabel(d.rt, d.rt.codes[d.rt.codes.length - 1])}` : 'unbekannt (nach Verhalten erkannt)');
    set('cs', d.cs || '–'); set('reg', d.reg || '–');
    set('alt', `${Math.round(d.altM / 10) * 10} m ü. M.`);
    set('gs', `${Math.round(d.gs * 1.852)} km/h`);
    set('rate', `${d.rate > 0 ? '▲' : d.rate < 0 ? '▼' : '►'} ${Math.abs(d.rate * FT / 60).toFixed(1)} m/s`);
    set('dir', `${compass8(d.az)} ${Math.round(d.az)}°, ${Math.round(d.el)}° hoch`);
    set('horiz', fmtKm(d.horiz)); set('trk', `${Math.round(d.trk)}°`);
  });
  $('empty').hidden = list.length > 0;
  $('count').textContent = list.length ? `· ${list.length} in Reichweite` : '';
}

/* ================= Radar ================= */
const cv = $('radar'), ctx = cv.getContext('2d');
let S = 300, DPR = 1;
function sizeCanvas() {
  DPR = window.devicePixelRatio || 1;
  S = cv.clientWidth;
  cv.width = cv.height = Math.round(S * DPR);
  drawRadar();
}
let radarItems = [];
function drawRadar() {
  if (S < 20 || state.view === 'map') return;
  const c = ctx, W = S, cx = W / 2, R = W / 2 - 6, range = RANGES[state.rangeIdx], k = R / range;
  const rot = 0;                                      // Norden ist immer oben
  const P = (x, y) => [cx + (x * Math.cos(rot) - y * Math.sin(rot)) * k, cx - (x * Math.sin(rot) + y * Math.cos(rot)) * k];
  c.setTransform(DPR, 0, 0, DPR, 0, 0);
  c.clearRect(0, 0, W, W);
  c.lineCap = 'round';

  // Ringe
  c.font = '600 11px Segoe UI, sans-serif'; c.textAlign = 'left';
  const step = range <= 5 ? 1 : range <= 10 ? 2.5 : range <= 20 ? 5 : 10;
  for (let r = step; r <= range + 0.01; r += step) {
    c.beginPath(); c.arc(cx, cx, r * k, 0, 7);
    c.strokeStyle = 'rgba(255,255,255,.35)'; c.lineWidth = 1; c.stroke();
    c.fillStyle = 'rgba(255,255,255,.75)'; c.fillText(r + ' km', cx + 4, cx - r * k + 12);
  }
  // Achsen + Himmelsrichtungen
  c.strokeStyle = 'rgba(255,255,255,.2)';
  for (const [lab, b] of [['N', 0], ['O', 90], ['S', 180], ['W', 270]]) {
    const [x, y] = P(Math.sin(rad(b)) * range, Math.cos(rad(b)) * range);
    c.beginPath(); c.moveTo(cx, cx); c.lineTo(x, y); c.stroke();
    const [tx, ty] = P(Math.sin(rad(b)) * range * 0.93, Math.cos(rad(b)) * range * 0.93);
    c.fillStyle = lab === 'N' ? '#ffd27a' : 'rgba(255,255,255,.9)'; c.font = '700 13px Segoe UI, sans-serif';
    c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(lab, tx, ty);
  }
  c.textBaseline = 'alphabetic';

  // Flughafen: Pisten
  const z = enu(ZRH.lat, ZRH.lon);
  c.strokeStyle = 'rgba(255,255,255,.7)'; c.lineWidth = Math.max(2, k * 0.12);
  for (const [brg, len, ox, oy] of [[136, 3.3, 0, 0], [161, 3.7, 0.25, 0.1], [94, 2.5, -0.2, -0.45]]) {
    const hx = Math.sin(rad(brg)) * len / 2, hy = Math.cos(rad(brg)) * len / 2;
    const [x1, y1] = P(z.x + ox + hx, z.y + oy + hy), [x2, y2] = P(z.x + ox - hx, z.y + oy - hy);
    c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke();
  }
  const [zx, zy] = P(z.x, z.y);
  c.fillStyle = 'rgba(255,255,255,.9)'; c.font = '700 11px Segoe UI, sans-serif'; c.textAlign = 'center';
  if (Math.hypot(zx - cx, zy - cx) < R) c.fillText('ZRH', zx, zy - 7 - k * 0.25);

  // Flugzeuge
  const now = Date.now(), selHex = state.sel === 'auto' ? (lastList[0] && lastList[0].hex) : state.sel;
  radarItems = [];
  const all = [];
  for (const rec of state.aircraft.values()) { const d = derive(rec, now); if (d) all.push(d); }
  all.sort((a, b) => (a.hex === selHex) - (b.hex === selHex));
  for (const d of all) {
    if (!state.showAll && (!d.zrh || d.altM > MAX_ALT_M)) continue;
    if (Math.hypot(d.x, d.y) > range * 1.02) continue;
    const [x, y] = P(d.x, d.y);
    radarItems.push({ x, y, hex: d.hex });
    drawPlane(c, x, y, rad(d.trk) - rot, d, d.hex === selHex, d.zrh);
  }

  // Standort (Mitte)
  const g = c.createRadialGradient(cx - 2, cx - 3, 1, cx, cx, 9);
  g.addColorStop(0, '#fff'); g.addColorStop(.5, '#7dff6a'); g.addColorStop(1, '#1a9a1a');
  c.beginPath(); c.arc(cx, cx, 7, 0, 7); c.fillStyle = g; c.shadowColor = '#7dff6a'; c.shadowBlur = 12; c.fill();
  c.shadowBlur = 0; c.strokeStyle = '#fff'; c.lineWidth = 1.5; c.stroke();
}
function drawPlane(c, x, y, a, d, selected, zrh) {
  const s = selected ? 1.35 : 1;
  c.save(); c.translate(x, y); c.rotate(a);
  if (selected) {
    const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 250);
    c.beginPath(); c.arc(0, 0, 17 + pulse * 4, 0, 7);
    c.strokeStyle = `rgba(255,170,40,${.9 - pulse * .4})`; c.lineWidth = 2.5; c.stroke();
  }
  c.scale(s, s);
  c.beginPath();
  c.moveTo(0, -10); c.lineTo(2.2, -3); c.lineTo(10, 3); c.lineTo(10, 5); c.lineTo(2.2, 2.5);
  c.lineTo(1.8, 8); c.lineTo(5, 10); c.lineTo(5, 11.5); c.lineTo(0, 10.3);
  c.lineTo(-5, 11.5); c.lineTo(-5, 10); c.lineTo(-1.8, 8); c.lineTo(-2.2, 2.5);
  c.lineTo(-10, 5); c.lineTo(-10, 3); c.lineTo(-2.2, -3); c.closePath();
  const col = !zrh ? ['#d6e6f0', '#8fa9ba'] : d.status === 'arr' ? ['#ffe3a8', '#ff9a1f'] : d.status === 'dep' ? ['#d5ffb8', '#4cbf2b'] : ['#ffffff', '#6cc4ee'];
  const gr = c.createLinearGradient(-10, -10, 10, 10); gr.addColorStop(0, col[0]); gr.addColorStop(1, col[1]);
  c.fillStyle = gr; c.shadowColor = 'rgba(0,30,70,.6)'; c.shadowBlur = 5; c.shadowOffsetY = 2; c.fill();
  c.shadowBlur = 0; c.shadowOffsetY = 0; c.strokeStyle = 'rgba(255,255,255,.95)'; c.lineWidth = 1.1; c.stroke();
  c.restore();
  if (zrh || selected) {
    c.font = '700 11px Segoe UI, sans-serif'; c.textAlign = 'left'; c.fillStyle = '#fff';
    c.shadowColor = 'rgba(0,40,90,.9)'; c.shadowBlur = 4;
    c.fillText(d.cs || d.reg || d.hex, x + 14, y - 4);
    c.font = '600 10px Segoe UI, sans-serif'; c.fillStyle = 'rgba(255,255,255,.85)';
    c.fillText(Math.round(d.altM / 50) * 50 + ' m', x + 14, y + 8);
    c.shadowBlur = 0;
  }
}
cv.addEventListener('click', ev => {
  const r = cv.getBoundingClientRect(), x = ev.clientX - r.left, y = ev.clientY - r.top;
  let best = null, bd = 30;
  for (const it of radarItems) { const dd = Math.hypot(it.x - x, it.y - y); if (dd < bd) { bd = dd; best = it; } }
  if (best && lastList.some(d => d.hex === best.hex)) select(best.hex, false);
  else if (best) { state.sel = best.hex; drawRadar(); }
});

/* ================= Steuerung ================= */
function setRange(i) {
  state.rangeIdx = Math.max(0, Math.min(RANGES.length - 1, i));
  $('rangeLabel').textContent = RANGES[state.rangeIdx] + ' km';
  saveSettings(); drawRadar(); fitMap();
}
$('zoomIn').onclick = () => setRange(state.rangeIdx - 1);
$('zoomOut').onclick = () => setRange(state.rangeIdx + 1);
$('btnAll').onclick = e => { state.showAll = !state.showAll; e.currentTarget.classList.toggle('on', state.showAll); saveSettings(); drawRadar(); updateMap(); };
$('btnAll').classList.toggle('on', state.showAll);

/* ---- Ansicht: Kompass-Radar oder Karte ---- */
state.view = 'radar';
try { if (localStorage.getItem('fl-view') === 'map') state.view = 'map'; } catch (e) {}
function setView(v) {
  state.view = v;
  try { localStorage.setItem('fl-view', v); } catch (e) {}
  const isMap = v === 'map';
  $('radar').hidden = isMap; $('map').hidden = !isMap;
  $('viewMap').classList.toggle('on', isMap);
  $('viewRadar').classList.toggle('on', !isMap);
  $('viewMap').setAttribute('aria-selected', isMap);
  $('viewRadar').setAttribute('aria-selected', !isMap);
  if (isMap) { initMap(); map.invalidateSize(); fitMap(); updateMap(); } else { sizeCanvas(); }
}
$('viewRadar').onclick = () => { if (state.view !== 'radar') setView('radar'); };
$('viewMap').onclick = () => { if (state.view !== 'map') setView('map'); };

/* ---- Kartenansicht (Leaflet + OpenStreetMap-Kacheln, per CSS abgedunkelt) ---- */
let map = null, userMarker = null, zrhMarker = null;
const mapMarkers = new Map();
function initMap() {
  if (map) return;
  map = L.map('map', { zoomControl: false, zoomSnap: 0.25, attributionControl: true, tap: false });
  map.attributionControl.setPrefix(false);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '© OpenStreetMap-Mitwirkende', className: 'dark-tiles',
  }).addTo(map);
  userMarker = L.marker([state.user.lat, state.user.lon], { icon: L.divIcon({ className: '', html: '<div class="me"></div>', iconSize: [22, 22], iconAnchor: [11, 11] }), interactive: false, zIndexOffset: 1000 }).addTo(map);
  zrhMarker = L.marker([ZRH.lat, ZRH.lon], { icon: L.divIcon({ className: '', html: '<div class="zrh">ZRH</div>', iconSize: [40, 16], iconAnchor: [20, 8] }), interactive: false }).addTo(map);
}
function fitMap() {
  if (!map || state.view !== 'map') return;
  const u = state.user, m = RANGES[state.rangeIdx] * 1000;
  map.fitBounds(L.latLng(u.lat, u.lon).toBounds(m * 2), { animate: false });
}
const planeSvg = '<svg viewBox="-12 -12 24 24"><path d="M0 -10 L2.2 -3 L10 3 L10 5 L2.2 2.5 L1.8 8 L5 10 L5 11.5 L0 10.3 L-5 11.5 L-5 10 L-1.8 8 L-2.2 2.5 L-10 5 L-10 3 L-2.2 -3Z"/></svg>';
function updateMap() {
  if (!map || state.view !== 'map') return;
  const now = Date.now(), u = state.user;
  userMarker.setLatLng([u.lat, u.lon]);
  const selHex = state.sel === 'auto' ? (lastList[0] && lastList[0].hex) : state.sel;
  const seen = new Set();
  for (const rec of state.aircraft.values()) {
    const d = derive(rec, now);
    if (!d || (!state.showAll && (!d.zrh || d.altM > MAX_ALT_M))) continue;
    seen.add(d.hex);
    const sel = d.hex === selHex, cls = 'pm ' + (!d.zrh ? 'oth' : d.status) + (sel ? ' sel' : '');
    const label = d.zrh || sel ? `<b>${d.cs || d.reg || d.hex}</b><i>${Math.round(d.altM / 50) * 50} m</i>` : '';
    const key = cls + '|' + Math.round(d.trk / 3) + '|' + label;
    let m = mapMarkers.get(d.hex);
    if (!m) {
      m = L.marker([d.lat, d.lon], { zIndexOffset: 0 }).addTo(map);
      m.on('click', () => { if (lastList.some(x => x.hex === d.hex)) select(d.hex, false); else { state.sel = d.hex; updateMap(); } });
      mapMarkers.set(d.hex, m);
    }
    m.setLatLng([d.lat, d.lon]);
    m.setZIndexOffset(sel ? 500 : 0);
    if (m._key !== key) {
      m._key = key;
      m.setIcon(L.divIcon({ className: '', iconSize: [30, 30], iconAnchor: [15, 15],
        html: `<div class="${cls}"><span class="pi" style="transform:rotate(${d.trk}deg)">${planeSvg}</span><span class="pl">${label}</span></div>` }));
    }
  }
  for (const [h, m] of mapMarkers) if (!seen.has(h)) { m.remove(); mapMarkers.delete(h); }
}

/* ================= Standort ================= */
// Geländehöhe aus grobem Höhenmodell (Open-Meteo, ~90 m Raster); GPS-Höhe ist zu ungenau
let elevFor = null;
async function updateGroundHeight() {
  const u = state.user;
  if (!u.real) return;
  if (elevFor && Math.hypot(enu(elevFor.lat, elevFor.lon).x, enu(elevFor.lat, elevFor.lon).y) < 0.5) return;
  const here = { lat: u.lat, lon: u.lon };
  elevFor = here;
  try {
    const r = await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${here.lat.toFixed(4)}&longitude=${here.lon.toFixed(4)}`);
    const j = await r.json();
    if (j.elevation && j.elevation.length) { u.alt = j.elevation[0] + EYE_M; u.altSrc = 'dem'; }
  } catch (e) { elevFor = null; }
}
// Name der Gemeinde (BigDataCloud, ohne API-Schlüssel); neu abfragen, wenn man sich >300 m bewegt hat
let placeFor = null;
async function updatePlace() {
  const u = state.user;
  if (!u.real) return;
  if (placeFor) { const e = enu(placeFor.lat, placeFor.lon); if (Math.hypot(e.x, e.y) < 0.3) return; }
  placeFor = { lat: u.lat, lon: u.lon };
  try {
    const r = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${u.lat.toFixed(4)}&longitude=${u.lon.toFixed(4)}&localityLanguage=de`);
    const j = await r.json();
    const gem = (j.localityInfo?.administrative || []).filter(a => a.adminLevel === 8).pop();
    u.place = (gem && gem.name) || j.city || j.locality || null;
  } catch (e) { placeFor = null; }
}
function startGeo() {
  if (qp.has('lat') && qp.has('lon')) {
    Object.assign(state.user, { lat: +qp.get('lat'), lon: +qp.get('lon'), real: true, acc: 0 });
    if (qp.has('alt')) { state.user.alt = +qp.get('alt'); elevFor = { lat: state.user.lat, lon: state.user.lon }; }
    return;
  }
  if (!navigator.geolocation) { state.err = 'Kein GPS verfügbar – Demo-Standort Kloten'; return; }
  navigator.geolocation.watchPosition(pos => {
    const c = pos.coords;
    Object.assign(state.user, { lat: c.latitude, lon: c.longitude, acc: c.accuracy, real: true });
    state.gpsErr = null;
  }, err => { state.gpsErr = err.code === 1 ? 'Standort verweigert – Demo-Standort Kloten' : 'Standort nicht verfügbar – Demo-Standort Kloten'; },
  { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
}

/* ================= Hauptschleife ================= */
function tick() {
  const now = Date.now();
  updateGroundHeight(); updatePlace();
  const list = [];
  for (const [hex, rec] of state.aircraft) {
    if (now - rec.seen > KEEP_MS) { state.aircraft.delete(hex); continue; }
    const d = derive(rec, now);
    if (d && d.zrh) list.push(d);
  }
  list.sort((a, b) => a.d3 - b.d3);
  const shown = list.filter(d => d.altM <= MAX_ALT_M).slice(0, 8);
  updateConcept(list, now);
  renderList(shown);
  drawRadar();
  const u = state.user;
  if (state.view === 'map' && map && u.real && !state.mapFitted) { state.mapFitted = true; fitMap(); }
  updateMap();
  let s;
  if (state.err && now - state.lastFetch > 30000) s = '⚠ Verbindung: ' + state.err;
  else if (state.gpsErr && !u.real) s = state.gpsErr;
  else {
    const age = state.lastFetch ? Math.round((now - state.lastFetch) / 1000) : null;
    s = (u.real ? `Standort ${u.place || '…'}${u.acc ? ' ± ' + Math.round(u.acc) + ' m' : ''}` : 'Suche Standort …') + (age != null ? ` · Daten vor ${age} s` : ' · lade Flugzeuge …');
  }
  $('status').textContent = s;
}
async function loop() {
  let wait = FETCH_MS;
  try { await fetchTraffic(); fails = 0; }
  catch (e) {                                         // z.B. 429/5xx: länger warten, Daten bleiben bis KEEP_MS stehen
    state.err = 'Flugdaten nicht erreichbar';
    wait = Math.min(60000, FETCH_MS * 2 ** Math.min(++fails, 3));
  }
  setTimeout(loop, wait);
}
let fails = 0;

window.addEventListener('resize', sizeCanvas);
new ResizeObserver(sizeCanvas).observe($('radar').parentElement);
setRange(state.rangeIdx);
sizeCanvas();
setView(state.view);
startGeo();
loop();
setInterval(tick, 1000);
setInterval(drawRadar, 100);
tick();
})();
