/**
 * server.js — Moteur TGVmax
 *
 * Charge les données TGVmax générées par tgvmax-ingest.js
 * et expose une API REST pour rechercher des trajets.
 *
 * Routes :
 *   GET /eveille                          — ping / état du moteur
 *   GET /api/meta                         — métadonnées de l'ingestion
 *   GET /api/stops?q=paris                — autocomplétion des gares
 *   GET /api/cities?q=par                 — autocomplétion ville (multi-gares)
 *   GET /api/search?from=X&to=Y&date=D    — recherche de trajets directs TGVmax
 *   GET /api/explore?from=X&date=D        — toutes les destinations disponibles
 *   GET /api/debug/trips?stop=ID&date=D   — debug : départs d'un stop
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');
const url  = require('url');

const DATA_DIR = process.env.DATA_DIR || './engine_data';
const PORT     = process.env.PORT     || 3000;

// ─── Données en RAM ───────────────────────────────────────────────────────────
let trips         = {};  // trip_id → trip object
let stops         = {};  // stop_id → { name, lat, lon }
let routesByStop  = {};  // stop_id → [trip_ids]
let calendarIndex = {};  // date ISO → [trip_ids]
let meta          = {};

let stopsIndex = [];   // pour l'autocomplétion
let cityIndex  = new Map();

const COUNTRY_NAMES = { FR:'France' };

// ─── État du moteur ───────────────────────────────────────────────────────────
let engineReady    = false;
let engineError    = null;
let engineLoadedAt = null;
let engineLoadMs   = null;

function loadJSON(filename) {
  const p = path.join(DATA_DIR, filename);
  if (!fs.existsSync(p)) throw new Error('Fichier manquant : ' + p);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// ─── Chargement ───────────────────────────────────────────────────────────────

function initEngine() {
  console.log('\n🚄 Chargement moteur TGVmax...');
  const t = Date.now();

  trips         = loadJSON('trips.json');
  stops         = loadJSON('stops.json');
  routesByStop  = loadJSON('routes_by_stop.json');
  calendarIndex = loadJSON('calendar_index.json');
  meta          = loadJSON('meta.json');

  buildStopsIndex();

  const totalTrips = Object.keys(trips).length;
  engineLoadMs   = Date.now() - t;
  engineLoadedAt = new Date().toISOString();
  engineReady    = true;
  console.log('✅ Prêt en ' + engineLoadMs + 'ms — ' + totalTrips.toLocaleString() + ' trajets TGVmax chargés\n');
}

// ─── Autocomplétion ───────────────────────────────────────────────────────────

function buildStopsIndex() {
  stopsIndex = [];
  cityIndex  = new Map();

  const stFile = path.join(__dirname, 'stations.json');
  if (fs.existsSync(stFile)) {
    const raw = JSON.parse(fs.readFileSync(stFile, 'utf8'));
    for (const s of raw) {
      const city    = s.city    || s.name;
      const country = s.country || 'FR';
      stopsIndex.push({ name:s.name, city, country, stopIds:s.stopIds||[], operators:s.operators||[], lat:s.lat||0, lon:s.lon||0 });

      const key = city.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'') + ':' + country;
      if (!cityIndex.has(key)) {
        cityIndex.set(key, {
          city, country, countryName: COUNTRY_NAMES[country] || country,
          stopIds: new Set(s.stopIds||[]), ops: new Set(s.operators||[]),
          stations: [], lat: s.lat||0, lon: s.lon||0,
        });
      }
      const ce = cityIndex.get(key);
      for (const sid of (s.stopIds||[])) ce.stopIds.add(sid);
      for (const op  of (s.operators||[])) ce.ops.add(op);
      ce.stations.push({ name:s.name, stopIds:s.stopIds||[] });
    }
    // Garder uniquement les villes avec plusieurs gares
    for (const [key, ce] of cityIndex) {
      if (ce.stations.length < 2) cityIndex.delete(key);
    }
    console.log('  Autocomplétion : ' + stopsIndex.length + ' gares');
    console.log('  Villes multi-gares : ' + cityIndex.size);
    return;
  }

  // Fallback direct depuis stops.json si stations.json absent
  for (const [sid, stop] of Object.entries(stops)) {
    stopsIndex.push({ name:stop.name||sid, city:stop.name||sid, country:'FR',
      stopIds:[sid], operators:['TGVMAX'], lat:stop.lat||0, lon:stop.lon||0 });
  }
  console.log('  Autocomplétion (fallback stops) : ' + stopsIndex.length + ' gares');
}

function searchStops(query, limit=10) {
  const q = query.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  const results = [];
  for (const e of stopsIndex) {
    const nom = e.name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
    if (nom.includes(q)) {
      results.push({ type:'station', ...e });
      if (results.length >= limit) break;
    }
  }
  results.sort((a, b) => {
    const ca = (a.city||a.name).toLowerCase(), cb = (b.city||b.name).toLowerCase();
    return ca !== cb ? ca.localeCompare(cb,'fr') : (a.name||'').localeCompare(b.name||'','fr');
  });
  return results;
}

function searchCities(query) {
  const q = query.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  const results = [];
  for (const [, ce] of cityIndex) {
    const cn = ce.city.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
    if (!cn.startsWith(q) && !cn.includes(q)) continue;
    results.push({
      type:'city', name:ce.city, country:ce.country, countryName:ce.countryName,
      stopIds:[...ce.stopIds], operators:[...ce.ops].sort(),
      stations:ce.stations, lat:ce.lat, lon:ce.lon,
    });
  }
  results.sort((a, b) => {
    const aN = a.name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
    const bN = b.name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
    return (aN.startsWith(q)?0:1)-(bN.startsWith(q)?0:1) || a.name.localeCompare(b.name,'fr');
  });
  return results;
}

// ─── Utilitaires ─────────────────────────────────────────────────────────────

function secondsToHHMM(s) {
  if (s == null) return '--:--';
  const m = Math.floor(s / 60);
  return String(Math.floor(m / 60) % 24).padStart(2,'0') + ':' + String(m % 60).padStart(2,'0');
}

function timeToSeconds(t) {
  if (!t || !t.includes(':')) return 0;
  const [h, m] = t.split(':').map(Number);
  return h * 3600 + m * 60;
}

function resolveStopName(stopId) {
  for (const station of stopsIndex) {
    if ((station.stopIds||[]).includes(stopId)) return station.name;
  }
  return (stops[stopId]?.name) || stopId;
}

function cityKeyOfStop(stopId) {
  for (const s of stopsIndex) {
    if ((s.stopIds||[]).includes(stopId)) {
      const city    = s.city || s.name;
      const country = s.country || 'FR';
      return city.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'') + ':' + country;
    }
  }
  return stopId;
}

// ─── Recherche de trajets TGVmax ──────────────────────────────────────────────
//
// La logique est simple : on cherche tous les trips qui :
//  1. Partent de l'un des fromIds
//  2. Arrivent à l'un des toIds
//  3. Sont disponibles à la date demandée
//  4. Partent après startTime
//
// Les trajets TGVmax sont TOUS directs (pas de correspondances).

function getTripsForDate(dateISO) {
  if (!dateISO) return Object.values(trips);
  const ids = calendarIndex[dateISO] || [];
  return ids.map(id => trips[id]).filter(Boolean);
}

function searchJourneys(fromIds, toIds, dateISO, startTimeSec, limit=8) {
  const fromSet = new Set(fromIds);
  const toSet   = new Set(toIds);

  const dayTrips = getTripsForDate(dateISO);
  const results  = [];

  for (const trip of dayTrips) {
    if (!fromSet.has(trip.origin_id)) continue;
    if (!toSet.has(trip.dest_id))     continue;
    if (trip.dep_time != null && trip.dep_time < startTimeSec) continue;
    if (!trip.dispo) continue;

    results.push({
      trip_id:    trip.trip_id,
      train_no:   trip.train_no,
      date:       trip.date,
      dep_time:   trip.dep_time,
      arr_time:   trip.arr_time,
      dep_str:    trip.dep_str || secondsToHHMM(trip.dep_time),
      arr_str:    trip.arr_str || secondsToHHMM(trip.arr_time),
      duration:   trip.dep_time != null && trip.arr_time != null
                  ? Math.round((trip.arr_time - trip.dep_time) / 60) : null,
      transfers:  0,
      train_types:['TGVMAX'],
      operator:   'TGVMAX',
      from_id:    trip.origin_id,
      to_id:      trip.dest_id,
      from_name:  resolveStopName(trip.origin_id),
      to_name:    resolveStopName(trip.dest_id),
      legs: [{
        from_id:    trip.origin_id,
        to_id:      trip.dest_id,
        from_name:  resolveStopName(trip.origin_id),
        to_name:    resolveStopName(trip.dest_id),
        dep_time:   trip.dep_time,
        arr_time:   trip.arr_time,
        dep_str:    trip.dep_str || secondsToHHMM(trip.dep_time),
        arr_str:    trip.arr_str || secondsToHHMM(trip.arr_time),
        trip_id:    trip.trip_id,
        train_no:   trip.train_no,
        operator:   'TGVMAX',
        train_type: 'TGVMAX',
        duration:   trip.dep_time != null && trip.arr_time != null
                    ? Math.round((trip.arr_time - trip.dep_time) / 60) : null,
      }],
    });
  }

  results.sort((a, b) => (a.dep_time || 0) - (b.dep_time || 0));
  return results.slice(0, limit);
}

// ─── Explore : toutes destinations depuis une gare ────────────────────────────

function exploreDestinations(fromIds, dateISO) {
  const fromSet = new Set(fromIds);
  const dayTrips = getTripsForDate(dateISO);
  const bestByDest = {};

  for (const trip of dayTrips) {
    if (!fromSet.has(trip.origin_id)) continue;
    if (!trip.dispo) continue;

    const did = trip.dest_id;
    const dur = trip.dep_time != null && trip.arr_time != null
      ? trip.arr_time - trip.dep_time : Infinity;

    if (!bestByDest[did] || dur < bestByDest[did].duration) {
      bestByDest[did] = {
        trip_id:   trip.trip_id,
        dest_id:   did,
        dest_name: resolveStopName(did),
        dep_str:   trip.dep_str || secondsToHHMM(trip.dep_time),
        arr_str:   trip.arr_str || secondsToHHMM(trip.arr_time),
        dep_time:  trip.dep_time,
        arr_time:  trip.arr_time,
        duration:  dur !== Infinity ? Math.round(dur / 60) : null,
        dest_lat:  stops[did]?.lat || 0,
        dest_lon:  stops[did]?.lon || 0,
        train_types:['TGVMAX'],
        transfers: 0,
        legs: [{
          from_id:   trip.origin_id,
          to_id:     did,
          from_name: resolveStopName(trip.origin_id),
          to_name:   resolveStopName(did),
          dep_str:   trip.dep_str || secondsToHHMM(trip.dep_time),
          arr_str:   trip.arr_str || secondsToHHMM(trip.arr_time),
          dep_time:  trip.dep_time,
          arr_time:  trip.arr_time,
          operator:  'TGVMAX',
          train_type:'TGVMAX',
          train_no:  trip.train_no,
        }],
      };
    }
  }

  return Object.values(bestByDest);
}

// ─── HTTP ─────────────────────────────────────────────────────────────────────

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
function jsonResp(res, data, status=200) {
  cors(res);
  res.writeHead(status, { 'Content-Type':'application/json' });
  res.end(JSON.stringify(data));
}
function serveFile(res, fp) {
  if (!fs.existsSync(fp)) { res.writeHead(404); res.end('Not found'); return; }
  const mime = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css', '.svg':'image/svg+xml' };
  cors(res);
  res.writeHead(200, { 'Content-Type': mime[path.extname(fp)] || 'text/plain' });
  fs.createReadStream(fp).pipe(res);
}
function getBody(req) {
  return new Promise(r => {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => { try { r(JSON.parse(b)); } catch { r({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const p = parsed.pathname, q = parsed.query;

  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); res.end(); return; }

  // ── Ping keep-alive ──
  if (p === '/eveille') {
    return jsonResp(res, {
      ok:        true,
      ready:     engineReady,
      uptime_s:  Math.floor(process.uptime()),
      loaded_at: engineLoadedAt,
      load_ms:   engineLoadMs,
      message:   engineReady ? '✅ Moteur TGVmax opérationnel' : '⏳ Chargement en cours…',
    });
  }

  // ── Bloquer les API tant que l'engine charge ──
  if (p.startsWith('/api/') && !engineReady) {
    return jsonResp(res, {
      error:   'Serveur en cours de démarrage, réessayez dans quelques secondes.',
      ready:   false,
      load_ms: engineLoadMs,
    }, 503);
  }

  // ── /api/meta ──
  if (p === '/api/meta') {
    if (!engineReady) return jsonResp(res, { warming: true }, 503);
    return jsonResp(res, meta);
  }

  // ── /api/stops ──
  if (p === '/api/stops') {
    const qs = (q.q || '').trim();
    return jsonResp(res, qs ? searchStops(qs, 10) : []);
  }

  // ── /api/cities ──
  if (p === '/api/cities') {
    const qs = (q.q || '').trim();
    if (!qs || qs.length < 2) return jsonResp(res, []);
    return jsonResp(res, searchCities(qs));
  }

  // ── /api/search ──
  if (p === '/api/search') {
    const t0       = Date.now();
    const fromIds  = (q.from  || '').split(',').filter(Boolean);
    const toIds    = (q.to    || '').split(',').filter(Boolean);
    const dateStr  = (q.date  || '').trim();
    const timeStr  = (q.time  || '00:00').trim();
    const limit    = Math.min(parseInt(q.limit || '8'), 50);
    const offset   = parseInt(q.offset || '0');
    const afterDep = parseInt(q.after_dep || '0');

    if (!fromIds.length || !toIds.length) {
      return jsonResp(res, { error: 'Paramètres from et to requis' }, 400);
    }

    const startSec = Math.max(timeToSeconds(timeStr) + offset, afterDep || 0);

    console.log('\n[SEARCH TGVmax]', dateStr || 'sans date', timeStr);
    console.log('  from:', fromIds.join(','), '→ to:', toIds.join(','));

    const journeys  = searchJourneys(fromIds, toIds, dateStr, startSec, limit);
    const lastDep   = journeys.length ? Math.max(...journeys.map(j => j.dep_time||0)) : startSec;
    const nextOffset = lastDep - timeToSeconds(timeStr);

    console.log('  Résultats :', journeys.length);

    return jsonResp(res, {
      journeys,
      computed_ms:  Date.now() - t0,
      next_offset:  nextOffset,
      last_dep_time: lastDep,
    });
  }

  // ── /api/explore ──
  if (p === '/api/explore') {
    const t0      = Date.now();
    const fromIds = (q.from || '').split(',').filter(Boolean);
    const dateStr = (q.date || '').trim();

    if (!fromIds.length) return jsonResp(res, { error: 'Paramètre from requis' }, 400);

    console.log('\n[EXPLORE TGVmax]', dateStr || 'sans date', '| from:', fromIds.join(','));

    const journeys = exploreDestinations(fromIds, dateStr);

    console.log(`  → ${journeys.length} destinations | ${Date.now()-t0}ms`);
    return jsonResp(res, { journeys, computed_ms: Date.now()-t0 });
  }

  // ── /api/debug/trips ──
  if (p === '/api/debug/trips') {
    const stopId  = q.stop  || '';
    const dateISO = q.date  || '';
    const trainNo = q.train || '';

    if (trainNo) {
      const found = Object.values(trips).filter(t => t.train_no === trainNo);
      return jsonResp(res, { train_no: trainNo, trips: found });
    }

    if (stopId) {
      const tripIds = (routesByStop[stopId] || []);
      const filtered = dateISO
        ? tripIds.filter(id => trips[id]?.date === dateISO)
        : tripIds;
      const out = filtered
        .map(id => trips[id])
        .filter(Boolean)
        .sort((a, b) => (a.dep_time||0) - (b.dep_time||0))
        .map(t => ({
          trip_id:  t.trip_id,
          train_no: t.train_no,
          date:     t.date,
          from:     resolveStopName(t.origin_id),
          to:       resolveStopName(t.dest_id),
          dep:      t.dep_str || secondsToHHMM(t.dep_time),
          arr:      t.arr_str || secondsToHHMM(t.arr_time),
          dispo:    t.dispo,
        }));
      return jsonResp(res, { stop: stopId, stop_name: resolveStopName(stopId), date: dateISO||'tous', departures: out });
    }

    return jsonResp(res, { error: 'Param stop= ou train= requis. Ex: /api/debug/trips?stop=TGVMAX:paris&date=2026-03-15' }, 400);
  }

  // ── Fichiers statiques ──
  const staticMap = { '/':'index.html', '/index.html':'index.html', '/trajets.html':'trajets.html' };
  if (staticMap[p]) return serveFile(res, path.join(__dirname, staticMap[p]));

  const assetPath = path.join(__dirname, p);
  if (fs.existsSync(assetPath) && fs.statSync(assetPath).isFile()) return serveFile(res, assetPath);

  res.writeHead(404); res.end('Not found');
});

// ─── Démarrage ────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log('🌐 http://localhost:' + PORT + '  (moteur en cours de chargement…)');
  try {
    initEngine();
  } catch (err) {
    engineError = err.message;
    console.error('❌ Échec chargement moteur :', err);
  }
});
