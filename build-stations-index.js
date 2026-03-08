/**
 * build-stations-index.js
 *
 * Génère stations.json en croisant :
 *   - engine_data/stops.json  (gares réellement présentes dans TGVmax, avec IDs FR+TVS)
 *   - stations.csv            (référentiel SNCF : noms officiels, coordonnées GPS)
 *
 * Chaque gare TGVmax est maintenant identifiée par son vrai code FR+TVS (ex: FRPMP).
 * stations.json contient une entrée par gare réelle, avec le vrai nom SNCF.
 *
 * Usage :
 *   node build-stations-index.js
 *   node build-stations-index.js ./engine_data ./stations.json ./stations.csv
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const DATA_DIR   = process.argv[2] || './engine_data';
const OUT_FILE   = process.argv[3] || path.join(__dirname, 'stations.json');
const CSV_FILE   = process.argv[4] || path.join(__dirname, 'stations.csv');
const STOPS_FILE = path.join(DATA_DIR, 'stops.json');

// ─── Chargement du CSV stations ───────────────────────────────────────────────

function loadCsvLookup(csvPath) {
  if (!fs.existsSync(csvPath)) {
    console.warn('  ⚠️  stations.csv introuvable — les coords et noms viennent de stops.json');
    return {};
  }

  const raw    = fs.readFileSync(csvPath, 'utf8');
  const lines  = raw.split('\n');
  const header = lines[0].split(';');
  const idx    = {};
  header.forEach((h, i) => { idx[h.trim()] = i; });

  const COL = {
    name:       idx['name'],
    lat:        idx['latitude'],
    lon:        idx['longitude'],
    tvs:        idx['sncf_tvs_id'],
    enabled:    idx['sncf_is_enabled'],
    country:    idx['country'],
    suggestable:idx['is_suggestable'],
    isMain:     idx['is_main_station'],
  };

  const lookup = {};  // 'FR' + tvs → { name, lat, lon }

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(';');
    if (!cols[COL.tvs] || cols[COL.country] !== 'FR') continue;
    const tvs  = 'FR' + cols[COL.tvs].trim();
    const name = (cols[COL.name] || '').trim();
    const lat  = parseFloat(cols[COL.lat]) || 0;
    const lon  = parseFloat(cols[COL.lon]) || 0;
    if (!tvs || !name) continue;
    if (!lookup[tvs]) lookup[tvs] = { name, lat, lon };
  }

  return lookup;
}

// ─── Extraction ville depuis nom officiel ─────────────────────────────────────

function extractCity(officialName) {
  let base = officialName.trim();

  // Cas spéciaux Paris / Lyon / Marseille / CDG
  if (/^Paris\b/i.test(base))              return 'Paris';
  if (/^Lyon\b/i.test(base))               return 'Lyon';
  if (/^Marseille\b/i.test(base))          return 'Marseille';
  if (/^Aéroport Paris\b/i.test(base))     return 'Paris (CDG)';
  if (/^Aeroport Paris\b/i.test(base))     return 'Paris (CDG)';

  // Couper sur tiret long (séparateur de quartier) : "Marne-la-Vallée – Chessy" → "Marne-la-Vallée"
  const longDash = base.indexOf(' – ');
  if (longDash > 2) base = base.slice(0, longDash).trim();

  // Supprimer suffixes de type "TGV", "Centre", "Ville" en fin
  base = base.replace(/\s+(TGV|Ouigo|Centre|Ville|Gare)\s*$/i, '').trim();

  // Couper aux qualificatifs de gare courants
  const STATION_WORDS = [
    "Gare du Nord", "Gare de Lyon", "Gare de l'Est",
    'St-Charles', 'Saint-Charles', 'St-Laud', 'Saint-Laud',
    'St-Jean', 'Saint-Jean', 'Part-Dieu', 'Perrache',
    'Montparnasse', 'Austerlitz', 'Bourgogne',
  ];
  for (const sw of STATION_WORDS) {
    const swIdx = base.indexOf(sw);
    if (swIdx > 0) { base = base.slice(0, swIdx).trim().replace(/[-\s]+$/, ''); break; }
  }

  return base;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

console.log('\n🔨 Construction stations.json depuis stops.json + stations.csv...\n');

if (!fs.existsSync(STOPS_FILE)) {
  console.error('❌ ' + STOPS_FILE + ' introuvable. Lance d\'abord : node tgvmax-ingest.js');
  process.exit(1);
}

const stops     = JSON.parse(fs.readFileSync(STOPS_FILE, 'utf8'));
const csvLookup = loadCsvLookup(CSV_FILE);

console.log('  stops.json  : ' + Object.keys(stops).length + ' arrêts');
console.log('  stations.csv: ' + Object.keys(csvLookup).length + ' gares FR\n');

// ─── Construction ─────────────────────────────────────────────────────────────

const stations = [];
let resolvedFromCsv   = 0;
let resolvedFromStops = 0;

for (const [stopId, stop] of Object.entries(stops)) {
  const csvInfo = csvLookup[stopId];

  const name = csvInfo?.name || stop.name || stopId;
  const lat  = (csvInfo?.lat) ? csvInfo.lat : (stop.lat || 0);
  const lon  = (csvInfo?.lon) ? csvInfo.lon : (stop.lon || 0);
  const city = extractCity(name);

  if (csvInfo) resolvedFromCsv++; else resolvedFromStops++;

  stations.push({
    id:        stopId,      // "FRPMP" ou "TGVMAX:slug" en fallback
    name,                   // "Paris Montparnasse"
    city,                   // "Paris"
    country:   'FR',
    stopIds:   [stopId],    // compat server.js
    operators: ['TGVMAX'],
    lat,
    lon,
  });
}

stations.sort((a, b) => a.name.localeCompare(b.name, 'fr'));

// ─── Écriture ─────────────────────────────────────────────────────────────────

fs.writeFileSync(OUT_FILE, JSON.stringify(stations, null, 2), 'utf8');
const sizeKb = Math.round(fs.statSync(OUT_FILE).size / 1024);

console.log('  ✅ ' + resolvedFromCsv + ' gares résolues CSV (noms & coords SNCF officiels)');
console.log('  ⚠️  ' + resolvedFromStops + ' gares fallback slug');
console.log('\n✅ stations.json : ' + stations.length + ' gares — ' + sizeKb + ' KB');

// ─── Diagnostic ───────────────────────────────────────────────────────────────

console.log('\n── Diagnostic gares clés ─────────────────────────────────────────');
const CHECK = [
  ['FRPMP', 'Paris Montparnasse'],
  ['FRPNO', 'Paris Gare du Nord'],
  ['FRPLY', 'Paris Gare de Lyon'],
  ['FRPES', "Paris Gare de l'Est"],
  ['FRPSL', 'Paris St-Lazare'],
  ['FRLYD', 'Lyon Part-Dieu'],
  ['FRLPR', 'Lyon Perrache'],
  ['FRMSC', 'Marseille St-Charles'],
  ['FRBXJ', 'Bordeaux St-Jean'],
  ['FRRES', 'Rennes'],
  ['FRNTS', 'Nantes'],
  ['FRSTG', 'Strasbourg'],
  ['FRASL', 'Angers St-Laud'],
  ['FRMPW', 'Massy TGV'],
  ['FRMLV', 'Marne-la-Vallée Chessy'],
  ['FRAXV', 'Aix-en-Provence TGV'],
  ['FRSPC', 'St-Pierre-des-Corps'],
  ['FRRYT', 'CDG2 TGV'],
];

const byId = new Map(stations.map(s => [s.id, s]));
for (const [id, label] of CHECK) {
  const s = byId.get(id);
  if (s) {
    console.log('  ✅ ' + label.padEnd(30) + ' → ' + s.name + ' [' + s.id + ']');
  } else {
    console.log('  ❌ ' + label.padEnd(30) + '   ' + id + ' absent de stops.json (non servi par TGVmax ?)');
  }
}

const unresolved = stations.filter(s => s.id.startsWith('TGVMAX:'));
if (unresolved.length) {
  console.log('\n── ⚠️  Gares non résolues (encore en slug) ──────────────────────');
  for (const s of unresolved.slice(0, 15)) {
    console.log('  ' + s.id.padEnd(40) + ' "' + s.name + '"');
  }
  if (unresolved.length > 15) console.log('  … et ' + (unresolved.length - 15) + ' autres');
}

console.log('\n→ Lancez ensuite : node server.js\n');