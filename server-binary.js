/**
 * server.js (Production Render.com)
 * Engine TGVmax sur Buffer binaire décompressé
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const BinaryTripsEngine = require('./binary-trips-engine');

const app = express();
app.use(express.json());

// Déclaration UNIQUE de PORT
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

  const binPathGz = path.join(__dirname, 'engine_data', 'trips.bin.gz');
  const binPath = path.join(__dirname, 'engine_data', 'trips.bin');

  if (fs.existsSync(binPathGz)) {
    console.log('🔍 Mode: Fichier local compressé');
    await tripsEngine.loadFromFile(binPathGz);
  } else if (fs.existsSync(binPath)) {
    console.log('🔍 Mode: Fichier local brut');
    await tripsEngine.loadFromFile(binPath);
  } else {
    console.log('🔍 Mode: Téléchargement Supabase');
    
    const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
    const BUCKET_NAME = 'tgvmax-data';
    
    if (!SUPABASE_URL) {
      console.error('❌ SUPABASE_URL non définie et aucun fichier local présent.');
      process.exit(1);
    }

    const url = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET_NAME}/trips.bin.gz`;
    console.log(`⏳ Téléchargement du binaire TGVmax depuis : ${url}`);
    await tripsEngine.loadFromUrl(url);
  }

  tripsEngine.printStats();

  // Fichiers JSON complémentaires (si disponibles)
  const stopsPath = path.join(__dirname, 'engine_data', 'stops.json');
  if (fs.existsSync(stopsPath)) {
    stopsData = JSON.parse(fs.readFileSync(stopsPath, 'utf8'));
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

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    console.log(`[API] ${req.method} ${req.originalUrl} - ${res.statusCode} (${Date.now() - start}ms)`);
  });
  next();
});

app.get('/health', (req, res) => {
  if (!tripsEngine || !tripsEngine.buffer) {
    return res.status(503).json({ status: 'offline', error: 'Engine not loaded' });
  }
  res.json({ status: 'online', numTrips: tripsEngine.numTrips });
});

app.get('/api/departures', (req, res) => {
  const { origin, date } = req.query;
  if (!origin || !date) {
    return res.status(400).json({ error: 'Paramètres origin et date requis.' });
  }

  const indices = tripsEngine.findDepartures(origin, date);
  const trips = indices.slice(0, 100).map(idx => tripsEngine.getTripAtIndex(idx));

  res.json({ origin, date, count: indices.length, trips });
});

// ─────────────────────────────────────────────────────────────────────
// Lancement
// ─────────────────────────────────────────────────────────────────────

async function start() {
  await initEngine();
  app.listen(PORT, () => {
    console.log(`🚀 Serveur Render à l'écoute sur le port ${PORT}`);
  });
}

start().catch(err => {
  console.error('❌ Erreur au démarrage du serveur:', err.message);
  process.exit(1);
});

module.exports = app;