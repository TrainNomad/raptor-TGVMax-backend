/**
 * server.js (Production Render.com)
 * Express Server fonctionnant directement sur Buffer binaire décompressé
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const BinaryTripsEngine = require('./binary-trips-engine');

const app = express();
app.use(express.json());

// Déclaration unique du PORT pour éviter le "SyntaxError: Identifier 'PORT' has already been declared"
const PORT = process.env.PORT || 3000;

let tripsEngine = null;
let stopsData = null;
let routesByStop = null;
let metaData = null;

// ─────────────────────────────────────────────────────────────────────
// Initialisation de l'Engine
// ─────────────────────────────────────────────────────────────────────

async function initEngine() {
  console.log('╔═══════════════════════════════════════════════════════╗');
  console.log('║         Initialisation Engine TGVmax (Binaire)         ║');
  console.log('╚═══════════════════════════════════════════════════════╝\n');

  console.time('Init Total');
  tripsEngine = new BinaryTripsEngine();

  // Option 1 : Local
  const binPathGz = path.join(__dirname, 'engine_data', 'trips.bin.gz');
  const binPath = path.join(__dirname, 'engine_data', 'trips.bin');

  if (fs.existsSync(binPathGz)) {
    console.log('🔍 Mode: Fichier local compressé');
    await tripsEngine.loadFromFile(binPathGz);
  } else if (fs.existsSync(binPath)) {
    console.log('🔍 Mode: Fichier local brut');
    await tripsEngine.loadFromFile(binPath);
  } else {
    // Option 2 : Téléchargement distant depuis Supabase Storage (Production)
    console.log('🔍 Mode: Téléchargement Supabase');
    
    const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
    const BUCKET_NAME = 'tgvmax-data';
    
    if (!SUPABASE_URL) {
      console.error('❌ SUPABASE_URL non définie et aucun fichier binaire local trouvé.');
      process.exit(1);
    }

    // Téléchargement depuis le stockage public Supabase (ou /authenticated/ selon vos règles)
    const url = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET_NAME}/trips.bin.gz`;
    console.log(`⏳ Téléchargement du binaire TGVmax depuis : ${url}`);
    await tripsEngine.loadFromUrl(url);
  }

  tripsEngine.printStats();

  // Charger les données JSON complémentaires si présentes
  console.log('📚 Chargement des fichiers complémentaires...');

  const stopsPath = path.join(__dirname, 'engine_data', 'stops.json');
  if (fs.existsSync(stopsPath)) {
    stopsData = JSON.parse(fs.readFileSync(stopsPath, 'utf8'));
    console.log(`   ✓ stops.json: ${Object.keys(stopsData).length} gares`);
  }

  const routesPath = path.join(__dirname, 'engine_data', 'routes_by_stop.json');
  if (fs.existsSync(routesPath)) {
    routesByStop = JSON.parse(fs.readFileSync(routesPath, 'utf8'));
    console.log(`   ✓ routes_by_stop.json: ${Object.keys(routesByStop).length} gares indexées`);
  }

  const metaPath = path.join(__dirname, 'engine_data', 'meta.json');
  if (fs.existsSync(metaPath)) {
    metaData = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  }

  console.timeEnd('Init Total');
  console.log('\n✅ Moteur TGVmax Binaire chargé et prêt en RAM !\n');
}

// ─────────────────────────────────────────────────────────────────────
// ENDPOINTS REST
// ─────────────────────────────────────────────────────────────────────

// Middleware basique pour logger les requêtes sur Render
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`[API] ${req.method} ${req.originalUrl} - ${res.statusCode} (${duration}ms)`);
  });
  next();
});

// Health check Render
app.get('/health', (req, res) => {
  if (!tripsEngine || !tripsEngine.buffer) {
    return res.status(503).json({ status: 'offline', error: 'Engine not loaded' });
  }

  res.json({
    status: 'online',
    engine: 'BinaryTripsEngine',
    numTrips: tripsEngine.numTrips,
    numStrings: tripsEngine.numStrings
  });
});

// Statistiques
app.get('/api/stats', (req, res) => {
  if (!tripsEngine) return res.status(503).json({ error: 'Engine not ready' });
  res.json({
    numTrips: tripsEngine.numTrips,
    numStrings: tripsEngine.numStrings,
    bufferSizeBytes: tripsEngine.buffer ? tripsEngine.buffer.length : 0,
    meta: metaData
  });
});

// Rechercher les départs d'une gare à une date
// GET /api/departures?origin=FR:75056&date=2026-07-20
app.get('/api/departures', (req, res) => {
  const { origin, date } = req.query;

  if (!origin || !date) {
    return res.status(400).json({ error: 'Paramètres origin et date requis.' });
  }

  const indices = tripsEngine.findDepartures(origin, date);
  const trips = indices.slice(0, 100).map(idx => tripsEngine.getTripAtIndex(idx));

  res.json({
    origin,
    date,
    count: indices.length,
    trips
  });
});

// Recherche RAPTOR simplifiée
app.post('/api/raptor', (req, res) => {
  const { source, target, date, time = 0 } = req.body;

  if (!source || !target || !date) {
    return res.status(400).json({ error: 'Missing parameters: source, target, date' });
  }

  const indices = tripsEngine.findDepartures(source, date);
  const routes = [];

  for (const idx of indices) {
    const trip = tripsEngine.getTripAtIndex(idx);
    if (trip.dest_id === target && trip.dep_time >= parseInt(time, 10)) {
      routes.push(trip);
    }
  }

  res.json({
    source,
    target,
    date,
    routes_found: routes.length,
    routes
  });
});

// ─────────────────────────────────────────────────────────────────────
// Lancement de l'Application Node.js
// ─────────────────────────────────────────────────────────────────────

async function start() {
  await initEngine();

  app.listen(PORT, () => {
    console.log(`🚀 Serveur Render à l'écoute sur le port ${PORT}`);
  });
}

process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (err) => {
  console.error('❌ Unhandled Rejection:', err);
  process.exit(1);
});

start().catch(err => {
  console.error('❌ Erreur au démarrage du serveur:', err.message);
  process.exit(1);
});

module.exports = app;