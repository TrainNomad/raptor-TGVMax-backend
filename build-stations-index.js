/**
 * build-stations-index.js
 *
 * Génère stations.json à partir des gares extraites par tgvmax-ingest.js
 * (engine_data/stops.json).
 *
 * Stratégie de regroupement :
 *   - Les noms TGVmax sont du type "PARIS (intramuros)", "PARIS-MONTPARNASSE 1 ET 2", etc.
 *   - On regroupe d'abord par ville (partie avant la parenthèse / tiret / espace)
 *   - Tous les stops d'une même ville sont fusionnés sous une seule entrée
 *   - Cela garantit que chercher "Paris" trouve TOUS les trains vers Paris,
 *     quelle que soit la gare exacte (Montparnasse, Gare de Lyon, Nord, etc.)
 *
 * Chaque entrée stations.json contient :
 *   { name, city, country, stopIds[], operators[], lat, lon }
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

// ─── Extraction du nom de ville depuis le nom brut TGVmax ─────────────────────
// "PARIS (intramuros)"          → "Paris"
// "PARIS-MONTPARNASSE 1 ET 2"  → "Paris-Montparnasse"  (gardé tel quel, Paris = ville)
// "LYON PART DIEU"             → "Lyon Part Dieu"
// "MARSEILLE ST CHARLES"       → "Marseille St Charles"
// On extrait la VILLE (premier mot ou groupe avant parenthèse) pour le regroupement,
// mais on garde le nom complet formaté pour l'affichage.

function toTitleCase(str) {
  return str.toLowerCase().replace(/\b(\w)/g, c => c.toUpperCase());
}

function extractCityKey(rawName) {
  // Supprimer les parenthèses : "PARIS (intramuros)" → "PARIS"
  let name = rawName.replace(/\s*\(.*\)\s*$/, '').trim();
  // Normaliser
  const norm = name.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
  // La ville = premier "mot significatif" (tout avant le premier tiret ou espace séparateur)
  // Pour les villes composées comme "AIX EN PROVENCE", on garde tout
  return norm;
}

function extractDisplayCity(rawName) {
  // Pour l'affichage de la ville : retirer les qualificatifs de gare
  // "PARIS (intramuros)"            → "Paris"
  // "PARIS-MONTPARNASSE 1 ET 2"     → "Paris"
  // "LYON PART DIEU"                → "Lyon"
  // "MARSEILLE ST CHARLES"          → "Marseille"
  // "AIX EN PROVENCE TGV"           → "Aix En Provence"
  // "BORDEAUX ST JEAN"              → "Bordeaux"
  let name = rawName.replace(/\s*\(.*\)\s*$/, '').trim().toUpperCase();

  // Villes connues et leurs variantes
  const CITY_PREFIXES = [
    'AIX EN PROVENCE', 'ANGERS ST LAUD', 'AVIGNON', 'BORDEAUX',
    'BREST', 'CAEN', 'CLERMONT FERRAND', 'DIJON', 'GRENOBLE',
    'LE HAVRE', 'LE MANS', 'LILLE', 'LIMOGES', 'LORIENT',
    'LYON', 'MARSEILLE', 'METZ', 'MONTPELLIER', 'MULHOUSE',
    'NANCY', 'NANTES', 'NICE', 'NIMES', 'ORLEANS', 'PARIS',
    'PERPIGNAN', 'POITIERS', 'QUIMPER', 'REIMS', 'RENNES',
    'ROUEN', 'SAINT ETIENNE', 'STRASBOURG', 'TOULON', 'TOULOUSE',
    'TOURS', 'VALENCE', 'VANNES',
  ];

  // Normalisation pour comparaison
  const normName = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/-/g, ' ');

  for (const prefix of CITY_PREFIXES) {
    if (normName === prefix || normName.startsWith(prefix + ' ') || normName.startsWith(prefix + '-')) {
      return toTitleCase(prefix.replace(/-/g, ' '));
    }
  }
  // Fallback : premier mot en Title Case
  return toTitleCase(name.split(/[\s-]/)[0]);
}

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
console.log('  stops.json : ' + Object.keys(stops).length + ' arrêts bruts');

// ─── Grouper par ville ────────────────────────────────────────────────────────
// Clé = ville normalisée → regroupe toutes les gares d'une même ville
// Ex: "paris" regroupe paris_intramuros, paris_gare_de_lyon, paris_montparnasse...

const cityGroups = new Map(); // cityKey → { displayCity, stopIds[], lat, lon, count, names[] }

for (const [stopId, stop] of Object.entries(stops)) {
  const rawName    = stop.name || '';
  const displayCity = extractDisplayCity(rawName);
  const cityKey    = normalize(displayCity);

  if (!cityGroups.has(cityKey)) {
    cityGroups.set(cityKey, {
      displayCity,
      stopIds: [stopId],
      lat:     stop.lat || 0,
      lon:     stop.lon || 0,
      count:   1,
      names:   [rawName],
    });
  } else {
    const g = cityGroups.get(cityKey);
    if (!g.stopIds.includes(stopId)) {
      g.stopIds.push(stopId);
      g.count++;
      g.names.push(rawName);
    }
    if (!g.lat && stop.lat) { g.lat = stop.lat; g.lon = stop.lon; }
  }
}

// ─── Construction du tableau stations ────────────────────────────────────────

const stations = [];

for (const [cityKey, g] of cityGroups.entries()) {
  stations.push({
    name:      g.displayCity,
    city:      g.displayCity,
    country:   'FR',
    stopIds:   g.stopIds,
    operators: ['TGVMAX'],
    lat:       g.lat,
    lon:       g.lon,
  });
}

// ─── Tri : gares les plus "grandes" d'abord ───────────────────────────────────
// Score = nombre de stops groupés (proxy du trafic)
stations.sort((a, b) => {
  if (b.stopIds.length !== a.stopIds.length) return b.stopIds.length - a.stopIds.length;
  return a.name.localeCompare(b.name, 'fr');
});

// ─── Écriture ─────────────────────────────────────────────────────────────────

fs.writeFileSync(OUT_FILE, JSON.stringify(stations, null, 2), 'utf8');
const sizeKb = Math.round(fs.statSync(OUT_FILE).size / 1024);
console.log('\n✅ stations.json : ' + stations.length + ' villes/gares — ' + sizeKb + ' KB');

// ─── Diagnostic gares clés ────────────────────────────────────────────────────
console.log('\n── Diagnostic gares clés ─────────────────────────────────────────');
const CHECK = ['Paris', 'Lyon', 'Marseille', 'Bordeaux', 'Nantes', 'Toulouse',
               'Lille', 'Strasbourg', 'Rennes', 'Nice', 'Montpellier'];

for (const city of CHECK) {
  const found = stations.find(s => s.name === city);
  if (found) {
    console.log(`  ✅ ${city.padEnd(15)} ${found.stopIds.length} stop(s) : ${found.stopIds.join(', ')}`);
  } else {
    console.log(`  ❌ ${city} — introuvable`);
  }
}

console.log('\n→ Lancez ensuite : node server.js\n');