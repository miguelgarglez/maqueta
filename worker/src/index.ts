// maqueta edge pipeline: one Durable Object keeps Finland's live railway state
// warm — positions every ~15s, per-train timetables cached for the day, weather
// every 10 min — and fans it out over WebSocket plus a JSON snapshot.

const DT = 'https://rata.digitraffic.fi/api/v1';
const UA = { 'Digitraffic-User': 'maqueta/1.0 (github.com/miguelgarglez/maqueta)', 'Accept-Encoding': 'gzip' };
const WX_POINTS = [
  [60.17, 24.94], // Helsinki
  [60.45, 22.27], // Turku
  [61.50, 23.76], // Tampere
  [61.87, 28.19], // Savonlinna
  [62.78, 26.9],  // Kuopio
  [62.24, 25.75], // Jyväskylä
  [64.22, 27.7],  // Kajaani
  [65.01, 25.47], // Oulu
  [66.5, 25.7],   // Rovaniemi
  [68.9, 27.0],   // Ivalo
];
const PASSENGER = new Set(['Long-distance', 'Commuter']);
const TICK_MS = 15_000;
const IDLE_TICK_MS = 300_000;
const TT_TTL_MS = 12 * 3600_000;

interface Pos { lon: number; lat: number; sp: number; ts: number; date: string }
interface TT { stops: string[]; kind: string; line: string | null; cat: string; dep: string; ns: { st: string; at: number; dl: number } | null; dl: number; fetchedAt: number }

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const stub = env.LAYOUT.get(env.LAYOUT.idFromName('finland'));
    return stub.fetch(req);
  },
  async scheduled(_e: ScheduledEvent, env: Env): Promise<void> {
    const stub = env.LAYOUT.get(env.LAYOUT.idFromName('finland'));
    await stub.fetch('https://internal/poke');
  },
};

interface Env { LAYOUT: DurableObjectNamespace }

export class Layout implements DurableObject {
  private positions = new Map<number, Pos>();
  private timetables = new Map<number, TT>();
  private weather: { k: string; t: number }[] = [];
  private weatherAt = 0;
  private ticking: Promise<void> | null = null;
  private ticks = 0;

  constructor(private state: DurableObjectState, private env: Env) {
    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.list<TT>({ prefix: 'tt:' });
      for (const [k, v] of stored) this.timetables.set(Number(k.slice(3).split(':')[0]), v);
    });
  }

  private clientCount() { return this.state.getWebSockets().length; }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/ws' && req.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.state.acceptWebSocket(server);
      server.send(JSON.stringify(this.snapshot()));
      await this.ensureAlarm();
      return new Response(null, { status: 101, webSocket: client });
    }
    if (url.pathname === '/state') { await this.wake(); return this.json(this.snapshot()); }
    if (url.pathname.startsWith('/consist/')) return this.consist(url);
    if (url.pathname === '/poke') { await this.wake(); return new Response('ok'); }
    return new Response('maqueta layout', { status: 404 });
  }

  async webSocketClose(_ws: WebSocket) { await this.ensureAlarm(); }
  async webSocketError(_ws: WebSocket) {}

  private json(body: unknown): Response {
    return new Response(JSON.stringify(body), {
      headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' },
    });
  }

  /** Run a tick right now (deduped), and make sure the next alarm is set. */
  private async wake() {
    if (!this.ticking) {
      this.ticking = this.tick().catch(e => console.error('tick failed', e)).finally(() => { this.ticking = null; });
    }
    await this.ticking;
    await this.ensureAlarm();
  }

  private async ensureAlarm() {
    const current = await this.state.storage.getAlarm();
    const want = Date.now() + (this.clientCount() ? TICK_MS : IDLE_TICK_MS);
    if (!current || current > want) await this.state.storage.setAlarm(want);
  }

  async alarm() {
    await this.wake();
  }

  private async tick() {
    this.ticks++;
    await this.pollPositions();
    await this.warmTimetables();
    if (Date.now() - this.weatherAt > 600_000) await this.pollWeather();
    const sockets = this.state.getWebSockets();
    if (sockets.length) {
      const msg = JSON.stringify(this.snapshot());
      for (const ws of sockets) { try { ws.send(msg); } catch { /* closed */ } }
    }
    await this.state.storage.setAlarm(Date.now() + (this.clientCount() ? TICK_MS : IDLE_TICK_MS));
  }

  private async pollPositions() {
    try {
      const r = await fetch(`${DT}/train-locations/latest`, { headers: UA });
      if (!r.ok) return;
      const rows = (await r.json()) as any[];
      const now = Date.now();
      for (const p of rows) {
        this.positions.set(p.trainNumber, {
          lon: p.location.coordinates[0], lat: p.location.coordinates[1],
          sp: p.speed ?? 0, ts: Date.parse(p.timestamp) || now, date: p.departureDate,
        });
      }
      for (const [n, p] of this.positions) if (now - p.ts > 7_200_000) this.positions.delete(n);
    } catch (e) { console.error('positions poll', e); }
  }

  private async warmTimetables() {
    const jobs: Promise<void>[] = [];
    for (const n of this.positions.keys()) {
      const have = this.timetables.get(n);
      if (have && Date.now() - have.fetchedAt < TT_TTL_MS) continue;
      if (jobs.length >= 8) break;
      jobs.push(this.fetchTT(n));
    }
    await Promise.allSettled(jobs);
    if (this.ticks % 240 === 0) {
      for (const n of this.timetables.keys()) if (!this.positions.has(n)) this.timetables.delete(n);
    }
  }

  private async fetchTT(n: number) {
    try {
      const r = await fetch(`${DT}/trains/latest/${n}`, { headers: UA });
      if (!r.ok) return;
      const [t] = (await r.json()) as any[];
      if (!t) return;
      const stops: string[] = [];
      for (const row of t.timeTableRows) {
        if (!row.trainStopping || !row.commercialStop) continue;
        if (stops[stops.length - 1] !== row.stationShortCode) stops.push(row.stationShortCode);
      }
      const now = Date.now();
      let ns: TT['ns'] = null;
      for (const row of t.timeTableRows) {
        if (!row.trainStopping || !row.commercialStop || row.type !== 'ARRIVAL') continue;
        const at = Date.parse(row.liveEstimateTime || row.scheduledTime);
        if (!row.actualTime && at > now - 60_000) { ns = { st: row.stationShortCode, at, dl: row.differenceInMinutes || 0 }; break; }
      }
      const last = [...t.timeTableRows].reverse().find((r: any) => r.actualTime || r.liveEstimateTime);
      const tt: TT = {
        stops, kind: t.trainType, line: t.commuterLineID || null,
        cat: t.trainCategory, dep: t.departureDate, ns,
        dl: last?.differenceInMinutes || 0, fetchedAt: Date.now(),
      };
      this.timetables.set(n, tt);
      await this.state.storage.put(`tt:${n}:${t.departureDate}`, tt);
    } catch (e) { console.error('tt fetch', n, e); }
  }

  private async pollWeather() {
    try {
      const lat = WX_POINTS.map(p => p[0]).join(',');
      const lon = WX_POINTS.map(p => p[1]).join(',');
      const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=weather_code,temperature_2m`);
      if (!r.ok) return;
      const arr = (await r.json()) as any[];
      this.weather = arr.map(w => ({ k: kind(w.current.weather_code), t: w.current.temperature_2m }));
      this.weatherAt = Date.now();
    } catch (e) { console.error('weather poll', e); }
  }

  private async consist(url: URL): Promise<Response> {
    const n = url.pathname.split('/')[2];
    const dep = url.searchParams.get('dep') || new Date().toISOString().slice(0, 10);
    const key = `consist:${n}:${dep}`;
    const hit = await this.state.storage.get(key);
    if (hit) return this.json(hit);
    try {
      const r = await fetch(`${DT}/compositions/${n}?departure_date=${dep}`, { headers: UA });
      if (!r.ok) return this.json({ wagons: [] });
      const c = (await r.json()) as any;
      const wagons = (c.journeySections || []).flatMap((s: any) =>
        (s.wagons || []).map((w: any) => ({ ty: w.wagonType, no: w.salesNumber })));
      const out = { wagons, category: c.trainCategory, type: c.trainType };
      await this.state.storage.put(key, out);
      return this.json(out);
    } catch { return this.json({ wagons: [] }); }
  }

  private snapshot() {
    const trains: any[] = [];
    for (const [n, p] of this.positions) {
      const tt = this.timetables.get(n);
      if (!tt || !PASSENGER.has(tt.cat) || tt.stops.length < 2) continue;
      trains.push({
        n, ty: tt.kind, ln: tt.line, dep: tt.dep,
        x: p.lon, y: p.lat, sp: p.sp, ts: p.ts,
        dl: tt.dl, ns: tt.ns, rt: tt.stops,
      });
    }
    return { now: Date.now(), trains, weather: this.weather };
  }
}

function kind(code: number): string {
  if ([71, 73, 75, 77, 85, 86].includes(code)) return 'snow';
  if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99].includes(code)) return 'rain';
  if ([45, 48].includes(code)) return 'fog';
  if (code >= 2) return 'cloud';
  return 'clear';
}
