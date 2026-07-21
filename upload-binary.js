const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

let supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("❌ Erreur : SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY doivent être définies.");
  process.exit(1);
}

if (supabaseUrl.endsWith('/')) {
  supabaseUrl = supabaseUrl.slice(0, -1);
}

const BUCKET_NAME = 'tgvmax-data';
const CHUNK_SIZE = 20 * 1024 * 1024; // 20 Mo par chunk
const MAX_RETRIES = 3;
const RETRY_DELAY = 3000; // 3 secondes

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────────────────
// Upload avec cURL natif (robuste, pas de dépendances)
// ─────────────────────────────────────────────────────────────────────────
async function uploadWithCurl(supabasePath, localFilePath, attempt = 1) {
  const url = `${supabaseUrl}/storage/v1/object/${BUCKET_NAME}/${supabasePath}`;
  
  // Option -S -f : Affiche les erreurs précises de curl et des réponses HTTP (400, 401, 404...)
  const curlCmd = `curl -S -f -X POST "${url}" \
    -H "Authorization: Bearer ${supabaseKey}" \
    -H "apikey: ${supabaseKey}" \
    -H "x-upsert: true" \
    -H "Content-Type: application/octet-stream" \
    --data-binary "@${localFilePath}"`;

  try {
    const response = execSync(curlCmd, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }).toString();
    return true;
  } catch (err) {
    // Afficher la réponse brute de Supabase dans les logs GitHub
    if (err.stdout) console.error("Détails HTTP Supabase:", err.stdout.toString());
    if (err.stderr) console.error("Détails Erreur cURL:", err.stderr.toString());

    if (attempt < MAX_RETRIES) {
      console.log(`  ⚠️ Tentative ${attempt}/${MAX_RETRIES} échouée. Nouvelle tentative...`);
      await sleep(RETRY_DELAY);
      return uploadWithCurl(supabasePath, localFilePath, attempt + 1);
    } else {
      throw new Error(`Erreur cURL après ${MAX_RETRIES} tentatives: ${err.message}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Optimisation : Pour les fichiers petits (< CHUNK_SIZE), upload direct
// Pour les gros fichiers, découpe en chunks et crée un manifest
// ─────────────────────────────────────────────────────────────────────────
async function uploadFile(localPath, remotePath) {
  if (!fs.existsSync(localPath)) {
    console.warn(`⚠️ Fichier introuvable, étape sautée : ${localPath}`);
    return;
  }

  const fileSize = fs.statSync(localPath).size;
  const fileSizeMb = (fileSize / 1024 / 1024).toFixed(2);
  
  console.log(`⏳ Envoi de ${path.basename(localPath)} (${fileSizeMb} Mo) vers Supabase...`);

  // Si le fichier est petit (<20Mo), on l'envoie directement
  if (fileSize < CHUNK_SIZE) {
    await uploadWithCurl(remotePath, localPath);
    console.log(`✅ ${path.basename(localPath)} envoyé avec succès !`);
    return;
  }

  // 🚀 Découpage en chunks pour les gros fichiers
  console.log(`📦 Fichier volumineux, découpage en morceaux de ${(CHUNK_SIZE / 1024 / 1024).toFixed(0)} Mo...`);
  
  const fileBuffer = fs.readFileSync(localPath);
  let chunkIndex = 0;
  let offset = 0;

  while (offset < fileSize) {
    chunkIndex++;
    const chunkPath = `${remotePath}.chunk${chunkIndex}`;
    const tempChunkFile = `temp_chunk_${chunkIndex}.bin`;
    
    // Extraire le morceau et l'écrire temporairement
    const chunkBuffer = fileBuffer.subarray(offset, Math.min(offset + CHUNK_SIZE, fileSize));
    fs.writeFileSync(tempChunkFile, chunkBuffer);

    console.log(`  📨 Chunk ${chunkIndex} (${(chunkBuffer.length / 1024 / 1024).toFixed(2)} Mo)...`);
    await uploadWithCurl(chunkPath, tempChunkFile);

    fs.unlinkSync(tempChunkFile);
    offset += chunkBuffer.length;
    
    const percent = ((offset / fileSize) * 100).toFixed(1);
    console.log(`  ✅ ${percent}% (${(offset / 1024 / 1024).toFixed(2)} Mo / ${fileSizeMb} Mo)`);
    await sleep(500);
  }

  // 📝 Manifest pour le serveur (si reconstruction nécessaire)
  const manifest = {
    originalPath: remotePath,
    totalChunks: chunkIndex,
    totalSize: fileSize,
    chunkSize: CHUNK_SIZE,
    uploadedAt: new Date().toISOString()
  };

  const tempManifestPath = 'temp_manifest.json';
  fs.writeFileSync(tempManifestPath, JSON.stringify(manifest, null, 2));
  await uploadWithCurl(`${remotePath}.manifest.json`, tempManifestPath);
  fs.unlinkSync(tempManifestPath);

  console.log(`✅ ${path.basename(localPath)} envoyé en ${chunkIndex} chunks !`);
}

// ─────────────────────────────────────────────────────────────────────────
// Main : Envoyer les fichiers binaires ET les fichiers JSON classiques
// ─────────────────────────────────────────────────────────────────────────
async function main() {
  console.log('╔═══════════════════════════════════════════════════════╗');
  console.log('║  Upload vers Supabase Storage (Format Binaire + JSON)  ║');
  console.log('╚═══════════════════════════════════════════════════════╝\n');
  console.time('Upload Total');

  // ✅ PRIORITÉ 1 : Fichier binaire compressé (le plus important)
  const filesToUpload = [
    // Fichiers binaires (pour le RAPTOR engine)
    { local: 'engine_data/trips.bin.gz', remote: 'trips.bin.gz', description: '📦 Binary trips (compressed)' },
    { local: 'engine_data/trips.bin.idx.json', remote: 'trips.bin.idx.json', description: '🔍 Binary index/reverse lookup' },
    
    // Fichiers JSON classiques (pour compatibilité/debug)
    { local: 'engine_data/stops.json', remote: 'stops.json', description: '🚇 Stops (gares)' },
    { local: 'engine_data/calendar_index.json', remote: 'calendar_index.json', description: '📅 Calendar index' },
    { local: 'engine_data/routes_by_stop.json', remote: 'routes_by_stop.json', description: '🔗 Routes by stop' },
    { local: 'engine_data/meta.json', remote: 'meta.json', description: '📊 Metadata' },
    { local: 'stations.json', remote: 'stations.json', description: '🚉 Stations lookup' }
  ];

  let uploaded = 0;
  let skipped = 0;

  for (const file of filesToUpload) {
    try {
      const exists = fs.existsSync(file.local);
      if (!exists) {
        console.log(`⊘ ${file.description}`);
        console.log(`   ℹ️  Fichier manquant : ${file.local}\n`);
        skipped++;
        continue;
      }

      console.log(`${file.description}`);
      await uploadFile(file.local, file.remote);
      uploaded++;
      console.log('');
    } catch (err) {
      console.error(`❌ ${file.description} - Erreur:`, err.message);
      console.log('');
      process.exit(1);
    }
  }

  console.timeEnd('Upload Total');
  console.log('\n══════════════════════════════════════════════════════');
  console.log(`✅ ${uploaded} fichiers téléchargés`);
  console.log(`⊘ ${skipped} fichiers manquants (ignorés)`);
  console.log('══════════════════════════════════════════════════════\n');
  
  console.log('🎉 Données TGVmax synchronisées sur Supabase !');
  console.log('   → Le serveur peut maintenant télécharger trips.bin.gz\n');
}

main().catch(err => {
  console.error('\n❌ Erreur globale:', err.message);
  process.exit(1);
});