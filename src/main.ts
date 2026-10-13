// maqueta — a living model railway of Finland.
// Canvas diorama: real Digitraffic telemetry on a compressed layout,
// sun and weather shared with the actual country.
import { loadNetwork, sunAltitude, positionAt } from './lib/engine.mjs';
import { makeStore, connect, WORKER } from './lib/data.mjs';
import { makeCam, makeScene, buildDecor, initWx, makeWeather, dayness, duskness } from './lib/scene.mjs';

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;

const [net, terrain] = await Promise.all([
  fetch('/network.json').then(r => r.json()).then(loadNetwork),
  fetch('/terrain.json').then(r => r.json()),
]);
const decor = buildDecor(terrain, net);
const store = makeStore(net);
const cam = makeCam(canvas, net);
const scene = makeScene(canvas, net, terrain, decor);
initWx(net);
const weather = makeWeather(store, net);

const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const HELSINKI = [60.17, 24.94];

connect(store);

// ---------- resize / camera ----------
function resize() {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = innerWidth * dpr;
  canvas.height = innerHeight * dpr;
  cam.fit();
}
addEventListener('resize', resize);
resize();

// ---------- interaction ----------
let dragging = false, moved = 0, lx = 0, ly = 0;
let vx = 0, vy = 0; // pan velocity for inertia (css px/frame)

function clampCam() {
  const b = net.bounds, M = 130_000;
  cam.cx = Math.max(b.minX - M, Math.min(b.maxX + M, cam.cx));
  cam.cy = Math.max(b.minY - M, Math.min(b.maxY + M, cam.cy));
}

const pointers = new Map<number, [number, number]>();
let pinchD = 0;
canvas.addEventListener('pointerdown', e => {
  pointers.set(e.pointerId, [e.clientX, e.clientY]);
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinchD = Math.hypot(a[0] - b[0], a[1] - b[1]);
    dragging = false;
    return;
  }
  dragging = true; moved = 0; lx = e.clientX; ly = e.clientY;
  vx = vy = 0;
  cam.follow = null; updateFollowBtn();
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', e => {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, [e.clientX, e.clientY]);
  const dpr = Math.min(devicePixelRatio || 1, 2);
  if (pointers.size === 2) {
    // pinch: scale around the midpoint
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
    if (pinchD > 0 && d > 0) {
      const mx = ((a[0] + b[0]) / 2) * dpr, my = ((a[1] + b[1]) / 2) * dpr;
      const before = cam.toWorld(mx, my);
      cam.scale = Math.max(cam.min, Math.min(cam.max, cam.scale * (d / pinchD)));
      const after = cam.toWorld(mx, my);
      cam.cx += before[0] - after[0];
      cam.cy += before[1] - after[1];
      clampCam();
    }
    pinchD = d;
    return;
  }
  if (!dragging) return;
  const dx = (e.clientX - lx) * dpr, dy = (e.clientY - ly) * dpr;
  moved += Math.abs(dx) + Math.abs(dy);
  cam.cx -= dx / cam.scale;
  cam.cy += dy / (cam.scale * cam.squash);
  vx = dx; vy = dy;
  clampCam();
  lx = e.clientX; ly = e.clientY;
});
function endPointer(e: PointerEvent) {
  pointers.delete(e.pointerId);
  pinchD = 0;
  if (pointers.size === 1) {
    // resume single-finger drag without a jump
    const [r] = [...pointers.values()];
    lx = r[0]; ly = r[1]; dragging = true; moved = 99;
  } else if (pointers.size === 0 && dragging) {
    dragging = false;
    if (moved < 8) pick(e.clientX, e.clientY);
  }
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('wheel', e => {
  e.preventDefault();
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const before = cam.toWorld(e.clientX * dpr, e.clientY * dpr);
  cam.scale = Math.max(cam.min, Math.min(cam.max, cam.scale * Math.exp(-e.deltaY * 0.001)));
  const after = cam.toWorld(e.clientX * dpr, e.clientY * dpr);
  cam.cx += before[0] - after[0];
  cam.cy += before[1] - after[1];
  clampCam();
}, { passive: false });

// ---------- picking + inspector ----------
interface Sel { tv: any }
let sel: Sel | null = null;
const inspector = document.getElementById('inspector')!;
const inspBody = document.getElementById('insp-body')!;
const inspTitle = document.getElementById('insp-title')!;
const inspSub = document.getElementById('insp-sub')!;

function pick(cx: number, cy: number) {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const now = performance.now();
  let best: any = null, bd = 18 * dpr;
  for (const tv of store.trains.values()) {
    if (!tv.chain.length) continue;
    const s = tv.mover.tick(now);
    const p = positionAt(tv.chain, s);
    const [x, y] = cam.toPx(p.x, p.y);
    const d = Math.hypot(x - cx * dpr, y - cy * dpr);
    if (d < bd) { bd = d; best = tv; }
  }
  if (best) select(best);
  else unselect();
}

async function select(tv: any) {
  if (!tv.chain.length) return;
  sel = { tv };
  inspector.classList.add('open');
  inspector.setAttribute('aria-hidden', 'false');
  const stName = (code: string) => net.stations.get(code)?.name ?? code;
  inspTitle.textContent = `${tv.ty}${tv.ln ? ' ' + tv.ln : ''} ${tv.n}`;
  inspSub.textContent = tv.chain.length
    ? `${stName(tv.chain[0].from)} → ${stName(tv.chain[tv.chain.length - 1].to)}`
    : '';
  renderInspBody(tv);
  // consist detail
  fetch(`${WORKER}/consist/${tv.n}?date=${tv.dep}`).then(r => r.ok ? r.json() : null).then(c => {
    if (sel?.tv === tv && c?.ok) renderInspBody(tv, c);
  }).catch(() => {});
}

function renderInspBody(tv: any, consist?: any) {
  const stName = (code: string) => net.stations.get(code)?.name ?? code;
  const late = tv.dl ?? 0;
  const lateTxt = late >= 1
    ? `<b class="late">${Math.round(late)} min late</b>`
    : '<b class="ontime">on time</b>';
  let html = `<div class="row"><span>status</span>${tv.sp > 2 ? `running · ${Math.round(tv.sp)} km/h` : 'standing'} · ${lateTxt}</div>`;
  if (tv.ns) html += `<div class="row"><span>next</span>${stName(tv.ns.st)}${tv.ns.dl ? ` · ${Math.round(tv.ns.dl)} min late` : ''}</div>`;
  if (consist?.wagons?.length) {
    html += `<div class="wagons">${consist.wagons.map((w: any, i: number) =>
      `<div class="wagon${w.loco ? ' loco' : ''}" title="${w.type}${w.power ? ' · ' + w.power : ''}">${w.loco ? '◮' : ''}<i>${w.type}</i></div>`).join('')}</div>`;
  }
  const stops = [stName(tv.chain[0].from), ...tv.chain.map((c: any) => stName(c.to))];
  const chips = stops.length > 4
    ? [stops[0], stops[1], `+${stops.length - 3} stops`, stops[stops.length - 1]]
    : stops;
  html += `<div class="row"><span>route</span><span class="routeline">${chips.map(s => `<em>${s}</em>`).join('<b>→</b>')}</span></div>`;
  inspBody.innerHTML = html;
}

function unselect() {
  sel = null;
  inspector.classList.remove('open');
  inspector.setAttribute('aria-hidden', 'true');
}
document.getElementById('insp-close')!.addEventListener('click', unselect);
addEventListener('keydown', e => { if (e.key === 'Escape') unselect(); });

// ---------- fascia ----------
const countEl = document.getElementById('count')!;
const lateEl = document.getElementById('lateboard')!;
const lampEl = document.getElementById('lamp')!;
const coffeeEl = document.getElementById('coffee')!;

// brass clock — real sweeping hands
const hh = document.getElementById('hh') as unknown as SVGGElement;
const mh = document.getElementById('mh') as unknown as SVGGElement;
const sh = document.getElementById('sh') as unknown as SVGGElement;
function tickClock() {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Helsinki' }));
  const s = d.getSeconds() + d.getMilliseconds() / 1000;
  const m = d.getMinutes() + s / 60;
  const h = (d.getHours() % 12) + m / 60;
  sh.setAttribute('transform', `rotate(${s * 6} 16 16)`);
  mh.setAttribute('transform', `rotate(${m * 6} 16 16)`);
  hh.setAttribute('transform', `rotate(${h * 30} 16 16)`);
}
tickClock();
const clockTimer = reduced ? setInterval(tickClock, 1000) : 0;
if (!reduced) (function spin() { tickClock(); requestAnimationFrame(spin); })();
void clockTimer;

let lastLive = -18_000; // grace period on boot before the "offline" state shows

const followBtn = document.getElementById('btn-follow')!;
function updateFollowBtn() {
  followBtn.classList.toggle('on', !!cam.follow);
  followBtn.setAttribute('aria-pressed', cam.follow ? 'true' : 'false');
}
followBtn.addEventListener('click', () => {
  if (cam.follow) { cam.follow = null; }
  else if (sel) { cam.follow = sel.tv; }
  else {
    // follow the most delayed train
    let best: any = null;
    for (const tv of store.trains.values()) {
      if (!tv.chain.length) continue;
      if (!best || tv.dl > best.dl) best = tv;
    }
    if (best) { select(best); cam.follow = best; }
  }
  updateFollowBtn();
});

const lateBtn = document.getElementById('btn-late')!;
lateBtn.addEventListener('click', () => {
  let best: any = null;
  for (const tv of store.trains.values()) {
    if (!tv.chain.length) continue;
    if (tv.dl > (best?.dl ?? 0)) best = tv;
  }
  if (best && best.dl >= 1) { select(best); cam.follow = best; updateFollowBtn(); }
});

const soundBtn = document.getElementById('btn-sound')!;
let soundOn = false;
let audio: AudioContext | null = null;
let soundGain: GainNode | null = null;
function startAudio() {
  audio = new AudioContext();
  const ac = audio;
  soundGain = ac.createGain();
  soundGain.gain.value = 0;
  soundGain.connect(ac.destination);
  // room tone: brown noise, low-passed — the hum of a layout room
  const len = ac.sampleRate * 4;
  const buf = ac.createBuffer(1, len, ac.sampleRate);
  const d = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < len; i++) {
    const white = Math.random() * 2 - 1;
    last = (last + 0.02 * white) / 1.02;
    d[i] = last * 3.2;
  }
  const src = ac.createBufferSource();
  src.buffer = buf; src.loop = true;
  const lp = ac.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = 320;
  src.connect(lp).connect(soundGain);
  src.start();
  // slow breathing on the hum
  const lfo = ac.createOscillator();
  lfo.frequency.value = 0.11;
  const lfoG = ac.createGain();
  lfoG.gain.value = 0.008;
  lfo.connect(lfoG).connect(soundGain.gain);
  lfo.start();
  soundGain.gain.setTargetAtTime(0.05, ac.currentTime, 1.5);
}
soundBtn.addEventListener('click', () => {
  soundOn = !soundOn;
  soundBtn.classList.toggle('on', soundOn);
  soundBtn.setAttribute('aria-pressed', soundOn ? 'true' : 'false');
  if (soundOn) {
    if (!audio) startAudio();
    else { audio!.resume(); soundGain!.gain.setTargetAtTime(0.05, audio!.currentTime, 0.8); }
  } else if (audio) {
    soundGain!.gain.setTargetAtTime(0, audio.currentTime, 0.4);
  }
});

// about panel
const about = document.getElementById('about')!;
document.getElementById('btn-about')!.addEventListener('click', () => {
  about.classList.toggle('open');
  about.setAttribute('aria-hidden', about.classList.contains('open') ? 'false' : 'true');
});
document.getElementById('about-close')!.addEventListener('click', () => {
  about.classList.remove('open');
  about.setAttribute('aria-hidden', 'true');
});

// ---------- frame ----------
function draw(now: number) {
  // inertia after a flick
  if (!dragging && !cam.follow && (Math.abs(vx) > 0.1 || Math.abs(vy) > 0.1)) {
    cam.cx -= vx / cam.scale;
    cam.cy += vy / (cam.scale * cam.squash);
    vx *= 0.92; vy *= 0.92;
    clampCam();
  }

  // follow
  if (cam.follow) {
    const s = cam.follow.mover.tick(now);
    const p = positionAt(cam.follow.chain, s);
    const ease = reduced ? 1 : 0.04;
    cam.cx += (p.x - cam.cx) * ease;
    cam.cy += (p.y - cam.cy) * ease;
    const target = Math.min(cam.max * 0.35, cam.min * 6); // lean in, not too close
    cam.scale += (target - cam.scale) * ease;
  }

  const sunParam = new URLSearchParams(location.search).get('sun');
  const sun = sunParam !== null ? parseFloat(sunParam) : sunAltitude(new Date(), HELSINKI[0], HELSINKI[1]);
  const day = dayness(sun), dusk = duskness(sun);

  scene.paintBase(cam, sun);
  ctx.drawImage(scene.base, 0, 0);

  // trains + weather
  drawAllTrains(day);
  if (!reduced) weather.draw(ctx, cam, now);

  // station labels above the trains
  if (scene.labels.length) {
    ctx.textBaseline = 'middle';
    for (const L of scene.labels) {
      ctx.font = `500 ${L.fs}px 'Bricolage Grotesque', sans-serif`;
      ctx.strokeStyle = `rgba(200,225,190,${(0.75 * day + 0.1).toFixed(2)})`;
      ctx.lineWidth = Math.max(2, L.fs * 0.22);
      ctx.lineJoin = 'round';
      ctx.strokeText(L.name, L.x, L.y);
      ctx.fillStyle = day < 0.5 ? '#b8c8d8' : '#3a352f';
      ctx.fillText(L.name, L.x, L.y);
    }
    ctx.textBaseline = 'alphabetic';
  }

  // night dim + lamps
  if (day < 1) paintNight(day, dusk);

  // degraded state: connection lost — dim the layout, red lamp, coffee card
  if (store.live) lastLive = now;
  const offline = now - lastLive > 30_000;
  if (offline) {
    ctx.fillStyle = 'rgba(20, 22, 30, 0.35)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  lampEl.classList.toggle('dead', offline);
  coffeeEl.classList.toggle('open', offline);
  coffeeEl.setAttribute('aria-hidden', offline ? 'false' : 'true');

  // fascia counters
  const n = store.trains.size;
  const lates = [...store.trains.values()].filter(t => t.dl >= 5).length;
  countEl.textContent = String(n);

  // late board — top 3 delayed services
  const top = [...store.trains.values()].filter(t => t.dl >= 3)
    .sort((a, b) => b.dl - a.dl).slice(0, 3);
  lateEl.innerHTML = top.length
    ? top.map(t => `<button class="late-item" data-n="${t.n}">${t.ty} ${t.n} <b>+${Math.round(t.dl)}′</b></button>`).join('')
    : '<span class="all-good">all on time</span>';
  lateEl.querySelectorAll('.late-item').forEach(el => {
    el.addEventListener('click', () => {
      const tv = store.trains.get(Number((el as HTMLElement).dataset.n));
      if (tv) { select(tv); cam.follow = tv; updateFollowBtn(); }
    });
  });

  // release a followed train once it leaves the layout
  if (cam.follow && !store.trains.has(cam.follow.n)) { cam.follow = null; updateFollowBtn(); }

  requestAnimationFrame(draw);
}

function drawAllTrains(day: number) {
  // trains sorted so selected draws last
  const now = performance.now();
  const tvs = [...store.trains.values()];
  for (const tv of tvs) if (tv !== sel?.tv) drawTrain(tv, now, day);
  if (sel?.tv) drawTrain(sel.tv, now, day, true);
}

function drawTrain(tv: any, now: number, day: number, selected = false) {
  if (!tv.chain.length) return;
  const s = tv.mover.tick(now);
  const zoom = cam.scale;
  // rolling stock is oversized vs the compressed layout — like real HO stock on a model
  const carLen = 13000, carW = 3600;
  const styles: Record<string, { loco: string; car: string; accent: string }> = {
    IC: { loco: '#3e7d5b', car: '#f2ebdc', accent: '#c94f3d' },
    S:  { loco: '#f2efe8', car: '#f2efe8', accent: '#3e7d5b' },
    PYO:{ loco: '#33517a', car: '#43618c', accent: '#ffd98a' },
    HDM:{ loco: '#b5443b', car: '#e8dcc4', accent: '#8a362f' },
    H:  { loco: '#b5443b', car: '#e8dcc4', accent: '#8a362f' },
    HL: { loco: '#d8484a', car: '#e05555', accent: '#f2ebdc' },
    MV: { loco: '#3e7d5b', car: '#f2ebdc', accent: '#c94f3d' },
  };
  const st = styles[tv.ty] || styles.IC;
  const cars = tv.ty === 'S' ? 6 : tv.ty === 'PYO' ? 9 : tv.ty === 'IC' ? 7 : (tv.ty === 'HL' || tv.ty === 'H') ? 3 : 3;

  const dk = (hex: string) => {
    const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
    const f = 0.45 + 0.55 * day;
    return `rgb(${Math.round(r * f + 18 * (1 - day))},${Math.round(g * f + 22 * (1 - day))},${Math.round(b * f + 30 * (1 - day))})`;
  };

  if (selected) {
    const p = positionAt(tv.chain, s);
    const [x, y] = cam.toPx(p.x, p.y);
    ctx.strokeStyle = tv.dl >= 5 ? 'rgba(214,69,69,0.9)' : 'rgba(255,217,138,0.9)';
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.arc(x, y, Math.max(14, 5200 * zoom), 0, 7); ctx.stroke();
    ctx.setLineDash([]);
  }

  for (let i = cars - 1; i >= 0; i--) {
    const p = positionAt(tv.chain, s - i * carLen * 1.03);
    const [x, y] = cam.toPx(p.x, p.y);
    const w = carLen * zoom * 0.94, h = carW * zoom;
    if (w < 2.5) {
      if (i === 0) {
        ctx.fillStyle = dk(st.loco);
        ctx.beginPath(); ctx.arc(x, y, Math.max(2.2, 800 * zoom), 0, 7); ctx.fill();
      }
      continue;
    }
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(-Math.atan2(Math.sin(p.angle) * cam.squash, Math.cos(p.angle)));
    const bob = tv.sp > 40 ? Math.sin(now / 95 + i * 1.9) * h * 0.025 : 0;
    ctx.translate(0, bob);
    // shadow
    ctx.fillStyle = 'rgba(30,40,30,0.25)';
    ctx.beginPath(); ctx.roundRect(-w / 2, -h / 2 + h * 0.35, w, h, h * 0.4); ctx.fill();
    // body
    ctx.fillStyle = dk(i === 0 ? st.loco : st.car);
    ctx.beginPath(); ctx.roundRect(-w / 2, -h / 2, w, h, h * 0.42); ctx.fill();
    // toy-train outline
    ctx.strokeStyle = 'rgba(25,20,15,0.55)';
    ctx.lineWidth = Math.max(0.7, 220 * zoom);
    ctx.stroke();
    // roofline
    ctx.fillStyle = 'rgba(0,0,0,0.14)';
    ctx.fillRect(-w / 2 + w * 0.05, -h / 2, w * 0.9, h * 0.22);
    // stripe
    ctx.fillStyle = dk(st.accent);
    ctx.globalAlpha = 0.9;
    ctx.fillRect(-w / 2 + w * 0.07, -h * 0.06, w * 0.86, h * 0.2);
    ctx.globalAlpha = 1;
    // windows at dusk/night
    if (day < 0.55 && i > 0) {
      ctx.fillStyle = '#ffd98a';
      const nW = Math.max(2, Math.round(w / (h * 0.95)));
      for (let k = 0; k < nW; k++) ctx.fillRect(-w / 2 + w * 0.1 + (k * w * 0.8) / nW, -h * 0.2, h * 0.26, h * 0.32);
    }
    ctx.restore();
  }
  // headlight
  if (day < 0.55 && tv.sp > 5) {
    const p = positionAt(tv.chain, s + 1500);
    const [x, y] = cam.toPx(p.x, p.y);
    const r = 3200 * zoom;
    if (r > 2) {
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, 'rgba(255,222,150,0.5)');
      g.addColorStop(1, 'rgba(255,222,150,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
    }
  }
}

function paintNight(day: number, dusk: number) {
  const w = canvas.width, h = canvas.height;
  const dim = (1 - day) * 0.34;
  ctx.fillStyle = `rgba(16,24,48,${dim.toFixed(3)})`;
  ctx.fillRect(0, 0, w, h);
  // platform lamps
  if (day < 0.7) {
    ctx.fillStyle = `rgba(255,215,140,${(0.8 * (1 - day)).toFixed(2)})`;
    for (const stn of net.stations.values()) {
      if (!stn.pax) continue;
      const [x, y] = cam.toPx(stn.x, stn.y);
      const r = Math.max(1.2, 500 * cam.scale);
      ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
    }
  }
}

requestAnimationFrame(draw);
