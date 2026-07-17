const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');

// 1. Récupération et nettoyage de l'URL (suppression d'un éventuel slash à la fin)
let supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("❌ Erreur : SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY doivent être définies.");
  process.exit(1);
}

if (supabaseUrl.endsWith('/')) {
  supabaseUrl = supabaseUrl.slice(0, -1);
}

// 2. Initialisation propre du client Supabase avec timeout
const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false },
  global: {
    fetch: (url, options) => {
      return fetch(url, {
        ...options,
        timeout: 120000 // 2 minutes timeout
      });
    }
  }
});

const BUCKET_NAME = 'tgvmax-data';
const CHUNK_SIZE = 20 * 1024 * 1024; // 20 Mo par chunk (bien en-dessous des limites)
const MAX_RETRIES = 3;
const RETRY_DELAY = 2000; // 2 secondes avant retry

// Fonction de délai
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Fonction de retry avec backoff exponentiel
async function uploadWithRetry(supabasePath, blob, attempt = 1) {
  try {
    const { error } = await supabase.storage
      .from(BUCKET_NAME)
      .upload(supabasePath, blob, {
        contentType: 'application/octet-stream',
        upsert: true
      });

    if (error) {
      throw new Error(error.message);
    }
    return true;
  } catch (err) {
    if (attempt < MAX_RETRIES) {
      const waitTime = RETRY_DELAY * Math.pow(2, attempt - 1); // Backoff: 2s, 4s, 8s...
      console.log(`  ⚠️ Tentative ${attempt}/${MAX_RETRIES} échouée. Nouvelle tentative dans ${waitTime / 1000}s...`);
      await sleep(waitTime);
      return uploadWithRetry(supabasePath, blob, attempt + 1);
    } else {
      throw new Error(`Erreur après ${MAX_RETRIES} tentatives: ${err.message}`);
    }
  }
}

async function uploadFile(localPath, remotePath) {
  if (!fs.existsSync(localPath)) {
    console.warn(`⚠️ Fichier introuvable, étape sautée : ${localPath}`);
    return;
  }

  try {
    const fileSize = fs.statSync(localPath).size;
    const fileSizeMb = (fileSize / 1024 / 1024).toFixed(2);
    
    console.log(`⏳ Envoi de ${localPath} (${fileSizeMb} Mo) vers Supabase...`);

    // Si le fichier est petit (<20Mo), upload simple
    if (fileSize < CHUNK_SIZE) {
      const fileBuffer = fs.readFileSync(localPath);
      const fileBlob = new Blob([fileBuffer], { type: 'application/json' });
      
      await uploadWithRetry(remotePath, fileBlob);
      console.log(`✅ ${localPath} envoyé avec succès !`);
      return;
    }

    // 🚀 CHUNKED UPLOAD : Découper et envoyer par morceaux
    console.log(`📦 Fichier volumineux détecté, découpage en chunks de 20 Mo...`);
    
    const fileStream = fs.createReadStream(localPath, {
      highWaterMark: CHUNK_SIZE
    });

    let chunkIndex = 0;
    let offset = 0;

    for await (const chunk of fileStream) {
      chunkIndex++;
      const chunkPath = `${remotePath}.chunk${chunkIndex}`;
      
      console.log(`  📨 Envoi du chunk ${chunkIndex} (${(chunk.length / 1024 / 1024).toFixed(2)} Mo)...`);

      const chunkBlob = new Blob([chunk], { type: 'application/octet-stream' });
      
      await uploadWithRetry(chunkPath, chunkBlob);

      offset += chunk.length;
      console.log(`  ✅ Chunk ${chunkIndex} envoyé (${(offset / 1024 / 1024).toFixed(2)} Mo / ${fileSizeMb} Mo)`);
      
      // Délai entre les chunks pour éviter la congestion
      if (chunkIndex < Math.ceil(fileSize / CHUNK_SIZE)) {
        await sleep(500); // 500ms entre les chunks
      }
    }

    // 📝 Créer un fichier de manifest pour reconstruire le fichier
    const manifest = {
      originalPath: remotePath,
      totalChunks: chunkIndex,
      totalSize: fileSize,
      chunkSize: CHUNK_SIZE,
      uploadedAt: new Date().toISOString()
    };

    const manifestBlob = new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' });
    await uploadWithRetry(`${remotePath}.manifest.json`, manifestBlob);

    console.log(`✅ ${localPath} envoyé en ${chunkIndex} chunks avec succès !`);

  } catch (err) {
    console.error(`❌ Erreur lors de l'envoi de ${localPath} :`, err.message);
    process.exit(1);
  }
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
    await uploadFile(file.local, file.remote);
  }
  console.log("🎉 Tous les fichiers de données ont été mis à jour sur Supabase !");
}

main();