#!/usr/bin/env node
/**
 * split-trips-by-date.js
 * Lit les trajets bruts et génère un JSON par jour
 * Usage: node split-trips-by-date.js [input-file] [output-dir]
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const INPUT = process.argv[2] || './trips-raw.txt';
const OUTPUT_DIR = process.argv[3] || './dates';

if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const tripsByDate = {};
let lineCount = 0;
let skipped = 0;

const rl = readline.createInterface({
  input: fs.createReadStream(INPUT),
  crlfDelay: Infinity
});

rl.on('line', (line) => {
  lineCount++;
  const trip = JSON.parse(line);
  
  if (!trip.date) {
    skipped++;
    return;
  }

  const date = trip.date; // Format: YYYY-MM-DD
  if (!tripsByDate[date]) tripsByDate[date] = [];
  tripsByDate[date].push(trip);
});

rl.on('close', () => {
  console.log(`📊 Total lignes: ${lineCount}, Skipped: ${skipped}`);
  
  Object.entries(tripsByDate).forEach(([date, trips]) => {
    const file = path.join(OUTPUT_DIR, `${date}.json`);
    fs.writeFileSync(file, JSON.stringify(trips, null, 0));
    console.log(`✅ ${date}: ${trips.length} trajets → ${file}`);
  });
  
  console.log(`\n✨ Tous les fichiers générés dans ${OUTPUT_DIR}`);
});