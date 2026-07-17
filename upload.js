const fs = require('fs');
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
const CHUNK_SIZE = 20 * 1024 * 1024; // 20 Mo par chunk[cite: 2]
const MAX_RETRIES = 3; //[cite: 2]
const RETRY_DELAY = 3000; // 3 secondes

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 💡 La botte secrète : Utiliser le cURL natif du système pour uploader le fichier
async function uploadWithCurl(supabasePath, localFilePath, attempt = 1) {
  const url = `${supabaseUrl}/storage/v1/object/${BUCKET_NAME}/${supabasePath}`;
  
  // Commande cURL pour l'API REST de Supabase Storage (équivalent d'un UPSERT)
  const curlCmd = `curl -s -X POST "${url}" \
    -H "Authorization: Bearer ${supabaseKey}" \
    -H "apikey: ${supabaseKey}" \
    -H "x-upsert: true" \
    -H "Content-Type: application/octet-stream" \
    --data-binary "@${localFilePath}"`;

  try {
    // Exécute la commande. Si le statut HTTP n'est pas 2xx, cURL renvoie une erreur ou un JSON d'erreur
    const response = execSync(curlCmd).toString();
    
    if (response.includes('"error"')) {
      throw new Error(response);
    }
    return true;
  } catch (err) {
    if (attempt < MAX_RETRIES) {
      console.log(`  ⚠️ Tentative ${attempt}/${MAX_RETRIES} échouée avec cURL. Nouvelle tentative...`);
      await sleep(RETRY_DELAY);
      return uploadWithCurl(supabasePath, localFilePath, attempt + 1);
    } else {
      throw new Error(`Erreur cURL après ${MAX_RETRIES} tentatives: ${err.message}`);
    }
  }
}

async function uploadFile(localPath, remotePath) {
  if (!fs.existsSync(localPath)) {
    console.warn(`⚠️ Fichier introuvable, étape sautée : ${localPath}`);
    return;
  }

  const fileSize = fs.statSync(localPath).size;
  const fileSizeMb = (fileSize / 1024 / 1024).toFixed(2);
  
  console.log(`⏳ Envoi de ${localPath} (${fileSizeMb} Mo) vers Supabase via cURL...`);

  // Si le fichier est petit (<20Mo), on l'envoie directement
  if (fileSize < CHUNK_SIZE) {
    await uploadWithCurl(remotePath, localPath);
    console.log(`✅ ${localPath} envoyé avec succès !`);
    return;
  }

  // 🚀 Découpage physique en fichiers temporaires sur le disque pour cURL
  console.log(`📦 Fichier volumineux détecté, découpage en morceaux de 20 Mo...`);
  
  const fileBuffer = fs.readFileSync(localPath);
  let chunkIndex = 0;
  let offset = 0;

  while (offset < fileSize) {
    chunkIndex++;
    const chunkPath = `${remotePath}.chunk${chunkIndex}`;
    const tempChunkFile = `temp_chunk_${chunkIndex}.json`;
    
    // Extraire le morceau de 20Mo et l'écrire temporairement sur le disque de l'Action
    const chunkBuffer = fileBuffer.subarray(offset, Math.min(offset + CHUNK_SIZE, fileSize));
    fs.writeFileSync(tempChunkFile, chunkBuffer);

    console.log(`  📨 Envoi du chunk ${chunkIndex} (${(chunkBuffer.length / 1024 / 1024).toFixed(2)} Mo)...`);

    // Envoyer le fichier temporaire via cURL
    await uploadWithCurl(chunkPath, tempChunkFile);

    // Nettoyage du fichier temporaire
    fs.unlinkSync(tempChunkFile);

    offset += chunkBuffer.length;
    console.log(`  ✅ Chunk ${chunkIndex} envoyé (${(offset / 1024 / 1024).toFixed(2)} Mo / ${fileSizeMb} Mo)`);
    await sleep(500);
  }

  // 📝 Création et envoi du manifest pour votre server.js
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

  console.log(`✅ ${localPath} envoyé en ${chunkIndex} chunks avec succès !`);
}

async function main() {
  const files = [
    { local: 'engine_data/trips.json', remote: 'trips.json' },
    { local: 'engine_data/stops.json', remote: 'stops.json' },
    { local: 'engine_data/calendar_index.json', remote: 'calendar_index.json' },
    { local: 'engine_data/meta.json', remote: 'meta.json' },
    { local: 'engine_data/routes_by_stop.json', remote: 'routes_by_stop.json' },
    { local: 'stations.json', remote: 'stations.json' }
  ];

  for (const file of files) {
    try {
      await uploadFile(file.local, file.remote);
    } catch (err) {
      console.error(`❌ Erreur lors de l'envoi de ${file.local} :`, err.message);
      process.exit(1);
    }
  }
  console.log("🎉 Toutes les données sont sur Supabase !");
}

main();