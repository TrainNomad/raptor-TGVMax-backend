/**
 * tgvmax-to-binary.js
 * Convertit un dictionnaire JSON de trajets en structure binaire fixe compressée.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const TRIPS_JSON_PATH = path.join(__dirname, 'engine_data', 'trips.json');
const OUT_DIR = path.join(__dirname, 'engine_data');

function serialize() {
  console.log('⏳ Lecture du fichier trips.json...');
  const rawData = fs.readFileSync(TRIPS_JSON_PATH, 'utf8');
  const tripsObj = JSON.parse(rawData);
  const tripIds = Object.keys(tripsObj);
  const totalTrips = tripIds.length;

  console.log(`📦 Traitement de ${totalTrips.toLocaleString()} trajets...`);

  // Construction des dictionnaires uniques (Deduplication)
  const dateMap = new Map();
  const stationMap = new Map();
  
  const dates = [];
  const stations = [];

  // 1. Premier passage : Extraction des dictionnaires de chaînes de caractères
  for (const id of tripIds) {
    const t = tripsObj[id];
    if (!dateMap.has(t.date)) {
      dateMap.set(t.date, dates.length);
      dates.push(t.date);
    }
    if (!stationMap.has(t.origin_id)) {
      stationMap.set(t.origin_id, stations.length);
      stations.push(t.origin_id);
    }
    if (!stationMap.has(t.dest_id)) {
      stationMap.set(t.dest_id, stations.length);
      stations.push(t.dest_id);
    }
  }

  // 2. Allocation du Buffer Principal pour les trajets (24 octets par trajet)
  const RECORD_SIZE = 24;
  const buffer = Buffer.alloc(totalTrips * RECORD_SIZE);

  // 3. Deuxième passage : Remplissage binaire brut
  for (let i = 0; i < totalTrips; i++) {
    const id = tripIds[i];
    const t = tripsObj[id];
    const offset = i * RECORD_SIZE;

    // Écritures structurées selon notre offset interne
    buffer.writeUInt32LE(i, offset + 0);                      // trip_id_index (fait correspondre l'index binaire à la clé string)
    buffer.writeUInt32LE(parseInt(t.train_no, 10) || 0, offset + 4); // train_no
    buffer.writeUInt8(dateMap.get(t.date), offset + 8);       // date_index
    buffer.writeUInt16LE(stationMap.get(t.origin_id), offset + 9); // origin_id index
    buffer.writeUInt16LE(stationMap.get(t.dest_id), offset + 11);  // dest_id index
    buffer.writeUInt32LE(t.dep_time, offset + 13);            // dep_time
    buffer.writeUInt32LE(t.arr_time, offset + 17);            // arr_time
    buffer.writeUInt8(t.dispo ? 1 : 0, offset + 21);          // dispo
    // Les octets 22 et 23 restent à 0 (padding d'alignement)
  }

  // 4. Exportation du package complet incluant les métadonnées de décodage
  const finalPayload = {
    dictionaries: {
      trip_ids: tripIds, // Pourra servir au besoin à l'API pour renvoyer l'ID sous forme de chaîne
      dates: dates,
      stations: stations
    },
    tripsBinaryBase64: buffer.toString('base64')
  };

  const outputJsonString = JSON.stringify(finalPayload);
  const compressedData = zlib.gzipSync(Buffer.from(outputJsonString));
  
  fs.writeFileSync(path.join(OUT_DIR, 'trips.bin.gz'), compressedData);
  
  console.log(`✅ Fichier compressé généré : trips.bin.gz (${(compressedData.length / 1024 / 1024).toFixed(2)} Mo)`);
  console.log(`⚙️ Estimation RAM brute du Buffer en production : ${(buffer.length / 1024 / 1024).toFixed(2)} Mo`);
}

serialize();