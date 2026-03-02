/**
 * build-stations-index.js
 *
 * Génère stations.json à partir des gares extraites par tgvmax-ingest.js
 * (engine_data/stops.json).
 *
 * Chaque entrée stations.json contient :
 *   { name, city, country, stopIds, operators, lat, lon }
 *
 * Usage :
 *   node build-stations-index.js
 *   node build-stations-index.js ./engine_data ./stations.json
 */

const fs   = require('fs');
const path = require('path');

const DATA_DIR = process.argv[2] || './engine_data';
const OUT_FILE = process.argv[3] || path.join(__dirname, 'stations.json');

const STOPS_FILE = path.join(DATA_DIR, 'stops.json');

// ─── Extraction de la ville depuis le nom de la gare ─────────────────────────
// Les noms TGVmax sont du type "PARIS (intramuros)", "LYON (intramuros)", etc.
// On extrait la partie avant la parenthèse, puis on normalise.

function extractCity(name) {
  // Supprimer les parenthèses et leur contenu : "PARIS (intramuros)" → "PARIS"
  let city = name.replace(/\s*\(.*\)\s*$/, '').trim();

  // Mettre en Title Case
  city = city.toLowerCase().replace(/\b(\w)/g, c => c.toUpperCase());

  // Normaliser les cas courants
  const MAP = {
    'Paris':       'Paris',
    'Lyon':        'Lyon',
    'Marseille':   'Marseille',
    'Bordeaux':    'Bordeaux',
    'Nantes':      'Nantes',
    'Toulouse':    'Toulouse',
    'Lille':       'Lille',
    'Strasbourg':  'Strasbourg',
    'Rennes':      'Rennes',
    'Nice':        'Nice',
    'Montpellier': 'Montpellier',
  };
  return MAP[city] || city;
}

// ─── Normalisation pour dédupliquer ──────────────────────────────────────────

function normalize(name) {
  return (name || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Main ─────────────────────────────────────────────────────────────────────

console.log('\n🔨 Construction stations.json depuis engine_data/stops.json...\n');

if (!fs.existsSync(STOPS_FILE)) {
  console.error('❌ ' + STOPS_FILE + ' introuvable. Lance d\'abord : node tgvmax-ingest.js');
  process.exit(1);
}

const stops = JSON.parse(fs.readFileSync(STOPS_FILE, 'utf8'));
console.log('  stops.json : ' + Object.keys(stops).length + ' arrêts');

// ─── Grouper les stop_ids par nom normalisé ───────────────────────────────────
// L'API peut retourner des variantes orthographiques du même nom de gare.
// On les regroupe sous le nom le plus courant.

const groups = new Map(); // normalize(name) → { name, stopIds, lat, lon, count }

for (const [stopId, stop] of Object.entries(stops)) {
  const key = normalize(stop.name);
  if (!groups.has(key)) {
    groups.set(key, {
      name:    stop.name,
      stopIds: [stopId],
      lat:     stop.lat || 0,
      lon:     stop.lon || 0,
      count:   1,
    });
  } else {
    const g = groups.get(key);
    g.stopIds.push(stopId);
    g.count++;
    // Garder le nom le plus court (souvent le plus propre)
    if (stop.name.length < g.name.length) g.name = stop.name;
    // Mettre à jour les coords si on n'en avait pas
    if (!g.lat && stop.lat) { g.lat = stop.lat; g.lon = stop.lon; }
  }
}

// ─── Construction du tableau stations ────────────────────────────────────────

const stations = [];

for (const g of groups.values()) {
  // Formater le nom : "PARIS (intramuros)" → "Paris"
  // On garde le nom brut mais on le met en Title Case pour l'affichage
  const displayName = g.name
    .replace(/\s*\(.*\)\s*$/, '')
    .trim()
    .toLowerCase()
    .replace(/\b(\w)/g, c => c.toUpperCase());

  stations.push({
    name:      displayName,
    city:      extractCity(g.name),
    country:   'FR',
    stopIds:   g.stopIds,
    operators: ['TGVMAX'],
    lat:       g.lat,
    lon:       g.lon,
  });
}

// ─── Tri : par nombre d'occurrences puis alphabétique ────────────────────────

const countByStop = {};
for (const g of groups.values()) {
  for (const sid of g.stopIds) countByStop[sid] = g.count;
}

stations.sort((a, b) => {
  const scoreA = a.stopIds.reduce((s, id) => s + (countByStop[id] || 0), 0);
  const scoreB = b.stopIds.reduce((s, id) => s + (countByStop[id] || 0), 0);
  if (scoreB !== scoreA) return scoreB - scoreA;
  return a.name.localeCompare(b.name, 'fr');
});

// ─── Villes multi-gares ───────────────────────────────────────────────────────
// Détecter les villes représentées par plusieurs gares (ex : Paris Gare de Lyon,
// Paris Gare du Nord, etc.) pour enrichir l'autocomplétion.
const cityCount = {};
for (const s of stations) {
  const c = s.city;
  cityCount[c] = (cityCount[c] || 0) + 1;
}
const multiCity = new Set(Object.keys(cityCount).filter(c => cityCount[c] > 1));
console.log('  Villes multi-gares : ' + [...multiCity].join(', '));

// ─── Écriture ─────────────────────────────────────────────────────────────────

fs.writeFileSync(OUT_FILE, JSON.stringify(stations, null, 2), 'utf8');
const sizeKb = Math.round(fs.statSync(OUT_FILE).size / 1024);
console.log('\n✅ stations.json : ' + stations.length + ' gares — ' + sizeKb + ' KB');

// ─── Diagnostic gares clés ────────────────────────────────────────────────────
console.log('\n── Diagnostic gares clés ─────────────────────────────────────────');
const CHECK = ['Paris', 'Lyon', 'Marseille', 'Bordeaux', 'Nantes', 'Toulouse',
               'Lille', 'Strasbourg', 'Rennes', 'Nice', 'Montpellier'];

for (const city of CHECK) {
  const found = stations.filter(s => s.city === city);
  if (found.length) {
    console.log(`  ✅ ${city.padEnd(15)} ${found.length} gare(s) : ${found.map(s => s.name).join(', ')}`);
  } else {
    console.log(`  ❌ ${city} — aucune gare trouvée`);
  }
}

console.log('\n→ Lancez ensuite : node server.js\n');
