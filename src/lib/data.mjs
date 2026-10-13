// Live data: worker snapshot + WS, per-train movers, regional weather lookup.
import { routeLegs, projectToRoute, makeMover } from './engine.mjs';

export const WORKER =
  location.hostname === 'localhost'
    ? 'https://maqueta.miguel-garglez.workers.dev'
    : `${location.origin.replace(/^https?/, 'https').replace('maqueta.vercel.app', 'maqueta.miguel-garglez.workers.dev')}`;

export const WX_CENTERS = [
  [60.17, 24.94], [60.45, 22.27], [61.5, 23.76], [61.87, 28.19], [62.78, 26.9],
  [62.24, 25.75], [64.22, 27.7], [65.01, 25.47], [66.5, 25.7], [68.9, 27.0],
];

export function makeStore(net) {
  const trains = new Map();
  let weather = [];
  let lastNow = 0;
  let live = false;

  function applySnapshot(s) {
    lastNow = s.now;
    const seen = new Set();
    for (const t of s.trains) {
      seen.add(t.n);
      let tv = trains.get(t.n);
      if (!tv || tv.dep !== t.dep) {
        tv = {
          n: t.n, ty: t.ty, ln: t.ln, dep: t.dep,
          chain: routeLegs(t.rt, net), mover: makeMover(),
          dl: 0, ns: null, sp: 0, born: s.now,
        };
        trains.set(t.n, tv);
      }
      const r = projectToRoute(t.x, t.y, tv.chain, net);
      if (r.err < 6000) tv.mover.set(r.s, t.sp, s.now);
      tv.dl = t.dl; tv.ns = t.ns; tv.sp = t.sp;
    }
    for (const n of trains.keys()) if (!seen.has(n)) trains.delete(n);
    if (s.weather?.length) weather = s.weather;
  }

  /** Nearest weather region for a layout-space point (already projected lon*kx, -lat*ky). */
  function regionAt(x, y) {
    let best = 0, bd = Infinity;
    for (let i = 0; i < WX_CENTERS.length; i++) {
      const cx = WX_CENTERS[i][1] * net.kx, cy = -WX_CENTERS[i][0] * net.ky;
      const d = (x - cx) ** 2 + (y - cy) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    return weather[best] || null;
  }

  return { trains, applySnapshot, regionAt, get live() { return live; }, set live(v) { live = v; } };
}

export async function connect(store, onchange) {
  async function poll() {
    try {
      const r = await fetch(`${WORKER}/state`);
      if (r.ok) { store.applySnapshot(await r.json()); store.live = true; onchange?.(); }
    } catch { store.live = false; }
  }
  function ws() {
    const sock = new WebSocket(`${WORKER.replace('https', 'wss')}/ws`);
    sock.onmessage = e => { store.applySnapshot(JSON.parse(e.data)); store.live = true; onchange?.(); };
    sock.onclose = () => { store.live = false; setTimeout(ws, 4000); };
    sock.onerror = () => sock.close();
  }
  await poll();
  ws();
  setInterval(() => { if (!store.live) poll(); }, 15_000);
}
