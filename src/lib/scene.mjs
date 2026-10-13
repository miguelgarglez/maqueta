// The diorama renderer. Canvas 2D, two layers: a cached base (board, terrain,
// track, stations) and the live layer (trains, weather, lamps) per frame.

// ---------- palette ----------
const C = {
  grass: '#a6c48a', meadow: '#b8d19b', forest: '#6e9a67', forestDeep: '#5d8757',
  water: '#7fb6c9', waterDeep: '#6ba8bc', coast: '#8fae7f',
  boardEdge: '#8a6a42', fascia: '#d9b07c', fasciaDark: '#b8895a',
  table: '#9a7a52', tableDark: '#7d6243',
  ballast: '#b7a88f', sleeper: '#6b5f52', rail: '#4a423a',
  platform: '#efe6d2',
  ink: '#2e2a26', lamp: '#ffd98a',
  vrGreen: '#3e7d5b', cream: '#f2ebdc', commuter: '#b5443b', pendolino: '#f4f2ec',
  locoDark: '#2f6247', cargo: '#4a6a8a',
};
const SKY = {
  day:   { top: [188, 212, 224], bot: [222, 232, 224] },
  dusk:  { top: [102, 88, 128],  bot: [214, 158, 122] },
  night: { top: [16, 26, 46],    bot: [32, 44, 66] },
};

function lerp(a, b, t) { return a + (b - a) * t; }
function mixRgb(a, b, t) { return `rgb(${a.map((v, i) => Math.round(lerp(v, b[i], t))).join(',')})`; }
/** 0 = night, 1 = full day, with a dusk band in between. */
export function dayness(sunAlt) {
  return Math.max(0, Math.min(1, (sunAlt + 0.06) / 0.30));
}
export function duskness(sunAlt) {
  const d = dayness(sunAlt);
  return Math.max(0, 1 - Math.abs(d - 0.45) / 0.45); // peaks mid-dusk
}

// deterministic pseudo-random
export function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

const ptInRing = (x, y, ring) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};

export function pointInLand(x, y, terrain) {
  // land is array of parts; part = array of rings; first ring = outer
  return terrain.land.some(part => ptInRing(x, y, part[0]) && !part.slice(1).some(h => ptInRing(x, y, h)));
}

// ---------- forest & town sprites, built once ----------
export function buildDecor(terrain, net) {
  const r = rng(20261013);
  const b = net.bounds;
  const forests = [], towns = [], trees = [];
  // forest blobs inside land — fewer, softer, clustered
  for (let i = 0; i < 300; i++) {
    const x = b.minX + r() * (b.maxX - b.minX);
    const y = b.minY + r() * (b.maxY - b.minY);
    if (!pointInLand(x, y, terrain)) continue;
    const s = 5000 + r() * 14000;
    forests.push({ x, y, s, rot: r() * 6.28, pts: blobPoints(r, 7 + (r() * 4 | 0), s) });
  }
  // tiny conifers along forest edges & scattered
  for (let i = 0; i < 900; i++) {
    const x = b.minX + r() * (b.maxX - b.minX);
    const y = b.minY + r() * (b.maxY - b.minY);
    if (!pointInLand(x, y, terrain)) continue;
    trees.push({ x, y, s: 900 + r() * 1400, w: r() });
  }
  // town clusters at the biggest stations
  const big = [...net.stations.values()].filter(s => s.pax);
  for (const s of big) {
    const n = 4 + (r() * 5 | 0);
    const houses = [];
    for (let i = 0; i < n; i++) {
      const a = r() * 6.28, d = 1500 + r() * 7000;
      houses.push({ x: s.x + Math.cos(a) * d, y: s.y + Math.sin(a) * d, w: 900 + r() * 1600, h: 700 + r() * 1100, rot: (r() - 0.5) * 0.7 });
    }
    towns.push({ code: s.code, houses });
  }
  return { forests, trees, towns };
}
function blobPoints(r, n, s) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const d = s * (0.55 + r() * 0.45);
    pts.push([Math.cos(a) * d, Math.sin(a) * d]);
  }
  return pts;
}

// ---------- camera ----------
export function makeCam(canvas, net) {
  const b = net.bounds;
  const cam = {
    cx: (b.minX + b.maxX) / 2, cy: (b.minY + b.maxY) / 2,
    scale: 1, squash: 0.80, min: 0.0004, max: 0.03,
    follow: null, // {x,y} target when chasing
  };
  cam.fit = () => {
    cam.scale = Math.min(
      canvas.width / (b.maxX - b.minX + 120_000),
      canvas.height / ((b.maxY - b.minY) * cam.squash + 150_000),
    );
    cam.min = cam.scale * 0.55;
  };
  cam.toPx = (x, y) => [
    canvas.width / 2 + (x - cam.cx) * cam.scale,
    canvas.height / 2 - (y - cam.cy) * cam.scale * cam.squash,
  ];
  cam.toWorld = (px, py) => [
    cam.cx + (px - canvas.width / 2) / cam.scale,
    cam.cy - (py - canvas.height / 2) / (cam.scale * cam.squash),
  ];
  cam.fit();
  return cam;
}

// ---------- base layer ----------
export function makeScene(canvas, net, terrain, decor) {
  const base = document.createElement('canvas');
  const bctx = base.getContext('2d');
  let baseKey = '';
  const labels = [];

  function paintBase(cam, sunAlt) {
    const day = dayness(sunAlt), dusk = duskness(sunAlt);
    const w = canvas.width, h = canvas.height;
    const key = [w, h, cam.cx.toFixed(0), cam.cy.toFixed(0), cam.scale.toPrecision(6), Math.round(day * 40), Math.round(dusk * 40)].join('|');
    if (key === baseKey) return;
    baseKey = key;
    if (base.width !== w || base.height !== h) { base.width = w; base.height = h; }
    const c = bctx;
    c.setTransform(1, 0, 0, 1, 0, 0);

    // the room: wall above, tabletop below — the diorama sits on the table
    const horizon = h * 0.62;
    const g = c.createLinearGradient(0, 0, 0, horizon);
    const top = SKY.day.top.map((v, i) => lerp(lerp(SKY.night.top[i], SKY.dusk.top[i], dusk), v, day));
    const bot = SKY.day.bot.map((v, i) => lerp(lerp(SKY.night.bot[i], SKY.dusk.bot[i], dusk), v, day));
    g.addColorStop(0, mixRgb([0, 0, 0], top, 1));
    g.addColorStop(1, mixRgb([0, 0, 0], bot, 1));
    c.fillStyle = g;
    c.fillRect(0, 0, w, horizon);

    // dusk warmth pooling at the horizon behind the board
    if (dusk > 0.02) {
      const hg = c.createLinearGradient(0, horizon - h * 0.3, 0, horizon);
      hg.addColorStop(0, 'rgba(230,150,90,0)');
      hg.addColorStop(1, `rgba(232,152,92,${(0.34 * dusk).toFixed(3)})`);
      c.fillStyle = hg;
      c.fillRect(0, horizon - h * 0.3, w, h * 0.3);
    }

    // tabletop — warm wood, darker toward the front edge
    const tg = c.createLinearGradient(0, horizon, 0, h);
    tg.addColorStop(0, mixRgb(rgb('#3a2e22'), rgb('#a8825c'), day));
    tg.addColorStop(0.25, mixRgb(rgb('#33281e'), rgb('#96713f'), day));
    tg.addColorStop(1, mixRgb(rgb('#241c14'), rgb('#7d6243'), day));
    c.fillStyle = tg;
    c.fillRect(0, horizon, w, h - horizon);
    // faint grain streaks
    c.strokeStyle = `rgba(60,40,20,${(0.12 * day + 0.03).toFixed(3)})`;
    c.lineWidth = 1;
    for (let y = horizon + 8; y < h; y += 9) {
      c.beginPath(); c.moveTo(0, y + Math.sin(y * 0.7) * 2); c.lineTo(w, y + Math.cos(y * 0.5) * 2); c.stroke();
    }

    // spotlight: the room falls away from the board
    const vg = c.createRadialGradient(w / 2, h * 0.46, Math.min(w, h) * 0.35, w / 2, h * 0.5, Math.max(w, h) * 0.85);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(8, 10, 18, 0.42)');
    c.fillStyle = vg;
    c.fillRect(0, 0, w, h);

    const drawPoly = (ctx2, ring, close = true) => {
      const [x0, y0] = cam.toPx(ring[0][0], ring[0][1]);
      ctx2.moveTo(x0, y0);
      for (let i = 1; i < ring.length; i++) {
        const [x, y] = cam.toPx(ring[i][0], ring[i][1]);
        ctx2.lineTo(x, y);
      }
      if (close) ctx2.closePath();
    };

    // the baseboard: rounded rect holding the layout; sea-blue so Finland's
    // coasts read, with a birch rim and a soft drop shadow onto the room
    const bb = net.bounds;
    const M = 46_000;
    const [bx0, by1] = cam.toPx(bb.minX - M, bb.minY - M);
    const [bx1, by0] = cam.toPx(bb.maxX + M, bb.maxY + M);
    const bw = bx1 - bx0, bh = by1 - by0;
    const rad = Math.min(46, Math.min(bw, bh) * 0.07);

    // cast shadow under the board, skewed as if lit from the upper left
    c.save();
    c.translate(0, by1);
    c.transform(1, 0, -0.14, 0.30, 0, 0);
    c.translate(0, -by1);
    const sh = c.createLinearGradient(0, by1 - 30, 0, by1 + 90);
    sh.addColorStop(0, 'rgba(8, 10, 16, 0.42)');
    sh.addColorStop(1, 'rgba(8, 10, 16, 0)');
    c.fillStyle = sh;
    c.beginPath();
    c.roundRect(bx0 + 14, by0 + bh * 0.06, bw - 6, bh, rad + 4);
    c.fill();
    c.restore();

    // wooden rim (outer) then the sea inside
    c.fillStyle = mixRgb(rgb('#4a3420'), rgb('#9a6f42'), day);
    c.beginPath(); c.roundRect(bx0 - 7, by0 - 7, bw + 14, bh + 14, rad + 5); c.fill();
    const sea = c.createLinearGradient(0, by0, 0, by1);
    sea.addColorStop(0, mixRgb(rgb('#1d3a48'), rgb('#6ba8bc'), day));
    sea.addColorStop(1, mixRgb(rgb('#18303c'), rgb('#5e9db2'), day));
    c.fillStyle = sea;
    c.beginPath(); c.roundRect(bx0, by0, bw, bh, rad); c.fill();

    // clip everything inside the board
    c.save();
    c.beginPath(); c.roundRect(bx0, by0, bw, bh, rad); c.clip();

    // sea texture: faint lat-ish wave bands
    c.strokeStyle = `rgba(255,255,255,${(0.035 * day).toFixed(3)})`;
    c.lineWidth = 1;
    for (let y = by0 + rad; y < by1; y += 34) {
      c.beginPath(); c.moveTo(bx0, y); c.lineTo(bx1, y); c.stroke();
    }

    // land
    c.beginPath();
    for (const part of terrain.land) drawPoly(c, part[0]);
    c.fillStyle = mixRgb(rgb('#42563e'), rgb(C.meadow), day);
    c.fill();

    // sandy shoreline — the painted "beach" edge a model railway has
    c.beginPath();
    for (const part of terrain.land) drawPoly(c, part[0]);
    c.strokeStyle = mixRgb(rgb('#4a4438'), rgb('#e2d3a4'), day);
    c.lineWidth = Math.max(1, 2400 * cam.scale);
    c.stroke();

    // lakes
    c.beginPath();
    for (const lake of terrain.lakes) drawPoly(c, lake[0]);
    c.fillStyle = mixRgb(rgb('#264452'), rgb(C.water), day);
    c.fill();

    // forests — flat blobs, softened at the edges
    const forestCol = mixRgb(rgb('#31473a'), rgb(C.forest), day);
    const treeCol = mixRgb(rgb('#2a3c33'), rgb(C.forestDeep), day);
    c.fillStyle = forestCol;
    c.globalAlpha = 0.88;
    for (const f of decor.forests) {
      const [x, y] = cam.toPx(f.x, f.y);
      const rpx = f.s * cam.scale;
      if (rpx < 0.6) continue;
      c.beginPath();
      for (let i = 0; i < f.pts.length; i++) {
        const px = x + f.pts[i][0] * cam.scale, py = y - f.pts[i][1] * cam.scale * cam.squash;
        i ? c.lineTo(px, py) : c.moveTo(px, py);
      }
      c.closePath(); c.fill();
    }
    c.globalAlpha = 1;

    // track — sleepers (dashed wide), ballast, rail
    const track = (width, color, dash) => {
      c.beginPath();
      for (const leg of net.legs) {
        const [x0, y0] = cam.toPx(leg.poly.pts[0][0], leg.poly.pts[0][1]);
        c.moveTo(x0, y0);
        for (let i = 1; i < leg.poly.pts.length; i++) {
          const [x, y] = cam.toPx(leg.poly.pts[i][0], leg.poly.pts[i][1]);
          c.lineTo(x, y);
        }
      }
      c.lineWidth = Math.max(0.4, width * cam.scale);
      c.strokeStyle = color;
      c.lineCap = 'round'; c.lineJoin = 'round';
      c.setLineDash(dash || []);
      c.stroke();
      c.setLineDash([]);
    };
    const dk = mixRgb(rgb('#2c2620'), rgb(C.sleeper), day);
    const bl = mixRgb(rgb('#57503f'), rgb(C.ballast), day);
    const rl = mixRgb(rgb('#d9d2c4'), rgb(C.rail), day);
    if (cam.scale > 0.0022) track(1900, dk, [2.2, 5.5]);  // sleeper texture when close
    track(2000, bl);                                        // ballast bed — exaggerated like the stock
    track(700, rl);                                         // rail line

    // towns — tiny block clusters
    const house = mixRgb(rgb('#3a3f38'), rgb('#e8dcc4'), day);
    const roof = mixRgb(rgb('#33302c'), rgb('#b5443b'), day);
    for (const t of decor.towns) {
      for (const hh of t.houses) {
        const [x, y] = cam.toPx(hh.x, hh.y);
        const wpx = hh.w * cam.scale, hpx = hh.h * cam.scale * cam.squash;
        if (wpx < 1) continue;
        c.save();
        c.translate(x, y); c.rotate(hh.rot * 0.3);
        c.fillStyle = house;
        c.fillRect(-wpx / 2, -hpx / 2, wpx, hpx);
        c.fillStyle = roof;
        c.fillRect(-wpx / 2, -hpx / 2, wpx, hpx * 0.35);
        c.restore();
      }
    }

    // conifer trees — little triangles
    if (cam.scale > 0.0011) {
      c.fillStyle = treeCol;
      for (const t of decor.trees) {
        const [x, y] = cam.toPx(t.x, t.y);
        const s = t.s * cam.scale;
        if (s < 1.4) continue;
        c.beginPath();
        c.moveTo(x, y - s);
        c.lineTo(x + s * 0.62, y);
        c.lineTo(x - s * 0.62, y);
        c.closePath(); c.fill();
      }
    }

    // stations — platform slabs in the base; labels are deferred to
    // scene.labels so the live layer can draw them *above* the trains
    const lab = cam.scale > 0.0016;
    const psl = Math.max(1.6, 700 * cam.scale);
    const placed = [];
    const minGap = 64;
    labels.length = 0;
    c.fillStyle = mixRgb(rgb('#5a5548'), rgb(C.platform), day);
    for (const s of net.stations.values()) {
      const [x, y] = cam.toPx(s.x, s.y);
      if (!s.pax && cam.scale < 0.004) continue;
      c.beginPath();
      c.roundRect(x - psl, y - psl * 0.45, psl * 2, psl * 0.9, psl * 0.4);
      c.fill();
      if (lab && s.pax) {
        const fs = Math.max(9, 3400 * cam.scale);
        const wEst = s.name.length * fs * 0.52;
        let clash = false;
        for (const [qx, qy] of placed) {
          if (Math.abs(x - qx) < wEst + minGap * 0.5 && Math.abs(y - qy) < fs * 1.7) { clash = true; break; }
        }
        if (!clash) {
          labels.push({ x: x + psl * 1.6, y: y + fs * 0.35, fs, name: s.name });
          placed.push([x, y]);
        }
      }
    }
    c.restore(); // board clip
  }

  function rgb(hex) {
    return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
  }

  return { base, bctx, paintBase, labels };
}

// ---------- weather ----------
export function makeWeather(store, net) {
  const r = rng(777);
  const parts = [];
  for (let i = 0; i < 1400; i++) {
    const c = WX_REGIONS[i % WX_REGIONS.length];
    const a = r() * 6.28, d = Math.sqrt(r()) * c.rad;
    parts.push({
      x: c.x + Math.cos(a) * d, y: c.y + Math.sin(a) * d,
      vx: 0, seed: r() * 1000,
    });
  }
  function draw(ctx, cam, now) {
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      const w = store.regionAt(p.x, p.y);
      if (!w || (w.k !== 'snow' && w.k !== 'rain')) continue;
      const [x0, y0] = cam.toPx(p.x, p.y);
      const t = now / 1000 + p.seed;
      if (w.k === 'snow') {
        const x = x0 + Math.sin(t * 0.7) * 14, y = y0 + ((t * 18) % 200) - 100;
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.beginPath(); ctx.arc(x, y, 1.6, 0, 7); ctx.fill();
      } else {
        const x = x0 + Math.sin(t * 0.4) * 4, y = y0 + ((t * 160) % 220) - 110;
        ctx.strokeStyle = 'rgba(180,200,220,0.6)';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - 2, y + 9); ctx.stroke();
      }
    }
    // fog regions
    // (drawn as faint bands; cheap and soft)
  }
  return { draw };
}

// region circles in layout coords (lon*kx, -lat*ky)
import { WX_CENTERS } from './data.mjs';
export function wxRegions(net) {
  return WX_CENTERS.map(([la, lo]) => ({ x: lo * net.kx, y: -la * net.ky, rad: 130_000 }));
}
let WX_REGIONS = [];
export function initWx(net) { WX_REGIONS = wxRegions(net); }
