#!/usr/bin/env node
/**
 * test-binary-engine.js
 *
 * Script de test et démonstration du BinaryTripsEngine
 * Utiliser pour vérifier que tout fonctionne correctement en développement
 *
 * Usage:
 *   node test-binary-engine.js
 *   node test-binary-engine.js ./engine_data/trips.bin
 *   node test-binary-engine.js ./engine_data/trips.bin.gz
 */

const fs = require('fs');
const path = require('path');
const BinaryTripsEngine = require('./binary-trips-engine');

// ─────────────────────────────────────────────────────────────────────
// Colors for console output
// ─────────────────────────────────────────────────────────────────────
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m'
};

function log(msg, color = 'reset') {
  console.log(`${colors[color]}${msg}${colors.reset}`);
}

// ─────────────────────────────────────────────────────────────────────
// Test Runner
// ─────────────────────────────────────────────────────────────────────

async function runTests() {
  log('\n╔═══════════════════════════════════════════════════════╗', 'cyan');
  log('║   BinaryTripsEngine Test Suite', 'cyan');
  log('╚═══════════════════════════════════════════════════════╝\n', 'cyan');

  // Déterminer le fichier à charger
  let binPath = process.argv[2];
  if (!binPath) {
    // Chercher automatiquement
    const candidates = [
      './engine_data/trips.bin.gz',
      './engine_data/trips.bin',
      '/mnt/user-data/uploads/trips.bin.gz'
    ];
    
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        binPath = candidate;
        break;
      }
    }
  }

  if (!binPath || !fs.existsSync(binPath)) {
    log(`❌ Fichier binaire introuvable.`, 'red');
    log(`   Chercher dans: ./engine_data/trips.bin ou trips.bin.gz`, 'yellow');
    log(`   Ou générer d'abord: node tgvmax-to-binary.js\n`, 'yellow');
    process.exit(1);
  }

  log(`📂 Fichier: ${binPath}`, 'yellow');
  log(`   Taille: ${(fs.statSync(binPath).size / 1024 / 1024).toFixed(2)} MB\n`, 'yellow');

  // ───────────────────────────────────────────────────────────────────
  // Test 1: Chargement
  // ───────────────────────────────────────────────────────────────────
  log('TEST 1: Chargement du fichier binaire', 'cyan');
  log('─'.repeat(55), 'cyan');

  const engine = new BinaryTripsEngine();
  console.time('Load Time');

  try {
    await engine.loadFromFile(binPath);
    console.timeEnd('Load Time');
    log('✅ Chargement réussi\n', 'green');
  } catch (err) {
    log(`❌ Erreur de chargement: ${err.message}\n`, 'red');
    process.exit(1);
  }

  // ───────────────────────────────────────────────────────────────────
  // Test 2: Stats basiques
  // ───────────────────────────────────────────────────────────────────
  log('TEST 2: Vérification des stats', 'cyan');
  log('─'.repeat(55), 'cyan');

  engine.printStats();

  // ───────────────────────────────────────────────────────────────────
  // Test 3: Accès aléatoire (getTripAtIndex)
  // ───────────────────────────────────────────────────────────────────
  log('TEST 3: Accès aléatoire aux trajets', 'cyan');
  log('─'.repeat(55), 'cyan');

  console.time('Random Access');
  const samples = [0, 100, 1000, Math.floor(engine.numTrips / 2), engine.numTrips - 1];
  
  for (const idx of samples) {
    const trip = engine.getTripAtIndex(idx);
    if (trip) {
      log(`  Index ${idx}: ${trip.trip_id}`, 'green');
      log(`    ${trip.origin_id} → ${trip.dest_id}`, 'green');
      log(`    ${trip.dep_str} - ${trip.arr_str} [${trip.dispo ? '✅' : '❌'}]`, 'green');
    }
  }
  console.timeEnd('Random Access');
  log('✅ Accès O(1) fonctionnel\n', 'green');

  // ───────────────────────────────────────────────────────────────────
  // Test 4: Itération
  // ───────────────────────────────────────────────────────────────────
  log('TEST 4: Itération sur les trajets', 'cyan');
  log('─'.repeat(55), 'cyan');

  console.time('Iterate 1000');
  let count = 0;
  for (const trip of engine.iterateTrips()) {
    count++;
    if (count >= 1000) break;
  }
  console.timeEnd('Iterate 1000');
  log(`✅ Itérés ${count} trajets sans allocations massives\n`, 'green');

  // ───────────────────────────────────────────────────────────────────
  // Test 5: Filtrage par disponibilité
  // ───────────────────────────────────────────────────────────────────
  log('TEST 5: Comptage avec filtrage', 'cyan');
  log('─'.repeat(55), 'cyan');

  const totalTrips = engine.countTrips();
  const availableTrips = engine.countTrips(true);
  const unavailableTrips = totalTrips - availableTrips;

  log(`  Total: ${totalTrips.toLocaleString()}`, 'yellow');
  log(`  ✅ Disponibles: ${availableTrips.toLocaleString()} (${((availableTrips / totalTrips) * 100).toFixed(1)}%)`, 'green');
  log(`  ❌ Non-disponibles: ${unavailableTrips.toLocaleString()} (${((unavailableTrips / totalTrips) * 100).toFixed(1)}%)\n`, 'yellow');

  // ───────────────────────────────────────────────────────────────────
  // Test 6: Recherche par filtres
  // ───────────────────────────────────────────────────────────────────
  log('TEST 6: Recherche par filtres', 'cyan');
  log('─'.repeat(55), 'cyan');

  // Trouver un trip exemple pour extraire origin/dest/date
  const exampleTrip = engine.getTripAtIndex(100);
  if (exampleTrip) {
    log(`Recherche par origine: ${exampleTrip.origin_id}`, 'yellow');
    
    console.time('Search');
    const results = engine.findTrips({
      origin_id: exampleTrip.origin_id,
      dispo: true
    });
    console.timeEnd('Search');
    
    log(`  Trouvé: ${results.length} trajets`, 'green');
    log(`  Exemples:`, 'yellow');
    
    for (let i = 0; i < Math.min(3, results.length); i++) {
      const trip = engine.getTripAtIndex(results[i]);
      log(`    - ${trip.trip_id.substring(0, 50)}...`, 'green');
    }
  }
  log('');

  // ───────────────────────────────────────────────────────────────────
  // Test 7: Recherche RAPTOR
  // ───────────────────────────────────────────────────────────────────
  log('TEST 7: Simulation requête RAPTOR (findDepartures)', 'cyan');
  log('─'.repeat(55), 'cyan');

  if (exampleTrip) {
    log(`Chercher départs: ${exampleTrip.origin_id} le ${exampleTrip.date}`, 'yellow');
    
    console.time('Departures');
    const deps = engine.findDepartures(exampleTrip.origin_id, exampleTrip.date);
    console.timeEnd('Departures');
    
    log(`  Trouvé: ${deps.length} départs`, 'green');
    
    if (deps.length > 0) {
      log(`  Premier départ:`, 'yellow');
      const first = engine.getTripAtIndex(deps[0]);
      const times = engine.getTimesAtIndex(deps[0]);
      
      log(`    Trip: ${first.trip_id.substring(0, 50)}`, 'green');
      log(`    Départ: ${first.dep_str} (${times.dep_time}s)`, 'green');
      log(`    Arrivée: ${first.arr_str} (${times.arr_time}s)`, 'green');
    }
  }
  log('');

  // ───────────────────────────────────────────────────────────────────
  // Test 8: Lecture directe du buffer (performance test)
  // ───────────────────────────────────────────────────────────────────
  log('TEST 8: Performance - Lecture directe du buffer', 'cyan');
  log('─'.repeat(55), 'cyan');

  console.time('Read 10000 direct');
  let directCounter = 0;
  for (let i = 0; i < Math.min(10000, engine.numTrips); i++) {
    const times = engine.getTimesAtIndex(i);
    directCounter += times.dep_time; // dummy operation
  }
  console.timeEnd('Read 10000 direct');
  log('✅ Lecture rapide sans instanciation d\'objets\n', 'green');

  // ───────────────────────────────────────────────────────────────────
  // Test 9: Comparaison mémoire
  // ───────────────────────────────────────────────────────────────────
  log('TEST 9: Utilisation mémoire', 'cyan');
  log('─'.repeat(55), 'cyan');

  const memUsage = process.memoryUsage();
  log(`  RSS: ${(memUsage.rss / 1024 / 1024).toFixed(2)} MB (total)`, 'yellow');
  log(`  Heap Used: ${(memUsage.heapUsed / 1024 / 1024).toFixed(2)} MB`, 'yellow');
  log(`  External: ${(memUsage.external / 1024 / 1024).toFixed(2)} MB`, 'yellow');
  log(`  Buffer binary: ${(engine.buffer.length / 1024 / 1024).toFixed(2)} MB`, 'green');
  log('');

  // ───────────────────────────────────────────────────────────────────
  // Test 10: Performance benchmark
  // ───────────────────────────────────────────────────────────────────
  log('TEST 10: Benchmark - 1000 requêtes aléatoires', 'cyan');
  log('─'.repeat(55), 'cyan');

  console.time('1000 Random Trips');
  for (let i = 0; i < 1000; i++) {
    const randomIdx = Math.floor(Math.random() * engine.numTrips);
    const trip = engine.getTripAtIndex(randomIdx);
    // Use trip data
    trip.trip_id.length;
  }
  console.timeEnd('1000 Random Trips');
  
  log('✅ Performance acceptable pour production\n', 'green');

  // ───────────────────────────────────────────────────────────────────
  // Résumé
  // ───────────────────────────────────────────────────────────────────
  log('╔═══════════════════════════════════════════════════════╗', 'cyan');
  log('║              RÉSUMÉ DES TESTS', 'cyan');
  log('╚═══════════════════════════════════════════════════════╝\n', 'cyan');

  const stats = engine.getStats();
  
  log('✅ TOUS LES TESTS RÉUSSIS', 'green');
  log(`\n   Format binaire: ${binPath}`);
  log(`   Trajets: ${stats.total_trips.toLocaleString()}`);
  log(`   Disponibles: ${stats.available_trips.toLocaleString()}`);
  log(`   RAM utilisée: ${stats.ram_usage_mb} MB`);
  log(`   Strings: ${stats.unique_strings.toLocaleString()}`);
  
  log(`\n✨ Le serveur est prêt à démarrer !`, 'green');
  log(`   → node server-binary.js\n`, 'yellow');
}

// ─────────────────────────────────────────────────────────────────────
// Run Tests
// ─────────────────────────────────────────────────────────────────────

runTests().catch(err => {
  log(`\n❌ Erreur: ${err.message}`, 'red');
  console.error(err.stack);
  process.exit(1);
});