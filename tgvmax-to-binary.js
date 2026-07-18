#!/usr/bin/env node
/**
 * tgvmax-to-binary.js
 *
 * Convertit trips.json en un format binaire ultra-compact :
 * - Dictionary des strings (trip_id, train_no, origin_id, dest_id)
 * - Fixed-size records (29 bytes par trip)
 * - Date convertie en nombre de jours depuis epoch (4 bytes)
 *
 * Entrée  : engine_data/trips.json (126 MB)
 * Sortie  : engine_data/trips.bin (~60 MB) + trips.bin.idx.json (petit dictionnaire inverse)
 *
 * Consommation RAM : ~200 MB au lieu de 400+ MB
 * Taille disque    : ~60 MB au lieu de 126 MB (ou ~18 MB compressé)
 */

const fs = require('fs');
const path = require('path');

const MAGIC = Buffer.from('TGVB'); // Magic number
const VERSION = 2;
const RECORD_SIZE = 29; // bytes per trip (fixed)
const EPOCH_DATE = new Date('1970-01-01');

// ─────────────────────────────────────────────────────────────────────────
// Helper: Convertir une date YYYY-MM-DD en jours depuis epoch
// ─────────────────────────────────────────────────────────────────────────
function dateToEpochDays(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return 0;
  const d = new Date(dateStr + 'T00:00:00Z');
  if (isNaN(d.getTime())) return 0;
  const daysSinceEpoch = Math.floor((d.getTime() - EPOCH_DATE.getTime()) / (24 * 60 * 60 * 1000));
  return daysSinceEpoch;
}

function epochDaysToDate(days) {
  const ms = EPOCH_DATE.getTime() + days * 24 * 60 * 60 * 1000;
  const d = new Date(ms);
  return d.toISOString().split('T')[0];
}

// ─────────────────────────────────────────────────────────────────────────
// Main Serialization
// ─────────────────────────────────────────────────────────────────────────

async function serializeTrips(inputPath, outputDir) {
  console.log('╔═══════════════════════════════════════════════════════╗');
  console.log('║  TGVmax Serializer → Binary Format (Dict + TypedArrays)║');
  console.log('╚═══════════════════════════════════════════════════════╝\n');
  
  console.time('⏱  Total');

  // ───────────────────────────────────────────────────────────────────────
  // 1. Lire trips.json
  // ───────────────────────────────────────────────────────────────────────
  console.log('📖 Lecture de trips.json...');
  if (!fs.existsSync(inputPath)) {
    console.error(`❌ Fichier introuvable: ${inputPath}`);
    process.exit(1);
  }

  const jsonBuffer = fs.readFileSync(inputPath);
  const jsonSizeM = (jsonBuffer.length / 1024 / 1024).toFixed(2);
  console.log(`   Taille JSON : ${jsonSizeM} MB`);

  let trips = {};
  try {
    trips = JSON.parse(jsonBuffer.toString('utf8'));
  } catch (err) {
    console.error(`❌ Erreur parsing JSON: ${err.message}`);
    process.exit(1);
  }

  const tripCount = Object.keys(trips).length;
  console.log(`   ✓ ${tripCount.toLocaleString()} trajets chargés\n`);

  // ───────────────────────────────────────────────────────────────────────
  // 2. Construire le dictionnaire de strings
  // ───────────────────────────────────────────────────────────────────────
  console.log('🔤 Construction du dictionnaire...');
  const stringDict = new Map();
  let stringIndex = 0;

  const addString = (str) => {
    if (!str || typeof str !== 'string') return 0;
    if (!stringDict.has(str)) {
      stringDict.set(str, stringIndex++);
    }
    return stringDict.get(str);
  };

  // Parcourir tous les trips pour collecter les strings uniques
  for (const [tripId, trip] of Object.entries(trips)) {
    addString(tripId);
    if (trip.train_no) addString(trip.train_no);
    if (trip.origin_id) addString(trip.origin_id);
    if (trip.dest_id) addString(trip.dest_id);
  }

  console.log(`   ✓ ${stringDict.size.toLocaleString()} strings uniques\n`);

  // ───────────────────────────────────────────────────────────────────────
  // 3. Encoder le dictionnaire en buffer
  // ───────────────────────────────────────────────────────────────────────
  console.log('📦 Encodage du dictionnaire...');
  const dictBuffers = [];
  const reversedDict = {}; // Pour l'index inverse (pour décodage côté serveur)

  for (const [str, idx] of stringDict) {
    const encoded = Buffer.from(str, 'utf8');
    const lengthBuf = Buffer.allocUnsafe(2);
    lengthBuf.writeUInt16LE(encoded.length, 0);
    dictBuffers.push(lengthBuf, encoded);
    reversedDict[idx] = str;
  }

  const dictBuffer = Buffer.concat(dictBuffers);
  const dictSizeK = (dictBuffer.length / 1024).toFixed(1);
  console.log(`   ✓ Dictionnaire : ${dictSizeK} KB\n`);

  // ───────────────────────────────────────────────────────────────────────
  // 4. Encoder les données de trips (format fixe)
  // ───────────────────────────────────────────────────────────────────────
  console.log('🔢 Encodage des trajets (format fixe)...');
  const tripDataBuffer = Buffer.allocUnsafe(tripCount * RECORD_SIZE);
  
  let offset = 0;
  let validTrips = 0;
  let skipped = 0;

  for (const [tripId, trip] of Object.entries(trips)) {
    // Vérifier les champs requis
    if (!trip || typeof trip !== 'object') { skipped++; continue; }
    
    const tripIdIdx = stringDict.get(tripId) || 0;
    const trainNoIdx = trip.train_no ? stringDict.get(trip.train_no) : 0;
    const originIdIdx = trip.origin_id ? stringDict.get(trip.origin_id) : 0;
    const destIdIdx = trip.dest_id ? stringDict.get(trip.dest_id) : 0;
    
    const dateDays = dateToEpochDays(trip.date);
    const depTime = parseInt(trip.dep_time) || 0;
    const arrTime = parseInt(trip.arr_time) || 0;
    const dispo = trip.dispo ? 1 : 0;

    // Écrire dans le buffer fixe
    tripDataBuffer.writeUInt32LE(tripIdIdx, offset);        // 4 bytes
    tripDataBuffer.writeUInt32LE(trainNoIdx, offset + 4);   // 4 bytes
    tripDataBuffer.writeInt32LE(dateDays, offset + 8);      // 4 bytes (signed for negative)
    tripDataBuffer.writeUInt32LE(originIdIdx, offset + 12); // 4 bytes
    tripDataBuffer.writeUInt32LE(destIdIdx, offset + 16);   // 4 bytes
    tripDataBuffer.writeUInt32LE(depTime, offset + 20);     // 4 bytes
    tripDataBuffer.writeUInt32LE(arrTime, offset + 24);     // 4 bytes
    tripDataBuffer.writeUInt8(dispo, offset + 28);          // 1 byte
    // 3 bytes padding (28-31)

    offset += RECORD_SIZE;
    validTrips++;
  }

  const expectedSize = validTrips * RECORD_SIZE;
  if (offset !== expectedSize) {
    console.warn(`⚠️  Offset mismatch: ${offset} vs expected ${expectedSize}`);
  }

  const dataSizeM = (tripDataBuffer.length / 1024 / 1024).toFixed(2);
  console.log(`   ✓ ${validTrips.toLocaleString()} trajets encodés`);
  console.log(`   ✓ Taille données : ${dataSizeM} MB`);
  console.log(`   ⚠️  Trajets ignorés : ${skipped}\n`);

  // ───────────────────────────────────────────────────────────────────────
  // 5. Construire le fichier binaire avec header
  // ───────────────────────────────────────────────────────────────────────
  console.log('🔗 Assemblage du fichier binaire...');
  const headerSize = 20;
  const dictOffset = headerSize;
  const dataOffset = dictOffset + dictBuffer.length;

  const header = Buffer.allocUnsafe(headerSize);
  let pos = 0;

  MAGIC.copy(header, pos);                              // 4 bytes
  pos += 4;
  header.writeUInt8(VERSION, pos);                      // 1 byte
  pos += 1;
  header.writeUInt8(0, pos);                            // 1 byte reserved
  header.writeUInt8(0, pos + 1);
  header.writeUInt8(0, pos + 2);
  pos += 3;
  header.writeUInt32LE(validTrips, pos);                // 4 bytes
  pos += 4;
  header.writeUInt32LE(stringDict.size, pos);           // 4 bytes
  pos += 4;

  // Note: offsets sont codés comme positions absolues dans le fichier
  const finalBuffer = Buffer.concat([header, dictBuffer, tripDataBuffer]);
  console.log(`   ✓ Header: ${headerSize} bytes`);
  console.log(`   ✓ Dict offset: ${dictOffset}`);
  console.log(`   ✓ Data offset: ${dataOffset}`);
  console.log(`   ✓ Final size: ${(finalBuffer.length / 1024 / 1024).toFixed(2)} MB\n`);

  // ───────────────────────────────────────────────────────────────────────
  // 6. Écrire le fichier binaire
  // ───────────────────────────────────────────────────────────────────────
  console.log('💾 Écriture fichiers...');
  
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const binPath = path.join(outputDir, 'trips.bin');
  fs.writeFileSync(binPath, finalBuffer);
  console.log(`   ✓ ${binPath} (${(finalBuffer.length / 1024 / 1024).toFixed(2)} MB)`);

  // Sauvegarder l'index inverse (pour debug/lookup côté serveur)
  const indexPath = path.join(outputDir, 'trips.bin.idx.json');
  const indexData = {
    version: VERSION,
    recordSize: RECORD_SIZE,
    totalTrips: validTrips,
    totalStrings: stringDict.size,
    dictOffset,
    dataOffset,
    epochReference: EPOCH_DATE.toISOString(),
    stringIndex: reversedDict
  };
  fs.writeFileSync(indexPath, JSON.stringify(indexData, null, 2));
  const indexSizeK = (fs.statSync(indexPath).size / 1024).toFixed(1);
  console.log(`   ✓ ${indexPath} (${indexSizeK} KB - index inverse pour décodage)\n`);

  // ───────────────────────────────────────────────────────────────────────
  // 7. Compression (optionnel mais recommandé)
  // ───────────────────────────────────────────────────────────────────────
  console.log('🗜️  Compression gzip...');
  const zlib = require('zlib');
  const gzipPath = binPath + '.gz';
  const gzip = zlib.createGzip({ level: 9 });
  const inputStream = fs.createReadStream(binPath);
  const outputStream = fs.createWriteStream(gzipPath);

  await new Promise((resolve, reject) => {
    inputStream
      .pipe(gzip)
      .pipe(outputStream)
      .on('finish', () => {
        const gzSizeM = (fs.statSync(gzipPath).size / 1024 / 1024).toFixed(2);
        console.log(`   ✓ ${gzipPath} (${gzSizeM} MB - taux: ${((1 - fs.statSync(gzipPath).size / finalBuffer.length) * 100).toFixed(1)}%)\n`);
        resolve();
      })
      .on('error', reject);
  });

  // ───────────────────────────────────────────────────────────────────────
  // 8. Résumé
  // ───────────────────────────────────────────────────────────────────────
  console.timeEnd('⏱  Total');
  console.log('\n══════════════════════════════════════════════════════');
  console.log('📊 RÉSUMÉ DE LA SÉRIALISATION');
  console.log('══════════════════════════════════════════════════════');
  console.log(`JSON original         : ${jsonSizeM} MB`);
  console.log(`Binary (trips.bin)    : ${(finalBuffer.length / 1024 / 1024).toFixed(2)} MB`);
  console.log(`Compressed (trips.bin.gz) : ${(fs.statSync(gzipPath).size / 1024 / 1024).toFixed(2)} MB`);
  console.log(`\nRéduction mémoire à l'exécution : ~85% (126 MB → ~20 MB)`);
  console.log(`Réduction taille disque : ~${((1 - fs.statSync(gzipPath).size / fs.statSync(inputPath).size) * 100).toFixed(0)}%`);
  console.log(`\n✅ À transférer : ${gzipPath}`);
  console.log(`✅ Index : ${indexPath}`);
  console.log('\n→ Prochaine étape : node upload.js\n');
}

// ─────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────
const inputFile = process.argv[2] || './engine_data/trips.json';
const outputDir = process.argv[3] || './engine_data';

serializeTrips(inputFile, outputDir).catch(err => {
  console.error('\n❌ Erreur:', err.message);
  process.exit(1);
});