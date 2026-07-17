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

// 2. Initialisation propre du client Supabase
const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false }
});

const BUCKET_NAME = 'tgvmax-data';
const CHUNK_SIZE = 45 * 1024 * 1024; // 45 Mo par chunk (< limite 50Mo de Supabase)

async function uploadFile(localPath, remotePath) {
  if (!fs.existsSync(localPath)) {
    console.warn(`⚠️ Fichier introuvable, étape sautée : ${localPath}`);
    return;
  }

  try {
    const fileSize = fs.statSync(localPath).size;
    const fileSizeMb = (fileSize / 1024 / 1024).toFixed(2);
    
    console.log(`⏳ Envoi de ${localPath} (${fileSizeMb} Mo) vers Supabase...`);

    // Si le fichier est petit (<45Mo), upload simple
    if (fileSize < CHUNK_SIZE) {
      const fileBuffer = fs.readFileSync(localPath);
      const fileBlob = new Blob([fileBuffer], { type: 'application/json' });
      
      const { error } = await supabase.storage
        .from(BUCKET_NAME)
        .upload(remotePath, fileBlob, {
          contentType: 'application/json',
          upsert: true
        });

      if (error) {
        throw new Error(error.message);
      }
      console.log(`✅ ${localPath} envoyé avec succès !`);
      return;
    }

    // 🚀 CHUNKED UPLOAD : Découper et envoyer par morceaux
    console.log(`📦 Fichier volumineux détecté, découpage en chunks de 45 Mo...`);
    
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
      
      const { error } = await supabase.storage
        .from(BUCKET_NAME)
        .upload(chunkPath, chunkBlob, {
          contentType: 'application/octet-stream',
          upsert: true
        });

      if (error) {
        throw new Error(`Erreur chunk ${chunkIndex}: ${error.message}`);
      }

      offset += chunk.length;
      console.log(`  ✅ Chunk ${chunkIndex} envoyé (${(offset / 1024 / 1024).toFixed(2)} Mo / ${fileSizeMb} Mo)`);
    }

    // 📝 Créer un fichier de manifest pour reconstruire le fichier
    const manifest = {
      originalPath: remotePath,
      totalChunks: chunkIndex,
      totalSize: fileSize,
      uploadedAt: new Date().toISOString()
    };

    const manifestBlob = new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' });
    await supabase.storage
      .from(BUCKET_NAME)
      .upload(`${remotePath}.manifest.json`, manifestBlob, { upsert: true });

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