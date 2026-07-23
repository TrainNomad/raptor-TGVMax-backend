const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATES_DIR = path.join(__dirname, 'dates');

app.use(express.json());

// Cache simple
const cache = {};
const CACHE_TTL = 3600000; // 1 heure

function loadTripsForDate(date) {
  if (cache[date] && Date.now() - cache[date].time < CACHE_TTL) {
    return cache[date].trips;
  }

  const file = path.join(DATES_DIR, `${date}.json`);
  if (!fs.existsSync(file)) {
    return null;
  }

  const trips = JSON.parse(fs.readFileSync(file, 'utf8'));
  cache[date] = { trips, time: Date.now() };
  return trips;
}

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// API: Get trips for a specific date
app.get('/api/trips/:date', (req, res) => {
  const { date } = req.params;
  
  // Validation format: YYYY-MM-DD
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Invalid date format, use YYYY-MM-DD' });
  }

  const trips = loadTripsForDate(date);
  if (!trips) {
    return res.status(404).json({ error: `No data for ${date}` });
  }

  res.json({ date, count: trips.length, trips });
});

// API: Get departures from origin on date
app.get('/api/departures', (req, res) => {
  const { origin, date } = req.query;
  
  if (!origin || !date) {
    return res.status(400).json({ error: 'origin and date parameters required' });
  }

  const trips = loadTripsForDate(date);
  if (!trips) {
    return res.status(404).json({ error: `No data for ${date}` });
  }

  const filtered = trips.filter(t => t.origin === origin).slice(0, 100);
  res.json({ origin, date, count: filtered.length, trips: filtered });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
  console.log(`📂 Serving JSON files from: ${DATES_DIR}`);
});

module.exports = app;