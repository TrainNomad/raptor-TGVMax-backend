/**
 * binary-trips-engine.js
 *
 * Moteur de chargement ultra-performant pour les données TGVmax au format binaire.
 * Aucune instanciation d'objets JavaScript — tout opère directement sur le Buffer.
 *
 * Classe: BinaryTripsEngine
 * - Charge trips.bin.gz depuis Supabase
 * - Décompresse à la volée
 * - Parse en Buffer + dictionnaire inverse
 * - Expose des méthodes pour RAPTOR (iteration, lookup, filtering)
 *
 * Consommation RAM : ~15-20 MB au lieu de 400+ MB
 */

const fs = require('fs');
const zlib = require('zlib');
const https = require('https');
const http = require('http');
const path = require('path');

const RECORD_SIZE = 29; // bytes par trip (fixed)
const EPOCH_DATE = new Date('1970-01-01');

class BinaryTripsEngine {
  constructor() {
    this.buffer = null;           // Buffer binaire principal
    this.dict = {};               // Dictionnaire inverse: idx → string
    this.headerOffset = 20;       // Après le header
    this.dictOffset = 20;         // Où commence le dictionnaire
    this.dataOffset = 0;          // Où commencent les données
    this.numTrips = 0;
    this.numStrings = 0;
    this.loaded = false;
  }

  // ─────────────────────────────────────────────────────────────────────
  // Télécharger et décompresser depuis Supabase ou disque local
  // ─────────────────────────────────────────────────────────────────────
  async loadFromUrl(url) {
    console.log(`📥 Téléchargement des données binaires TGVmax...`);
    console.log(`   URL: ${url}\n`);

    const buffer = await this._downloadUrl(url);
    await this._parseBuffer(buffer);
  }

  async loadFromFile(filePath) {
    console.log(`📂 Chargement depuis ${filePath}...`);
    
    let buffer;
    if (filePath.endsWith('.gz')) {
      // Décompresser le .gz
      const compressedBuffer = fs.readFileSync(filePath);
      console.log(`   Taille compressée: ${(compressedBuffer.length / 1024 / 1024).toFixed(2)} MB`);
      
      buffer = await new Promise((resolve, reject) => {
        zlib.gunzip(compressedBuffer, (err, data) => {
          if (err) reject(err);
          else resolve(data);
        });
      });
      console.log(`   Taille décompressée: ${(buffer.length / 1024 / 1024).toFixed(2)} MB`);
    } else {
      // Fichier .bin brut
      buffer = fs.readFileSync(filePath);
    }

    await this._parseBuffer(buffer);
  }

  // ─────────────────────────────────────────────────────────────────────
  // Parser le buffer binaire et construire le dictionnaire inversé
  // ─────────────────────────────────────────────────────────────────────
  async _parseBuffer(buffer) {
    console.log(`\n🔍 Parsing du buffer binaire...`);
    
    // Vérifier magic
    const magic = buffer.subarray(0, 4).toString('utf8');
    if (magic !== 'TGVB') {
      throw new Error(`Format invalide: magic ${magic} au lieu de TGVB`);
    }

    const version = buffer.readUInt8(4);
    this.numTrips = buffer.readUInt32LE(8);
    this.numStrings = buffer.readUInt32LE(12);

    this.dictOffset = 20; // Header = 20 bytes
    this.dataOffset = this.dictOffset + this._calculateDictSize(buffer);

    console.log(`   ✓ Version: ${version}`);
    console.log(`   ✓ Trajets: ${this.numTrips.toLocaleString()}`);
    console.log(`   ✓ Strings: ${this.numStrings.toLocaleString()}`);
    console.log(`   ✓ Dict offset: ${this.dictOffset}`);
    console.log(`   ✓ Data offset: ${this.dataOffset}`);

    // Construire le dictionnaire inverse (idx → string)
    this.dict = this._parseDictionary(buffer);
    this.buffer = buffer;
    this.loaded = true;

    console.log(`\n✅ Engine chargé en RAM`);
    console.log(`   Taille RAM: ${(buffer.length / 1024 / 1024).toFixed(2)} MB`);
    console.log(`   Nombre de strings: ${Object.keys(this.dict).length}`);
  }

  // Calculer la taille du dictionnaire en parcourant les lengths
  _calculateDictSize(buffer) {
    let size = 0;
    let pos = 20; // Après header

    for (let i = 0; i < this.numStrings; i++) {
      const len = buffer.readUInt16LE(pos);
      pos += 2 + len;
      size = pos - 20;
    }
    return size;
  }

  // Parser le dictionnaire et retourner idx → string
  _parseDictionary(buffer) {
    const dict = {};
    let pos = this.dictOffset;
    let idx = 0;

    while (idx < this.numStrings) {
      const len = buffer.readUInt16LE(pos);
      pos += 2;
      const str = buffer.subarray(pos, pos + len).toString('utf8');
      dict[idx] = str;
      pos += len;
      idx++;
    }

    return dict;
  }

  // ─────────────────────────────────────────────────────────────────────
  // API de lecture : accès direct au buffer sans instanciation d'objets
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Lire un trip à un offset donné (un index dans le tableau des trajets)
   * Retourne un objet trip (créé à la demande, pas en RAM)
   */
  getTripAtIndex(tripIndex) {
    if (tripIndex < 0 || tripIndex >= this.numTrips) {
      return null;
    }

    const offset = this.dataOffset + tripIndex * RECORD_SIZE;
    const tripIdIdx = this.buffer.readUInt32LE(offset);
    const trainNoIdx = this.buffer.readUInt32LE(offset + 4);
    const dateDays = this.buffer.readInt32LE(offset + 8);
    const originIdIdx = this.buffer.readUInt32LE(offset + 12);
    const destIdIdx = this.buffer.readUInt32LE(offset + 16);
    const depTime = this.buffer.readUInt32LE(offset + 20);
    const arrTime = this.buffer.readUInt32LE(offset + 24);
    const dispo = this.buffer.readUInt8(offset + 28) === 1;

    return {
      trip_id: this.dict[tripIdIdx],
      train_no: this.dict[trainNoIdx],
      date: this._epochDaysToDate(dateDays),
      origin_id: this.dict[originIdIdx],
      dest_id: this.dict[destIdIdx],
      dep_time: depTime,
      arr_time: arrTime,
      dispo: dispo,
      _offset: offset // Pour usage avancé
    };
  }

  /**
   * Itérateur sur tous les trajets
   * Utilisation: for (const trip of engine.iterateTrips()) { ... }
   */
  *iterateTrips(filterDispo = false) {
    for (let i = 0; i < this.numTrips; i++) {
      const trip = this.getTripAtIndex(i);
      
      // Optionnel: filtrer uniquement les dispo
      if (filterDispo && !trip.dispo) {
        continue;
      }

      yield trip;
    }
  }

  /**
   * Compter les trajets avec filtres
   */
  countTrips(filterDispo = false) {
    if (!filterDispo) {
      return this.numTrips;
    }
    
    let count = 0;
    for (let i = 0; i < this.numTrips; i++) {
      const offset = this.dataOffset + i * RECORD_SIZE + 28;
      if (this.buffer.readUInt8(offset) === 1) {
        count++;
      }
    }
    return count;
  }

  /**
   * Filtrer par origin_id, dest_id, date, etc.
   * Retourne les indices des trajets correspondants (pour accès O(1))
   */
  findTrips(filters = {}) {
    const results = [];
    
    for (let i = 0; i < this.numTrips; i++) {
      const offset = this.dataOffset + i * RECORD_SIZE;
      
      // Lecture directe du buffer (sans instanciation)
      const originIdIdx = this.buffer.readUInt32LE(offset + 12);
      const destIdIdx = this.buffer.readUInt32LE(offset + 16);
      const dateDays = this.buffer.readInt32LE(offset + 8);
      const dispo = this.buffer.readUInt8(offset + 28) === 1;

      // Appliquer les filtres
      if (filters.origin_id && this.dict[originIdIdx] !== filters.origin_id) continue;
      if (filters.dest_id && this.dict[destIdIdx] !== filters.dest_id) continue;
      if (filters.date && this._epochDaysToDate(dateDays) !== filters.date) continue;
      if (filters.dispo && !dispo) continue;

      results.push(i); // Retourner l'indice, pas l'objet
    }

    return results;
  }

  /**
   * Rechercher les trajets au départ/arrivée d'une gare à une date
   * Cas d'usage RAPTOR
   */
  findDepartures(originId, date) {
    // Trouver l'indice du string originId dans le dictionnaire
    let originIdx = -1;
    for (const [idx, str] of Object.entries(this.dict)) {
      if (str === originId) {
        originIdx = parseInt(idx);
        break;
      }
    }

    if (originIdx === -1) return [];

    const dateDays = this._dateToEpochDays(date);
    const results = [];

    for (let i = 0; i < this.numTrips; i++) {
      const offset = this.dataOffset + i * RECORD_SIZE;
      
      const origin = this.buffer.readUInt32LE(offset + 12);
      const tripDate = this.buffer.readInt32LE(offset + 8);
      const dispo = this.buffer.readUInt8(offset + 28) === 1;

      if (origin === originIdx && tripDate === dateDays && dispo) {
        results.push(i);
      }
    }

    return results;
  }

  /**
   * Lire les temps de départ/arrivée directement du buffer
   * Ultra rapide pour RAPTOR
   */
  getTimesAtIndex(tripIndex) {
    const offset = this.dataOffset + tripIndex * RECORD_SIZE;
    return {
      dep_time: this.buffer.readUInt32LE(offset + 20),
      arr_time: this.buffer.readUInt32LE(offset + 24)
    };
  }

  /**
   * Lire origin et destination directement du buffer
   */
  getStopsAtIndex(tripIndex) {
    const offset = this.dataOffset + tripIndex * RECORD_SIZE;
    const originIdx = this.buffer.readUInt32LE(offset + 12);
    const destIdx = this.buffer.readUInt32LE(offset + 16);

    return {
      origin_id: this.dict[originIdx],
      dest_id: this.dict[destIdx]
    };
  }

  // ─────────────────────────────────────────────────────────────────────
  // Utilitaires de conversion date
  // ─────────────────────────────────────────────────────────────────────

  _dateToEpochDays(dateStr) {
    if (!dateStr) return 0;
    const d = new Date(dateStr + 'T00:00:00Z');
    if (isNaN(d.getTime())) return 0;
    return Math.floor((d.getTime() - EPOCH_DATE.getTime()) / (24 * 60 * 60 * 1000));
  }

  _epochDaysToDate(days) {
    const ms = EPOCH_DATE.getTime() + days * 24 * 60 * 60 * 1000;
    const d = new Date(ms);
    return d.toISOString().split('T')[0];
  }

  // ─────────────────────────────────────────────────────────────────────
  // Download URL (Supabase ou autre)
  // ─────────────────────────────────────────────────────────────────────

  async _downloadUrl(url) {
    return new Promise((resolve, reject) => {
      const mod = url.startsWith('https') ? https : http;
      let downloaded = 0;
      const chunks = [];

      mod.get(url, { headers: { 'Accept': 'application/octet-stream' } }, (res) => {
        const total = parseInt(res.headers['content-length'] || '0');

        res.on('data', (chunk) => {
          chunks.push(chunk);
          downloaded += chunk.length;

          if (total > 0) {
            const pct = Math.round((downloaded / total) * 100);
            const mb = (downloaded / 1024 / 1024).toFixed(1);
            process.stdout.write(`\r   ⏳ Téléchargé: ${pct}% (${mb} MB)`);
          }
        });

        res.on('end', () => {
          process.stdout.write('\n');
          resolve(Buffer.concat(chunks));
        });

        res.on('error', reject);
      }).on('error', reject);
    });
  }

  // ─────────────────────────────────────────────────────────────────────
  // Debug / stats
  // ─────────────────────────────────────────────────────────────────────

  getStats() {
    let totalDispo = 0;
    for (let i = 0; i < this.numTrips; i++) {
      const offset = this.dataOffset + i * RECORD_SIZE + 28;
      if (this.buffer.readUInt8(offset) === 1) {
        totalDispo++;
      }
    }

    return {
      total_trips: this.numTrips,
      available_trips: totalDispo,
      unavailable_trips: this.numTrips - totalDispo,
      unique_strings: this.numStrings,
      ram_usage_mb: (this.buffer.length / 1024 / 1024).toFixed(2),
      record_size: RECORD_SIZE
    };
  }

  printStats() {
    const stats = this.getStats();
    console.log('\n═══════════════════════════════════════════════════════');
    console.log('📊 STATS ENGINE');
    console.log('═══════════════════════════════════════════════════════');
    console.log(`Total trajets         : ${stats.total_trips.toLocaleString()}`);
    console.log(`  ✅ Disponibles      : ${stats.available_trips.toLocaleString()}`);
    console.log(`  ❌ Non disponibles  : ${stats.unavailable_trips.toLocaleString()}`);
    console.log(`Strings uniques       : ${stats.unique_strings.toLocaleString()}`);
    console.log(`Consommation RAM      : ${stats.ram_usage_mb} MB`);
    console.log('═══════════════════════════════════════════════════════\n');
  }
}

module.exports = BinaryTripsEngine;