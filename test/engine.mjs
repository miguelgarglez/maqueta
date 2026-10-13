// Engine test on recorded real data. Run: node test/engine.mjs
import { readFileSync } from 'node:fs';
import { loadNetwork, routeLegs, routeLength, projectToRoute, positionAt, nextStop, makeMover, sunAltitude, weatherKind } from '../src/lib/engine.mjs';

const net = loadNetwork(JSON.parse(readFileSync('public/network.json', 'utf8')));
const stationsRaw = JSON.parse(readFileSync('data/raw/stations.json', 'utf8'));
const stationLL = new Map(stationsRaw.map(s => [s.stationShortCode, s]));
const positions = JSON.parse(readFileSync('data/raw/positions-sample.json', 'utf8'));
const trains = JSON.parse(readFileSync('data/raw/trains-today.json', 'utf8'));
const trainByNum = new Map(trains.map(t => [t.trainNumber, t]));

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.log('  FAIL:', msg); } };

// 1. every passenger train's route resolves to a connected chain
let routes = 0, missingLegs = 0;
for (const t of trains) {
  if (!['Long-distance', 'Commuter'].includes(t.trainCategory)) continue;
  const seq = [];
  for (const r of t.timeTableRows) {
    if (!r.trainStopping || !r.commercialStop) continue;
    if (stationLL.has(r.stationShortCode) && seq[seq.length - 1] !== r.stationShortCode) seq.push(r.stationShortCode);
  }
  if (seq.length < 2) continue;
  const chain = routeLegs(seq, net);
  routes++;
  if (chain.length < seq.length - 1) missingLegs++;
  for (const c of chain) {
    ok(c.idx.poly.len > 0, `zero-length leg ${c.from}->${c.to}`);
  }
}
console.log(`routes checked: ${routes}, with missing legs: ${missingLegs}`);
ok(routes > 900, 'expected most of today\'s passenger services');
ok(missingLegs / routes < 0.02, 'too many routes with missing legs');

// 2. live GPS positions project onto own routes with small error
let projected = 0, far = [];
for (const p of positions) {
  const t = trainByNum.get(p.trainNumber);
  if (!t || !['Long-distance', 'Commuter'].includes(t.trainCategory)) continue;
  const seq = [];
  for (const r of t.timeTableRows) {
    if (!r.trainStopping || !r.commercialStop) continue;
    if (stationLL.has(r.stationShortCode) && seq[seq.length - 1] !== r.stationShortCode) seq.push(r.stationShortCode);
  }
  if (seq.length < 2) continue;
  const chain = routeLegs(seq, net);
  const [lon, lat] = p.location.coordinates;
  const r = projectToRoute(lon, lat, chain, net);
  ok(r.s >= 0 && r.s <= routeLength(chain) + 1, `train ${p.trainNumber} s out of range`);
  if (r.err < 5000) projected++;
  else far.push(`${p.trainNumber}:${(r.err / 1000).toFixed(0)}km`);
}
console.log(`live trains projected <5km: ${projected}/${positions.length}`, far.length ? 'far: ' + far.join(',') : '');
ok(projected >= positions.length * 0.6, 'under 60% of live trains snapped near their route');

// 3. positions advance along the route
{
  const t = trainByNum.get(5);
  const seq = [];
  for (const r of t.timeTableRows) {
    if (!r.trainStopping || !r.commercialStop) continue;
    if (seq[seq.length - 1] !== r.stationShortCode) seq.push(r.stationShortCode);
  }
  const chain = routeLegs(seq, net);
  const p0 = positionAt(chain, 0);
  const hki = net.stations.get('HKI');
  ok(Math.hypot(p0.x - hki.x, p0.y - hki.y) < 1000, 's=0 is not at Helsinki');
  const p1 = positionAt(chain, 50000);
  const p2 = positionAt(chain, 100000);
  ok(p1.x !== p2.x || p1.y !== p2.y, 'position does not advance');
  const ns = nextStop(chain, seq, 50000);
  ok(ns && seq.includes(ns.station), 'nextStop not on route');
}

// 4. mover eases and advances
{
  const m = makeMover();
  const t0 = 1000000;
  m.set(1000, 100, t0);
  const s1 = m.tick(t0 + 10000); // 10s at 100km/h ≈ +278m
  ok(s1 > 1200 && s1 < 1400, `mover advanced ${s1 - 1000}m, expected ~278`);
  m.set(50000, 0, t0 + 10000); // teleport correction
  ok(Math.abs(m.s - 50000) < 1, 'mover did not snap on teleport');
}

// 5. sun altitude sanity: Helsinki winter noon vs midnight
{
  const noon = new Date(Date.UTC(2026, 9, 13, 10, 0)); // ~13:00 EEST
  const night = new Date(Date.UTC(2026, 9, 13, 22, 0));
  const a1 = sunAltitude(noon, 60.17, 24.94), a2 = sunAltitude(night, 60.17, 24.94);
  ok(a1 > 0.1 && a1 < 0.6, `noon altitude ${a1}`);
  ok(a2 < 0, `midnight altitude ${a2}`);
}

// 6. weather kinds
ok(weatherKind(73) === 'snow' && weatherKind(61) === 'rain' && weatherKind(0) === 'clear', 'weatherKind mapping');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
