#!/usr/bin/env node
// Build terrain.json: Finland outline + big lakes, projected to layout coords.
// Input:  data/raw/ne_countries.geojson, data/raw/ne_lakes.geojson
// Output: public/terrain.json
import { readFileSync, writeFileSync } from 'node:fs';

const LAT0 = 63.5;
const KX = 111320 * Math.cos((LAT0 * Math.PI) / 180);
const KY = 110540;
const project = (lon, lat) => [lon * KX, -lat * KY];

const countries = JSON.parse(readFileSync('data/raw/ne_countries.geojson', 'utf8'));
const lakes = JSON.parse(readFileSync('data/raw/ne_lakes.geojson', 'utf8'));

const finland = countries.features.find(f =>
  f.properties.ADMIN === 'Finland' || f.properties.NAME === 'Finland');
if (!finland) throw new Error('Finland not found');

// Douglas-Peucker simplify (in degrees ~0.02 ≈ 1.4km).
// Closed rings (first == last) get a degenerate baseline, so split them at the
// point farthest from the anchor and simplify the two open chains.
function simplifyOpen(keep, ring, i, j, tol) {
  const stack = [[i, j]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [x1, y1] = ring[a], [x2, y2] = ring[b];
    const dx = x2 - x1, dy = y2 - y1, L = Math.hypot(dx, dy) || 1;
    let dmax = 0, idx = -1;
    for (let k = a + 1; k < b; k++) {
      const [x, y] = ring[k];
      const d = Math.abs((x - x1) * dy - (y - y1) * dx) / L;
      if (d > dmax) { dmax = d; idx = k; }
    }
    if (dmax > tol && idx > 0) { keep[idx] = true; stack.push([a, idx], [idx, b]); }
  }
}
function simplify(ring, tol = 0.02) {
  if (ring.length < 4) return ring;
  const keep = new Array(ring.length).fill(false);
  keep[0] = keep[ring.length - 1] = true;
  let far = 0, dmax = 0;
  const [x0, y0] = ring[0];
  for (let k = 1; k < ring.length; k++) {
    const d = Math.hypot(ring[k][0] - x0, ring[k][1] - y0);
    if (d > dmax) { dmax = d; far = k; }
  }
  keep[far] = true;
  simplifyOpen(keep, ring, 0, far, tol);
  simplifyOpen(keep, ring, far, ring.length - 1, tol);
  return ring.filter((_, i) => keep[i]);
}

const pointInPoly = (x, y, ring) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};

const polys = (geom) => geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;

// Finland outline (all parts incl. Åland), largest first
const land = polys(finland.geometry)
  .map(p => ({ rings: p, area: p[0].length }))
  .sort((a, b) => b.area - a.area)
  .map(({ rings }) => rings.map(r => simplify(r, 0.015).map(([lo, la]) => {
    const [x, y] = project(lo, la);
    return [Math.round(x), Math.round(y)];
  })));

const mainRing = finland.geometry.type === 'Polygon'
  ? finland.geometry.coordinates[0]
  : finland.geometry.coordinates.sort((a, b) => b[0].length - a[0].length)[0][0];

// Lakes whose centroid sits inside mainland Finland
const lakePolys = [];
for (const f of lakes.features) {
  for (const p of polys(f.geometry)) {
    const ring = p[0];
    const cx = ring.reduce((s, c) => s + c[0], 0) / ring.length;
    const cy = ring.reduce((s, c) => s + c[1], 0) / ring.length;
    if (!pointInPoly(cx, cy, mainRing)) continue;
    lakePolys.push(rings_project(p));
  }
}
function rings_project(p) {
  return p.map(r => simplify(r, 0.01).map(([lo, la]) => {
    const [x, y] = project(lo, la);
    return [Math.round(x), Math.round(y)];
  }));
}

writeFileSync('public/terrain.json', JSON.stringify({ land, lakes: lakePolys }));
console.log(`land parts: ${land.length}, lakes: ${lakePolys.length}, size: ${(JSON.stringify({ land, lakes: lakePolys }).length / 1024).toFixed(0)}KB`);
