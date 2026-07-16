const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("❌ Erreur : SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY doivent être définies.");
  process.exit(1);
}

// 💡 CORRECTION : Désactivation explicite des websockets realtime pour éviter les crashs Node
const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    persistSession: false
  },
  realtime: {
    create實時Client: () => null // Désactive l'initialisation realtime
  }
});

const BUCKET_NAME = 'tgvmax-data';

async function uploadFile(localPath, supabasePath) {
  if (!fs.existsSync(localPath)) {
    console.warn(`⚠️ Fichier local introuvable, étape sautée : ${localPath}`);
    return;
  }

  const fileBuffer = fs.readFileSync(localPath);
  
  console.log(`⏳ Envoi de ${localPath} vers Supabase...`);
  const { data, error } = await supabase.storage
    .from(BUCKET_NAME)
    .upload(supabasePath, fileBuffer, {
      contentType: 'application/json',
      upsert: true // Écrase le fichier s'il existe déjà
    });

  if (error) {
    console.error(`❌ Erreur d'upload pour ${localPath}:`, error.message);
    process.exit(1);
  } else {
    console.log(`✅ ${localPath} mis à jour avec succès sur Supabase !`);
  }
}

async function main() {
  const filesToUpload = [
    { local: 'engine_data/trips.json', remote: 'trips.json' },
    { local: 'engine_data/stops.json', remote: 'stops.json' },
    { local: 'engine_data/calendar_index.json', remote: 'calendar_index.json' },
    { local: 'engine_data/meta.json', remote: 'meta.json' },
    { local: 'engine_data/routes_by_stop.json', remote: 'routes_by_stop.json' },
    { local: 'stations.json', remote: 'stations.json' }
  ];

  for (const file of filesToUpload) {
    await uploadFile(file.local, file.remote);
  }
  console.log("🎉 Toutes les données ont été envoyées sur Supabase !");
}

main();