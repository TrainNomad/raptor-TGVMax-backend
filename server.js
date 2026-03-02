/**
 * server.js — TGVmax Engine
 *
 * GET /search?from=Paris&to=Lyon&date=2025-06-15
 *            [&maxChanges=1]       — 0=direct, 1=1 correspondance, 2=2 correspondances (défaut: 1)
 *            [&minTransfer=30]     — minutes de correspondance minimum (défaut: 30)
 *            [&maxTransfer=180]    — minutes de correspondance maximum (défaut: 180)
 *
 * GET /stations?q=paris
 * GET /health
 */

'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');
const url  = require('url');

const PORT      = process.env.PORT     || 3000;
const DATA_DIR  = process.env.DATA_DIR || './engine_data';
const STATIONS_FILE = path.join(__dirname, 'stations.json');

// ─── Chargement des données ───────────────────────────────────────────────────

console.log('\n📦 Chargement engine_data...');

function loadJSON(filename) {
  const p = path.join(DATA_DIR, filename);
  if (!fs.existsSync(p)) throw new Error(`Fichier manquant : ${p}`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

const trips         = loadJSON('trips.json');
const stops         = loadJSON('stops.json');
const routesByStop  = loadJSON('routes_by_stop.json');
const calendarIndex = loadJSON('calendar_index.json');
const meta          = loadJSON('meta.json');

let stations = [];
if (fs.existsSync(STATIONS_FILE)) {
  stations = JSON.parse(fs.readFileSync(STATIONS_FILE, 'utf8'));
}

console.log(`  ✓ ${Object.keys(trips).length.toLocaleString()} trajets`);
console.log(`  ✓ ${Object.keys(stops).length.toLocaleString()} gares`);
console.log(`  ✓ ${stations.length} stations indexées`);
console.log(`  ✓ Données du ${meta.date_range?.first} au ${meta.date_range?.last}\n`);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalize(str) {
  return (str || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function json(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type':  'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

// ─── Résolution stopIds depuis nom de ville ───────────────────────────────────

function resolveStopIds(query) {
  const q = normalize(query);
  if (!q) return [];

  // 1. Match exact sur stations.json (ville regroupée)
  const exact = stations.find(s => normalize(s.name) === q || normalize(s.city) === q);
  if (exact) return exact.stopIds;

  // 2. Match partiel sur stations.json
  const partial = stations.filter(s =>
    normalize(s.name).includes(q) || normalize(s.city).includes(q)
  );
  if (partial.length > 0) return [...new Set(partial.flatMap(s => s.stopIds))];

  // 3. Fallback : stops.json brut
  return Object.keys(stops).filter(id => normalize(stops[id].name).includes(q));
}

// ─── Formatage d'un trip ──────────────────────────────────────────────────────

function formatTrip(trip) {
  return {
    trip_id:    trip.trip_id,
    train_no:   trip.train_no,
    date:       trip.date,
    from:       stops[trip.origin_id]?.name || trip.origin_id,
    to:         stops[trip.dest_id]?.name   || trip.dest_id,
    from_id:    trip.origin_id,
    to_id:      trip.dest_id,
    dep:        trip.dep_str,
    arr:        trip.arr_str,
    dep_sec:    trip.dep_time,
    arr_sec:    trip.arr_time,
    operator:   trip.operator,
    train_type: trip.train_type,
  };
}

// ─── Recherche directe ────────────────────────────────────────────────────────

function findDirectTrips(fromStopIds, toStopIds, date) {
  const fromSet = new Set(fromStopIds);
  const toSet   = new Set(toStopIds);
  const dayTrips = calendarIndex[date] || [];
  const results = [];

  for (const tripId of dayTrips) {
    const t = trips[tripId];
    if (t && fromSet.has(t.origin_id) && toSet.has(t.dest_id)) {
      results.push(t);
    }
  }

  results.sort((a, b) => a.dep_time - b.dep_time);
  return results;
}

// ─── Recherche avec correspondances ──────────────────────────────────────────
/**
 * Algo :
 *  1. Construire un index { stopId → [trips partant de ce stop ce jour-là] }
 *  2. Pour chaque trip depuis `from`, trouver les gares intermédiaires
 *  3. Depuis chaque gare intermédiaire, chercher les trips vers `to`
 *     en vérifiant minTransfer <= attente <= maxTransfer
 *  4. Si maxChanges = 2, répéter une fois de plus
 */
function findTripsWithChanges(fromStopIds, toStopIds, date, opts = {}) {
  const {
    maxChanges  = 1,
    minTransfer = 30,   // minutes
    maxTransfer = 180,  // minutes
  } = opts;

  const minSec = minTransfer * 60;
  const maxSec = maxTransfer * 60;

  const fromSet  = new Set(fromStopIds);
  const toSet    = new Set(toStopIds);
  const dayTrips = calendarIndex[date] || [];

  // Index rapide stopId → trips qui en PARTENT ce jour-là
  const byOrigin = {};
  for (const tripId of dayTrips) {
    const t = trips[tripId];
    if (!t) continue;
    (byOrigin[t.origin_id] = byOrigin[t.origin_id] || []).push(t);
  }

  const results = [];

  // ── 1 correspondance ────────────────────────────────────────────────
  for (const tripId of dayTrips) {
    const t1 = trips[tripId];
    if (!t1 || !fromSet.has(t1.origin_id)) continue;
    if (toSet.has(t1.dest_id)) continue; // direct, ignoré ici

    for (const t2 of (byOrigin[t1.dest_id] || [])) {
      if (!toSet.has(t2.dest_id)) continue;
      const wait = t2.dep_time - t1.arr_time;
      if (wait < minSec || wait > maxSec) continue;

      results.push({
        type:          'connection',
        changes:       1,
        total_dep:     t1.dep_str,
        total_arr:     t2.arr_str,
        total_dep_sec: t1.dep_time,
        total_arr_sec: t2.arr_time,
        duration_min:  Math.round((t2.arr_time - t1.dep_time) / 60),
        transfer_min:  Math.round(wait / 60),
        legs: [
          { ...formatTrip(t1), leg: 1 },
          { ...formatTrip(t2), leg: 2, transfer_wait_min: Math.round(wait / 60) },
        ],
        via: [stops[t1.dest_id]?.name || t1.dest_id],
      });
    }
  }

  // ── 2 correspondances ───────────────────────────────────────────────
  if (maxChanges >= 2) {
    for (const tripId of dayTrips) {
      const t1 = trips[tripId];
      if (!t1 || !fromSet.has(t1.origin_id)) continue;
      if (toSet.has(t1.dest_id)) continue;

      for (const t2 of (byOrigin[t1.dest_id] || [])) {
        const wait1 = t2.dep_time - t1.arr_time;
        if (wait1 < minSec || wait1 > maxSec) continue;
        if (toSet.has(t2.dest_id)) continue; // 1 correspondance, déjà géré

        for (const t3 of (byOrigin[t2.dest_id] || [])) {
          if (!toSet.has(t3.dest_id)) continue;
          const wait2 = t3.dep_time - t2.arr_time;
          if (wait2 < minSec || wait2 > maxSec) continue;

          results.push({
            type:          'connection',
            changes:       2,
            total_dep:     t1.dep_str,
            total_arr:     t3.arr_str,
            total_dep_sec: t1.dep_time,
            total_arr_sec: t3.arr_time,
            duration_min:  Math.round((t3.arr_time - t1.dep_time) / 60),
            transfer_min:  Math.round((wait1 + wait2) / 60),
            legs: [
              { ...formatTrip(t1), leg: 1 },
              { ...formatTrip(t2), leg: 2, transfer_wait_min: Math.round(wait1 / 60) },
              { ...formatTrip(t3), leg: 3, transfer_wait_min: Math.round(wait2 / 60) },
            ],
            via: [
              stops[t1.dest_id]?.name || t1.dest_id,
              stops[t2.dest_id]?.name || t2.dest_id,
            ],
          });
        }
      }
    }
  }

  results.sort((a, b) =>
    a.total_dep_sec !== b.total_dep_sec
      ? a.total_dep_sec - b.total_dep_sec
      : a.duration_min - b.duration_min
  );

  return results;
}

// ─── Route /search ────────────────────────────────────────────────────────────

function handleSearch(query, res) {
  const from        = (query.from || '').trim();
  const to          = (query.to   || '').trim();
  const date        = (query.date || '').trim();
  const maxChanges  = Math.min(2, Math.max(0, parseInt(query.maxChanges  ?? 1)));
  const minTransfer = Math.max(0,             parseInt(query.minTransfer ?? 30));
  const maxTransfer = Math.max(minTransfer,   parseInt(query.maxTransfer ?? 180));

  if (!from || !to || !date) {
    return json(res, { error: 'Paramètres requis : from, to, date (YYYY-MM-DD)' }, 400);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return json(res, { error: 'Format date invalide. Attendu : YYYY-MM-DD' }, 400);
  }

  const fromStopIds = resolveStopIds(from);
  const toStopIds   = resolveStopIds(to);

  if (!fromStopIds.length) return json(res, { error: `Gare de départ inconnue : ${from}` }, 404);
  if (!toStopIds.length)   return json(res, { error: `Gare d'arrivée inconnue : ${to}` }, 404);

  const t0 = Date.now();

  // Trajets directs
  const directTrips = findDirectTrips(fromStopIds, toStopIds, date).map(t => ({
    type:          'direct',
    changes:       0,
    total_dep:     t.dep_str,
    total_arr:     t.arr_str,
    total_dep_sec: t.dep_time,
    total_arr_sec: t.arr_time,
    duration_min:  t.arr_time != null && t.dep_time != null
                     ? Math.round((t.arr_time - t.dep_time) / 60)
                     : null,
    transfer_min:  0,
    legs:          [{ ...formatTrip(t), leg: 1 }],
    via:           [],
  }));

  // Trajets avec correspondances
  const connectionTrips = maxChanges >= 1
    ? findTripsWithChanges(fromStopIds, toStopIds, date, { maxChanges, minTransfer, maxTransfer })
    : [];

  const allResults = [...directTrips, ...connectionTrips]
    .sort((a, b) => a.total_dep_sec - b.total_dep_sec);

  json(res, {
    query: {
      from, to, date,
      from_stop_ids: fromStopIds,
      to_stop_ids:   toStopIds,
      maxChanges, minTransfer, maxTransfer,
    },
    stats: {
      total:       allResults.length,
      direct:      directTrips.length,
      connections: connectionTrips.length,
      elapsed_ms:  Date.now() - t0,
    },
    results: allResults,
  });
}

// ─── Route /stations ──────────────────────────────────────────────────────────

function handleStations(query, res) {
  const q = normalize(query.q || '');
  if (!q || q.length < 2) {
    return json(res, { error: 'Paramètre q requis (min 2 caractères)' }, 400);
  }
  const matches = stations
    .filter(s => normalize(s.name).includes(q) || normalize(s.city).includes(q))
    .slice(0, 20)
    .map(s => ({ name: s.name, city: s.city, country: s.country, stopIds: s.stopIds, lat: s.lat, lon: s.lon }));

  json(res, { query: query.q, count: matches.length, results: matches });
}

// ─── Route /health ────────────────────────────────────────────────────────────

function handleHealth(res) {
  json(res, {
    status:     'ok',
    trips:      Object.keys(trips).length,
    stops:      Object.keys(stops).length,
    stations:   stations.length,
    date_range: meta.date_range,
    generated:  meta.generated_at,
  });
}

// ─── Serveur HTTP ─────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  const parsed   = url.parse(req.url, true);
  const pathname = parsed.pathname.replace(/\/$/, '') || '/';

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
    return res.end();
  }
  if (req.method !== 'GET') {
    return json(res, { error: 'Méthode non supportée' }, 405);
  }

  try {
    if (pathname === '/search')   return handleSearch(parsed.query, res);
    if (pathname === '/stations') return handleStations(parsed.query, res);
    if (pathname === '/health')   return handleHealth(res);

    json(res, {
      message:   'TGVmax Engine',
      endpoints: [
        'GET /search?from=Paris&to=Lyon&date=YYYY-MM-DD[&maxChanges=1][&minTransfer=30][&maxTransfer=180]',
        'GET /stations?q=paris',
        'GET /health',
      ],
    });
  } catch (err) {
    console.error('Erreur requête:', err);
    json(res, { error: 'Erreur interne', detail: err.message }, 500);
  }
});

server.listen(PORT, () => {
  console.log(`✅ Serveur démarré sur http://localhost:${PORT}`);
  console.log(`   Exemples :`);
  console.log(`   /search?from=Caen&to=Lyon&date=2025-06-15&maxChanges=1&minTransfer=30`);
  console.log(`   /search?from=Caen&to=Nice&date=2025-06-15&maxChanges=2&minTransfer=45\n`);
});