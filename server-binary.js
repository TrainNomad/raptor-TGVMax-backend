/**
 * server-binary.js
 *
 * Serveur Express complet utilisant le format binaire TGVmax
 * - Initialise BinaryTripsEngine au démarrage
 * - Expose des endpoints REST pour RAPTOR
 * - Démontre l'intégration avec l'algorithme RAPTOR
 *
 * Consommation mémoire : ~50-80 MB (au lieu de 400+ MB)
 * Vitesse de chargement : ~2-3 secondes (au lieu de 30+ secondes)
 */

const express = require('express');
const BinaryTripsEngine = require('./binary-trips-engine');
const path = require('path');
const fs = require('fs');

const app = express();
let tripsEngine = null;
let stopsData = null;
let routesByStop = null;
let metaData = null;

// ─────────────────────────────────────────────────────────────────────
// Initialisation de l'engine au démarrage du serveur
// ─────────────────────────────────────────────────────────────────────

async function initEngine() {
  console.log('╔═══════════════════════════════════════════════════════╗');
  console.log('║         Initialisation Engine TGVmax (Binaire)         ║');
  console.log('╚═══════════════════════════════════════════════════════╝\n');

  console.time('Init Total');

  tripsEngine = new BinaryTripsEngine();

  // ───────────────────────────────────────────────────────────────────
  // Option 1 : Charger depuis disque local (développement)
  // ───────────────────────────────────────────────────────────────────
  const binPathGz = path.join(__dirname, 'engine_data', 'trips.bin.gz');
  const binPath = path.join(__dirname, 'engine_data', 'trips.bin');

  if (fs.existsSync(binPathGz)) {
    console.log('🔍 Mode: Fichier local compressé');
    await tripsEngine.loadFromFile(binPathGz);
  } else if (fs.existsSync(binPath)) {
    console.log('🔍 Mode: Fichier local brut');
    await tripsEngine.loadFromFile(binPath);
  } else {
    // ───────────────────────────────────────────────────────────────
    // Option 2 : Télécharger depuis Supabase (production)
    // ───────────────────────────────────────────────────────────────
    console.log('🔍 Mode: Téléchargement Supabase');
    
    const SUPABASE_URL = process.env.SUPABASE_URL || '';
    const BUCKET_NAME = 'tgvmax-data';
    
    if (!SUPABASE_URL) {
      console.error('❌ SUPABASE_URL non définie et fichiers locaux manquants');
      process.exit(1);
    }

    const url = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET_NAME}/trips.bin.gz`;
    await tripsEngine.loadFromUrl(url);
  }

  // Afficher les stats
  tripsEngine.printStats();

  // ───────────────────────────────────────────────────────────────────
  // Charger les données JSON complémentaires (gares, calendrier, routes)
  // ───────────────────────────────────────────────────────────────────
  console.log('📚 Chargement des données complémentaires...');

  // Gares (stops)
  const stopsPath = path.join(__dirname, 'engine_data', 'stops.json');
  if (fs.existsSync(stopsPath)) {
    stopsData = JSON.parse(fs.readFileSync(stopsPath, 'utf8'));
    console.log(`   ✓ stops.json: ${Object.keys(stopsData).length} gares`);
  }

  // Calendrier (pour find-on-date optimisé)
  const calendarPath = path.join(__dirname, 'engine_data', 'calendar_index.json');
  if (fs.existsSync(calendarPath)) {
    const calendar = JSON.parse(fs.readFileSync(calendarPath, 'utf8'));
    console.log(`   ✓ calendar_index.json: ${Object.keys(calendar).length} dates`);
  }

  // Routes par gare (pour RAPTOR reverse-search)
  const routesPath = path.join(__dirname, 'engine_data', 'routes_by_stop.json');
  if (fs.existsSync(routesPath)) {
    routesByStop = JSON.parse(fs.readFileSync(routesPath, 'utf8'));
    console.log(`   ✓ routes_by_stop.json: ${Object.keys(routesByStop).length} gares indexées`);
  }

  // Métadonnées
  const metaPath = path.join(__dirname, 'engine_data', 'meta.json');
  if (fs.existsSync(metaPath)) {
    metaData = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    console.log(`   ✓ meta.json: ${metaData.date_range.first} → ${metaData.date_range.last}`);
  }

  console.timeEnd('Init Total');
  console.log('\n✅ Serveur prêt !\n');
}

// ─────────────────────────────────────────────────────────────────────
// ENDPOINTS REST
// ─────────────────────────────────────────────────────────────────────

// Health check
app.get('/health', (req, res) => {
  if (!tripsEngine || !tripsEngine.loaded) {
    return res.status(503).json({ status: 'offline', error: 'Engine not loaded' });
  }

  const stats = tripsEngine.getStats();
  res.json({
    status: 'online',
    engine: 'BinaryTripsEngine',
    ...stats
  });
});

// Récupérer les stats complètes
app.get('/api/stats', (req, res) => {
  if (!tripsEngine) {
    return res.status(503).json({ error: 'Engine not ready' });
  }

  res.json({
    ...tripsEngine.getStats(),
    meta: metaData
  });
});

// Rechercher les départs d'une gare à une date
// GET /api/departures?origin=FR:75056&date=2025-07-20
app.get('/api/departures', (req, res) => {
  const { origin, date } = req.query;

  if (!origin || !date) {
    return res.status(400).json({ error: 'Missing origin or date' });
  }

  console.time(`departures ${origin} ${date}`);
  const indices = tripsEngine.findDepartures(origin, date);
  console.timeEnd(`departures ${origin} ${date}`);

  // Convertir indices en trips complets
  const trips = indices.slice(0, 100).map(idx => {
    const trip = tripsEngine.getTripAtIndex(idx);
    const times = tripsEngine.getTimesAtIndex(idx);
    return { ...trip, ...times };
  });

  res.json({
    origin,
    date,
    count: indices.length,
    trips: trips
  });
});

// Rechercher des trajets avec filtres
// GET /api/trips/search?origin=FR:75056&dest=FR:13055&date=2025-07-20
app.get('/api/trips/search', (req, res) => {
  const { origin, dest, date, dispo = true } = req.query;

  const filters = {
    origin_id: origin,
    dest_id: dest,
    date: date,
    dispo: dispo === 'true' || dispo === '1'
  };

  console.time(`search`);
  const indices = tripsEngine.findTrips(filters);
  console.timeEnd(`search`);

  const trips = indices.slice(0, 50).map(idx => tripsEngine.getTripAtIndex(idx));

  res.json({
    filters,
    count: indices.length,
    trips
  });
});

// Récupérer un trajet par indice
// GET /api/trip/0
app.get('/api/trip/:index', (req, res) => {
  const idx = parseInt(req.params.index);
  const trip = tripsEngine.getTripAtIndex(idx);

  if (!trip) {
    return res.status(404).json({ error: 'Trip not found' });
  }

  res.json(trip);
});

// Itérer sur tous les trajets (pagination simple)
// GET /api/trips/all?start=0&limit=100
app.get('/api/trips/all', (req, res) => {
  const start = parseInt(req.query.start) || 0;
  const limit = parseInt(req.query.limit) || 100;

  const trips = [];
  for (let i = start; i < Math.min(start + limit, tripsEngine.numTrips); i++) {
    trips.push(tripsEngine.getTripAtIndex(i));
  }

  res.json({
    start,
    limit,
    returned: trips.length,
    total: tripsEngine.numTrips,
    trips
  });
});

// Info gare
// GET /api/stop/FR:75056
app.get('/api/stop/:stopId', (req, res) => {
  if (!stopsData) {
    return res.status(503).json({ error: 'Stops data not loaded' });
  }

  const stopId = decodeURIComponent(req.params.stopId);
  const stop = stopsData[stopId];

  if (!stop) {
    return res.status(404).json({ error: 'Stop not found' });
  }

  // Lister les trajets depuis cette gare
  const departureIndices = [];
  for (let i = 0; i < tripsEngine.numTrips; i++) {
    const stops = tripsEngine.getStopsAtIndex(i);
    if (stops.origin_id === stopId) {
      departureIndices.push(i);
    }
  }

  res.json({
    ...stop,
    departure_count: departureIndices.length,
    departure_samples: departureIndices.slice(0, 10).map(i => tripsEngine.getTripAtIndex(i))
  });
});

// ─────────────────────────────────────────────────────────────────────
// EXEMPLE D'ALGORITHME RAPTOR SIMPLIFIÉ
// ─────────────────────────────────────────────────────────────────────

/**
 * Algorithme RAPTOR simplifié utilisant les données binaires
 * 
 * RAPTOR (Round-based Public Transit Optimization with Transfers)
 * - Pour chaque round, découvrir les gares atteignables
 * - Utiliser les trips pour faire les transferts
 * - Éviter les instanciations d'objets JS inutiles
 */
class SimplifiedRAPTOR {
  constructor(engine, stopsData, routesByStop) {
    this.engine = engine;
    this.stopsData = stopsData;
    this.routesByStop = routesByStop;
    this.maxRounds = 4; // Limiter pour perf
  }

  /**
   * Chercher les itinéraires de source à destination
   * @param {string} sourceStop - Stop ID
   * @param {string} targetStop - Stop ID
   * @param {string} departureDate - YYYY-MM-DD
   * @param {number} departureTime - secondes depuis minuit
   * @returns {Array} Routes trouvées
   */
  findRoutes(sourceStop, targetStop, departureDate, departureTime) {
    console.time(`RAPTOR ${sourceStop} → ${targetStop}`);

    const routes = [];
    const earliestArrival = {}; // stop_id → arrival_time
    earliestArrival[sourceStop] = departureTime;

    // Pour chaque round
    for (let round = 0; round < this.maxRounds; round++) {
      console.log(`  Round ${round + 1}/${this.maxRounds}`);

      let improved = false;

      // Itérer sur les trajets disponibles
      for (let tripIdx = 0; tripIdx < this.engine.numTrips; tripIdx++) {
        const trip = this.engine.getTripAtIndex(tripIdx);
        
        // Skip si pas disponible ou mauvaise date
        if (!trip.dispo || trip.date !== departureDate) continue;

        const times = this.engine.getTimesAtIndex(tripIdx);
        const { origin_id, dest_id } = this.engine.getStopsAtIndex(tripIdx);

        // Chercher si on peut monter à bord de ce trajet
        const earliestDep = earliestArrival[origin_id];
        if (earliestDep !== undefined && earliestDep <= times.dep_time) {
          // On peut prendre ce trajet
          const arrival = times.arr_time;

          if (!earliestArrival[dest_id] || earliestArrival[dest_id] > arrival) {
            earliestArrival[dest_id] = arrival;
            improved = true;

            // Enregistrer si on atteint la destination
            if (dest_id === targetStop) {
              routes.push({
                trip_id: trip.trip_id,
                from: origin_id,
                to: dest_id,
                departure: times.dep_time,
                arrival: arrival,
                round: round
              });
            }
          }
        }
      }

      if (!improved) break; // Aucune amélioration, sortir
    }

    console.timeEnd(`RAPTOR ${sourceStop} → ${targetStop}`);
    return routes;
  }
}

// Endpoint RAPTOR
app.post('/api/raptor', (req, res) => {
  const { source, target, date, time } = req.body;

  if (!source || !target || !date || time === undefined) {
    return res.status(400).json({
      error: 'Missing parameters: source, target, date, time'
    });
  }

  try {
    const raptor = new SimplifiedRAPTOR(tripsEngine, stopsData, routesByStop);
    const routes = raptor.findRoutes(source, target, date, parseInt(time));

    res.json({
      source,
      target,
      date,
      time,
      routes_found: routes.length,
      routes: routes.slice(0, 10)
    });
  } catch (err) {
    console.error('RAPTOR error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────
// Démarrage du serveur
// ─────────────────────────────────────────────────────────────────────

async function start() {
  await initEngine();

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`🚄 Serveur TGVmax démarré sur http://localhost:${PORT}`);
    console.log(`   /health - Vérifier l'état`);
    console.log(`   /api/stats - Stats complètes`);
    console.log(`   /api/departures?origin=...&date=... - Départs d'une gare`);
    console.log(`   /api/raptor - Recherche d'itinéraire (POST)\n`);
  });
}

// Gestion des erreurs non capturées
process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (err) => {
  console.error('❌ Unhandled Rejection:', err);
  process.exit(1);
});

// Lancer le serveur
start().catch(err => {
  console.error('❌ Erreur démarrage:', err.message);
  process.exit(1);
});

module.exports = app;