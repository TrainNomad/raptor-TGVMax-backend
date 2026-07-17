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

async function uploadFile(localPath, remotePath) {
  if (!fs.existsSync(localPath)) {
    console.warn(`⚠️ Fichier introuvable, étape sautée : ${localPath}`);
    return;
  }

  try {
    const fileBuffer = fs.readFileSync(localPath);
    
    // 💡 Astuce de compatibilité Node 22 : On convertit le Buffer en Blob standardisé
    // pour éviter les crashs de "fetch failed" sur les gros fichiers comme trips.json
    const fileBlob = new Blob([fileBuffer], { type: 'application/json' });
    
    console.log(`⏳ Envoi de ${localPath} (${(fileBuffer.length / 1024 / 1024).toFixed(2)} Mo) vers Supabase...`);

    const { error } = await supabase.storage
      .from(BUCKET_NAME)
      .upload(remotePath, fileBlob, {
        contentType: 'application/json',
        upsert: true // Écrase le fichier s'il existe déjà
      });

    if (error) {
      console.error(`❌ Erreur retournée par Supabase pour ${localPath} :`, error.message);
      process.exit(1);
    } else {
      console.log(`✅ ${localPath} envoyé avec succès sous le nom "${remotePath}" !`);
    }
  } catch (err) {
    console.error(`❌ Crash système lors de l'envoi de ${localPath} :`, err);
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