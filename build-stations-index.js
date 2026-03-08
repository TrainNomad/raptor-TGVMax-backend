/**
 * build-stations-index.js
 *
 * Génère stations.json à partir des gares extraites par tgvmax-ingest.js
 * (engine_data/stops.json).
 *
 * Stratégie de regroupement :
 *   - Les noms TGVmax sont du type "PARIS (intramuros)", "PARIS-MONTPARNASSE 1 ET 2", etc.
 *   - On regroupe par ville (détection des préfixes composés : ST, SAINT, LA, LE, LES, AIX...)
 *   - Tous les stops d'une même ville sont fusionnés sous une seule entrée
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

const DATA_DIR   = process.argv[2] || './engine_data';
const OUT_FILE   = process.argv[3] || path.join(__dirname, 'stations.json');
const STOPS_FILE = path.join(DATA_DIR, 'stops.json');

// ─── Utilitaires ──────────────────────────────────────────────────────────────

function toTitleCase(str) {
  // Capitalise chaque mot, mais respecte les articles minuscules habituels
  const LOWER_WORDS = new Set(['de', 'du', 'des', 'et', 'en', 'sur', 'sous', 'les', 'la', 'le']);
  return str.toLowerCase().split(/\s+/).map((word, i) => {
    if (i > 0 && LOWER_WORDS.has(word)) return word;
    return word.charAt(0).toUpperCase() + word.slice(1);
  }).join(' ');
}

function normalize(name) {
  return (name || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Table des villes connues ─────────────────────────────────────────────────
//
// Format : préfixe normalisé (sans accents, tirets→espaces, tout en minuscules)
// Le plus long préfixe correspondant gagne → mettre les villes composées EN PREMIER.
//
// La liste couvre toutes les gares TGV/Ouigo desservies en France.
// Elle est triée par longueur décroissante pour que le matching fonctionne correctement.

const KNOWN_CITIES = [
  // ── Villes composées longues — à tester EN PREMIER ──
  'saint pierre des corps',
  'saint jean de luz ciboure',
  'aix en provence tgv',
  'aix en provence',
  'la roche sur yon',
  'saint raphael valescure',
  'saint jean pied de port',
  'saint gervais les bains',
  'clermont ferrand',
  'le puy en velay',
  'chalon sur saone',
  'macon loche',
  'macon ville',
  'bourg en bresse',
  'annecy',
  'chambery challes les eaux',
  'saint exupery tgv',
  'lyon saint exupery tgv',
  'angers saint laud',
  'le creusot montceau montchanin',
  'le creusot tgv',
  'vendome villiers',
  'massy tgv',
  'marne la vallee chessy',
  'roissy charles de gaulle',
  'charles de gaulle etoile',
  'le havre',
  'le mans',
  'les arcs draguignan',
  'les aubrais orleans',
  'saint charles',
  'la rochelle ville',
  'la rochelle',
  'la baule escoublac',
  'la souterraine',
  'saint etienne chateaucreux',
  'saint etienne carnot',
  'saint etienne bellevue',
  'saint etienne',
  'saint brieuc',
  'saint malo',
  'saint nazaire',
  'saint omer',
  'saint quentin',
  'saint gilles croix de vie',
  'saint jean de luz',
  'saint pierre',
  'saintes',
  'la teste',
  'la ciotat',
  'la seyne',
  'le teil',
  'le cheylard',
  'le pouzin',
  'les herbiers',
  'les sables d olonne',

  // ── Grandes villes simples ──
  'paris',
  'lyon',
  'marseille',
  'bordeaux',
  'toulouse',
  'nantes',
  'lille',
  'strasbourg',
  'rennes',
  'nice',
  'montpellier',
  'grenoble',
  'toulon',
  'nimes',
  'dijon',
  'reims',
  'rouen',
  'nancy',
  'metz',
  'avignon',
  'perpignan',
  'poitiers',
  'limoges',
  'lorient',
  'brest',
  'caen',
  'mulhouse',
  'vannes',
  'quimper',
  'tours',
  'valence',
  'angouleme',
  'bayonne',
  'pau',
  'tarbes',
  'agen',
  'perigueux',
  'brive',
  'aurillac',
  'rodez',
  'albi',
  'cahors',
  'auch',
  'foix',
  'carcassonne',
  'beziers',
  'narbonne',
  'sete',
  'lunel',
  'ales',
  'orange',
  'arles',
  'frejus',
  'cannes',
  'antibes',
  'monaco',
  'menton',
  'draguignan',
  'toulouges',
  'elne',
  'argeles',
  'collioure',
  'banyuls',
  'cerbere',
  'hendaye',
  'biarritz',
  'dax',
  'mont de marsan',
  'orthez',
  'puyoo',
  'orthez',
  'morcenx',
  'facture',
  'arcachon',
  'merignac',
  'pessac',
  'libourne',
  'bergerac',
  'perigueux',
  'sarlat',
  'tulle',
  'ussel',
  'issoire',
  'brioude',
  'vichy',
  'moulins',
  'nevers',
  'montlucon',
  'gueret',
  'chateauroux',
  'vierzon',
  'bourges',
  'blois',
  'vendome',
  'chartres',
  'dreux',
  'evreux',
  'lisieux',
  'bayeux',
  'cherbourg',
  'valognes',
  'carentan',
  'coutances',
  'granville',
  'avranches',
  'reze',
  'clisson',
  'cholet',
  'angers',
  'saumur',
  'chinon',
  'amboise',
  'chatellerault',
  'surgeres',
  'niort',
  'bressuire',
  'parthenay',
  'fontenay',
  'lucon',
  'challans',
  'machecoul',
  'nozay',
  'chateaubriant',
  'redon',
  'ploermel',
  'malestroit',
  'pontivy',
  'auray',
  'quiberon',
  'concarneau',
  'quimperle',
  'landerneau',
  'morlaix',
  'guingamp',
  'lannion',
  'paimpol',
  'lamballe',
  'dinan',
  'dinard',
  'dol de bretagne',
  'fougeres',
  'vitre',
  'laval',
  'mayenne',
  'alencon',
  'argentan',
  'flers',
  'domfront',
  'vire',
  'falaise',
  'calvados',
  'deauville',
  'trouville',
  'honfleur',
  'fecamp',
  'dieppe',
  'eu',
  'abbeville',
  'amiens',
  'arras',
  'lens',
  'douai',
  'valenciennes',
  'maubeuge',
  'hirson',
  'laon',
  'soissons',
  'compiègne',
  'compiegne',
  'creil',
  'pontoise',
  'cergy',
  'versailles',
  'evry',
  'melun',
  'montereau',
  'sens',
  'auxerre',
  'clamecy',
  'cosne',
  'gien',
  'montargis',
  'pithiviers',
  'etampes',
  'dourdan',
  'rambouillet',
  'mantes la jolie',
  'mantes',
  'poissy',
  'conflans',
  'argenteuil',
  'clichy',
  'aubervilliers',
  'pantin',
  'vincennes',
  'nogent',
  'joinville',
  'choisy',
  'juvisy',
  'corbeil',
  'brunoy',
  'boissy',
  'yerres',
  'savigny',
  'epinay',
  'enghien',
  'ermont',
  'sarcelles',
  'garges',
  'goussainville',
  'luzarches',
  'persan',
  'beaumont sur oise',
  'crepy en valois',
  'verberie',
  'lacroix saint ouen',
  'longueau',
  'abbeville',
  'hesdin',
  'montreuil',
  'boulogne',
  'calais',
  'dunkerque',
  'hazebrouck',
  'bethune',
  'bruay',
  'henin beaumont',
  'liévin',
  'lievin',
  'billy montigny',
  'noeux les mines',
  'labourse',
  'fouquieres',
  'douvrin',
  'vendin le vieil',
  'carvin',
  'ostricourt',
  'pont a marcq',
  'flers en escrebieux',
  'lourdes',
  'tarbes',
  'pau',
  'oloron',
  'mauleon',
  'bedous',
  'canfranc',
  'irun',
  'portbou',
  'cerbere',
  'toulouse matabiau',
  'montauban',
  'moissac',
  'agen',
  'marmande',
  'langon',
  'cestas',
  'arcachon',
  'la teste',
  'gujan mestras',
  'biganos',
  'audenge',
  'lanton',
  'andernos',
  'arès',
  'ares',
  'le porge',
  'lacanau',
  'hourtin',
  'lesparre',
  'soulac',
  'vendays',
  'gauriac',
  'blaye',
  'saint andre de cubzac',
  'lormont',
  'cenon',
  'floirac',
  'carbon blanc',
  'ambares',
  'bassens',
  'saint loubes',
  'saint sulpice',
  'beychac',
  'creon',
  'branne',
  'castillon',
  'coutras',
  'chalais',
  'barbezieux',
  'cognac',
  'jarnac',
  'rochefort',
  'fouras',
  'chatelaillon',
  'surgeres',
  'marans',
  'lucon',
  'fontenay le comte',
  'bressuire',
  'thouars',
  'loudun',
  'chinon',
  'tours saint pierre des corps',
].sort((a, b) => b.length - a.length); // plus long en premier

// ─── Extraction du nom de ville ───────────────────────────────────────────────

function extractDisplayCity(rawName) {
  // 1. Nettoyer : supprimer les parenthèses de fin et normaliser
  let cleaned = rawName
    .replace(/\s*\(.*\)\s*$/, '')  // supprimer "(intramuros)", "(Aéroport)", etc.
    .replace(/-/g, ' ')            // tirets → espaces
    .trim()
    .toUpperCase();

  // 2. Normaliser pour la comparaison (sans accents)
  const normCleaned = cleaned
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

  // 3. Chercher le préfixe le plus long dans KNOWN_CITIES
  for (const cityNorm of KNOWN_CITIES) {
    if (normCleaned === cityNorm || normCleaned.startsWith(cityNorm + ' ')) {
      // Retourner en Title Case propre
      return toTitleCase(cityNorm);
    }
  }

  // 4. Fallback intelligent :
  //    - On tronque au premier mot "qualificatif de gare" connu
  //    - Un qualificatif de gare est un mot court non-géographique
  const STATION_QUALIFIERS = new Set([
    'tgv', 'ouigo', 'ville', 'centre', 'gare', 'central', 'centrale',
    '1', '2', '3', 'et', 'i', 'ii', 'iii',
  ]);

  // On décompose mot par mot et on garde ceux qui font partie du nom de ville
  const words = normCleaned.split(' ');
  const cityWords = [];

  for (const word of words) {
    // Arrêter si on tombe sur un qualificatif pur de gare
    if (STATION_QUALIFIERS.has(word)) break;
    // Arrêter sur les numéros seuls (sauf s'ils font partie du nom, ex: "D2")
    if (/^\d+$/.test(word) && cityWords.length > 0) break;
    cityWords.push(word);
  }

  // Si on n'a rien extrait (rare), garder le premier mot quand même
  if (!cityWords.length) cityWords.push(words[0]);

  return toTitleCase(cityWords.join(' '));
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

const cityGroups = new Map(); // cityKey → { displayCity, stopIds[], lat, lon, count, names[] }

for (const [stopId, stop] of Object.entries(stops)) {
  const rawName     = stop.name || '';
  const displayCity = extractDisplayCity(rawName);
  const cityKey     = normalize(displayCity);

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

for (const [, g] of cityGroups.entries()) {
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

// Tri : les villes avec le plus de gares en premier, puis alphabétique
stations.sort((a, b) => {
  if (b.stopIds.length !== a.stopIds.length) return b.stopIds.length - a.stopIds.length;
  return a.name.localeCompare(b.name, 'fr');
});

// ─── Écriture ─────────────────────────────────────────────────────────────────

fs.writeFileSync(OUT_FILE, JSON.stringify(stations, null, 2), 'utf8');
const sizeKb = Math.round(fs.statSync(OUT_FILE).size / 1024);
console.log('\n✅ stations.json : ' + stations.length + ' villes/gares — ' + sizeKb + ' KB');

// ─── Diagnostic ───────────────────────────────────────────────────────────────
console.log('\n── Diagnostic gares clés ─────────────────────────────────────────');
const CHECK = [
  'Paris', 'Lyon', 'Marseille', 'Bordeaux', 'Nantes', 'Toulouse',
  'Lille', 'Strasbourg', 'Rennes', 'Nice', 'Montpellier',
  'Saint Etienne', 'Saint Pierre Des Corps', 'La Rochelle',
  'Le Mans', 'Le Havre', 'Le Creusot Tgv', 'Aix En Provence',
  'Clermont Ferrand', 'Angers Saint Laud',
];

for (const city of CHECK) {
  const found = stations.find(s => s.name.toLowerCase() === city.toLowerCase());
  if (found) {
    console.log(`  ✅ ${city.padEnd(28)} ${found.stopIds.length} stop(s)`);
  } else {
    // Recherche approchée pour aider au debug
    const approx = stations.filter(s => s.name.toLowerCase().includes(city.toLowerCase().split(' ')[0]));
    const hint   = approx.length ? ' (proche : ' + approx.map(s => s.name).slice(0,3).join(', ') + ')' : '';
    console.log(`  ❌ ${city.padEnd(28)}${hint}`);
  }
}

// Afficher toutes les entrées qui contiennent "st" ou "la" ou "le" au début (debug)
const suspicious = stations.filter(s => /^(St|La|Le|Les)\s/i.test(s.name));
if (suspicious.length) {
  console.log('\n── ⚠️  Villes avec préfixe potentiellement mal parsé ────────────');
  for (const s of suspicious.slice(0, 20)) {
    console.log(`  ${s.name.padEnd(28)} stops: ${s.stopIds.join(', ')}`);
  }
  if (suspicious.length > 20) console.log(`  … et ${suspicious.length - 20} autres`);
}

console.log('\n→ Lancez ensuite : node server.js\n');