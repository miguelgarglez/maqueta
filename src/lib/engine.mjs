// The railway engine: leg geometry, route projection, train interpolation.
// Plain JS + JSDoc so the browser, the Worker, and node tests all share it.

/** @typedef {{a:string,b:string,pts:number[][],len:number,uses?:number}} Leg */
/** @typedef {{code:string,name:string,x:number,y:number,pax:boolean}} Station */

export function pairKey(a, b) { return a < b ? `${a}|${b}` : `${b}|${a}`; }

/** Flatten a leg's bezier-ish control points into a polyline with cumulative lengths. */
export function legPolyline(leg, subdiv = 24) {
  const pts = leg.pts;
  const out = [];
  if (pts.length === 3) {
    // quadratic bezier
    for (let i = 0; i <= subdiv; i++) {
      const t = i / subdiv, u = 1 - t;
      out.push([
        u * u * pts[0][0] + 2 * u * t * pts[1][0] + t * t * pts[2][0],
        u * u * pts[0][1] + 2 * u * t * pts[1][1] + t * t * pts[2][1],
      ]);
    }
  } else out.push(...pts);
  const cum = [0];
  for (let i = 1; i < out.length; i++)
    cum.push(cum[i - 1] + Math.hypot(out[i][0] - out[i - 1][0], out[i][1] - out[i - 1][1]));
  return { pts: out, cum, len: cum[cum.length - 1] };
}

export function loadNetwork(json) {
  const stations = new Map(json.stations.map(s => [s.code, s]));
  const pairToLeg = new Map();
  const legs = json.legs.map((leg, i) => {
    const poly = legPolyline(leg);
    pairToLeg.set(pairKey(leg.a, leg.b), i);
    return { ...leg, poly };
  });
  return { stations, legs, pairToLeg, bounds: json.bounds, kx: json.kx, ky: json.ky };
}

/** The chain of legs a train follows, in route order. */
export function routeLegs(stopCodes, net) {
  const out = [];
  for (let i = 0; i + 1 < stopCodes.length; i++) {
    const idx = net.pairToLeg.get(pairKey(stopCodes[i], stopCodes[i + 1]));
    if (idx !== undefined) out.push({ idx: net.legs[idx], from: stopCodes[i], to: stopCodes[i + 1] });
    // missing leg (route uses a station pair today's dump didn't build): fall back to a straight chord
    else {
      const A = net.stations.get(stopCodes[i]), B = net.stations.get(stopCodes[i + 1]);
      if (A && B) {
        const pts = [[A.x, A.y], [B.x, B.y]];
        const cum = [0, Math.hypot(B.x - A.x, B.y - A.y)];
        out.push({ idx: { a: A.code, b: B.code, pts, len: cum[1], poly: { pts, cum, len: cum[1] } }, from: A.code, to: B.code });
      }
    }
  }
  return out;
}

/** Distance along a leg polyline nearest to point p, and the squared error. */
function projectOnPoly(p, poly) {
  let best = { d2: Infinity, s: 0 };
  for (let i = 0; i + 1 < poly.pts.length; i++) {
    const [ax, ay] = poly.pts[i], [bx, by] = poly.pts[i + 1];
    const dx = bx - ax, dy = by - ay;
    const L2 = dx * dx + dy * dy || 1;
    let t = ((p[0] - ax) * dx + (p[1] - ay) * dy) / L2;
    t = Math.max(0, Math.min(1, t));
    const qx = ax + dx * t, qy = ay + dy * t;
    const d2 = (p[0] - qx) ** 2 + (p[1] - qy) ** 2;
    if (d2 < best.d2) best = { d2, s: poly.cum[i] + Math.sqrt(L2) * t };
  }
  return best;
}

/** Total route length in meters. */
export function routeLength(chain) {
  return chain.reduce((s, c) => s + c.idx.poly.len, 0);
}

/** Project a lon/lat point onto the train's own route chain. Returns {s, err} meters. */
export function projectToRoute(lon, lat, chain, net) {
  const p = [lon * net.kx, -lat * net.ky];
  let best = { s: 0, err2: Infinity };
  let acc = 0;
  for (const c of chain) {
    const leg = c.idx.poly;
    const r = projectOnPoly(p, leg);
    if (r.d2 < best.err2) best = { s: acc + r.s, err2: r.d2 };
    acc += leg.len;
  }
  return { s: best.s, err: Math.sqrt(best.err2) };
}

/** Position (x,y) and heading (radians) at distance s along the chain. */
export function positionAt(chain, s) {
  for (const c of chain) {
    const leg = c.idx.poly;
    if (s <= leg.len || c === chain[chain.length - 1]) {
      let i = 0;
      while (i + 1 < leg.cum.length && leg.cum[i + 1] < s) i++;
      i = Math.min(i, leg.pts.length - 2);
      const segLen = leg.cum[i + 1] - leg.cum[i] || 1;
      const f = (s - leg.cum[i]) / segLen;
      const [ax, ay] = leg.pts[i], [bx, by] = leg.pts[i + 1];
      return {
        x: ax + (bx - ax) * Math.max(0, Math.min(1, f)),
        y: ay + (by - ay) * Math.max(0, Math.min(1, f)),
        angle: Math.atan2(by - ay, bx - ax),
        leg: c,
      };
    }
    s -= leg.len;
  }
  const last = chain[chain.length - 1].idx.poly;
  const p = last.pts[last.pts.length - 1], q = last.pts[last.pts.length - 2];
  return { x: p[0], y: p[1], angle: Math.atan2(p[1] - q[1], p[0] - q[0]), leg: chain[chain.length - 1] };
}

/** The next commercial stop ahead of distance s, or null. */
export function nextStop(chain, stops, s) {
  let acc = 0;
  for (let i = 0; i < chain.length; i++) {
    acc += chain[i].idx.poly.len;
    if (acc > s + 50 && chain[i].to) {
      return { station: chain[i].to, sRemain: acc - s, stopIndex: i + 1 };
    }
  }
  return null;
}

/**
 * Advance a train's route-distance between polls.
 * Blends toward the server's projected position to correct drift.
 */
export function makeMover() {
  return {
    s: 0, speed: 0, updatedAt: 0,
    set(s, speedKmh, nowMs) {
      // if we have no prior state or teleport, snap; else ease toward truth
      const drift = Math.abs(this.s - s);
      if (!this.updatedAt || drift > 4000) this.s = s;
      else this.s = this.s * 0.35 + s * 0.65;
      this.speed = speedKmh;
      this.updatedAt = nowMs;
    },
    /** Snap exactly (used after a large correction). */
    tick(nowMs) {
      if (!this.updatedAt) return this.s;
      const dt = Math.min((nowMs - this.updatedAt) / 1000, 120);
      return this.s + (this.speed / 3.6) * dt;
    },
  };
}

/** Solar altitude (radians) for a lat/lon at a Date — compact NOAA approximation. */
export function sunAltitude(date, lat, lon) {
  const rad = Math.PI / 180;
  const start = new Date(Date.UTC(date.getUTCFullYear(), 0, 0));
  const doy = (date.getTime() - start.getTime()) / 864e5;
  const decl = -23.44 * Math.cos(((360 / 365) * (doy + 10)) * rad) * rad;
  const utcH = date.getUTCHours() + date.getUTCMinutes() / 60;
  const ha = (15 * (utcH + lon / 15 - 12)) * rad;
  const phi = lat * rad;
  return Math.asin(Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(ha));
}

/** Map an Open-Meteo weather code to a small scene enum. */
export function weatherKind(code) {
  if ([71, 73, 75, 77, 85, 86].includes(code)) return 'snow';
  if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99].includes(code)) return 'rain';
  if ([45, 48].includes(code)) return 'fog';
  if (code >= 2) return 'cloud';
  return 'clear';
}
