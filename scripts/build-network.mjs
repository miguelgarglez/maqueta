#!/usr/bin/env node
// Build the leg network from real Digitraffic data.
// Input:  data/raw/stations.json, data/raw/trains-today.json
// Output: public/network.json — projected stations, deduped undirected legs, per-train routes
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const LAT0 = 63.5; // equirectangular reference for Finland
const KX = 111320 * Math.cos((LAT0 * Math.PI) / 180);
const KY = 110540;
const project = (lon, lat) => [lon * KX, -lat * KY]; // meters, y up = north

const stationsRaw = JSON.parse(readFileSync('data/raw/stations.json', 'utf8'));
const trains = JSON.parse(readFileSync('data/raw/trains-today.json', 'utf8'));

const PASSENGER = new Set(['Long-distance', 'Commuter']);
const stationByCode = new Map();
for (const s of stationsRaw) {
  if (s.countryCode !== 'FI') continue;
  stationByCode.set(s.stationShortCode, {
    code: s.stationShortCode,
    name: s.stationName,
    lon: s.longitude,
    lat: s.latitude,
    passenger: s.passengerTraffic === true,
    type: s.type,
  });
}

// Stop sequences per train (dedup consecutive, only real commercial stops)
const routes = [];
for (const t of trains) {
  if (!PASSENGER.has(t.trainCategory)) continue;
  const seq = [];
  for (const r of t.timeTableRows) {
    if (!r.trainStopping || !r.commercialStop) continue;
    const c = r.stationShortCode;
    if (stationByCode.has(c) && seq[seq.length - 1] !== c) seq.push(c);
  }
  if (seq.length < 2) continue;
  routes.push({
    n: t.trainNumber,
    type: t.trainType,
    cat: t.trainCategory,
    line: t.commuterLineID || null,
    stops: seq,
  });
}

// Undirected legs
const legMap = new Map();
for (const r of routes) {
  for (let i = 0; i + 1 < r.stops.length; i++) {
    const [a, b] = r.stops[i] < r.stops[i + 1] ? [r.stops[i], r.stops[i + 1]] : [r.stops[i + 1], r.stops[i]];
    const key = `${a}|${b}`;
    if (!legMap.has(key)) legMap.set(key, { a, b, uses: 0 });
    legMap.get(key).uses++;
  }
}

const hav = (la1, lo1, la2, lo2) => {
  const R = 6371000, d = Math.PI / 180;
  const a = Math.sin(((la2 - la1) * d) / 2) ** 2 + Math.cos(la1 * d) * Math.cos(la2 * d) * Math.sin(((lo2 - lo1) * d) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
};

let dropped = 0;
const legs = [];
for (const { a, b, uses } of legMap.values()) {
  const A = stationByCode.get(a), B = stationByCode.get(b);
  if (!A || !B) { dropped++; continue; }
  const len = hav(A.lat, A.lon, B.lat, B.lon);
  if (len > 250_000) { dropped++; continue; }
  const [ax, ay] = project(A.lon, A.lat), [bx, by] = project(B.lon, B.lat);
  // flex-track: long legs get a gentle deterministic bow
  const pts = [[ax, ay]];
  if (len > 25_000) {
    const mx = (ax + bx) / 2, my = (ay + by) / 2;
    const dx = bx - ax, dy = by - ay, l = Math.hypot(dx, dy);
    const sign = (a.charCodeAt(0) * 31 + b.charCodeAt(0) * 17 + a.length) % 2 ? 1 : -1;
    const off = Math.min(len * 0.045, 14_000) * sign;
    pts.push([mx - (dy / l) * off, my + (dx / l) * off]);
  }
  pts.push([bx, by]);
  legs.push({ a, b, pts, len: Math.round(len), uses });
}

// stations actually used
const used = new Set(routes.flatMap(r => r.stops));
const stations = [...used].map(c => {
  const s = stationByCode.get(c);
  const [x, y] = project(s.lon, s.lat);
  return { code: c, name: s.name, x: Math.round(x), y: Math.round(y), pax: s.passenger };
});

const xs = stations.map(s => s.x), ys = stations.map(s => s.y);
const bounds = {
  minX: Math.min(...xs), maxX: Math.max(...xs),
  minY: Math.min(...ys), maxY: Math.max(...ys),
};

mkdirSync('public', { recursive: true });
writeFileSync('public/network.json', JSON.stringify({
  generated: new Date().toISOString(),
  lat0: LAT0, kx: KX, ky: KY,
  bounds, stations, legs,
}, null, 0));

console.log(`stations used: ${stations.length} / ${stationByCode.size}`);
console.log(`routes: ${routes.length}, legs: ${legs.length} (dropped ${dropped})`);
console.log(`bounds: ${(bounds.maxX - bounds.minX) / 1000 | 0} x ${(bounds.maxY - bounds.minY) / 1000 | 0} km`);
