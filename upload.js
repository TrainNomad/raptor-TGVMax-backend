const fs = require('fs');
const { execSync } = require('child_process');

let supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("❌ Erreur : SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY doivent être définies.");
  process.exit(1);
}

if (supabaseUrl.endsWith('/')) supabaseUrl = supabaseUrl.slice(0, -1);

const BUCKET_NAME = 'tgvmax-data';

async function uploadWithCurl(supabasePath, localFilePath) {
  const url = `${supabaseUrl}/storage/v1/object/${BUCKET_NAME}/${supabasePath}`;
  const curlCmd = `curl -s -X POST "${url}" \
    -H "Authorization: Bearer ${supabaseKey}" \
    -H "apikey: ${supabaseKey}" \
    -H "x-upsert: true" \
    -H "Content-Type: application/gzip" \
    --data-binary "@${localFilePath}"`;

  const response = execSync(curlCmd).toString();
  if (response.includes('"error"')) {
    throw new Error(response);
  }
  return true;
}

async function main() {
  const localPath = 'engine_data/trips.bin.gz';
  const remotePath = 'trips.bin.gz';

  if (!fs.existsSync(localPath)) {
    console.error(`❌ Fichier introuvable : ${localPath}`);
    process.exit(1);
  }

  console.log(`⏳ Envoi de ${localPath} vers Supabase...`);
  await uploadWithCurl(remotePath, localPath);
  console.log(`🎉 Données binaires déployées avec succès !`);
}

main().catch(err => { console.error(err); process.exit(1); });