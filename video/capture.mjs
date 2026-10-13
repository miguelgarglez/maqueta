// Launch video capture: playwright records a scripted pass over the live site —
// day board → follow the most delayed train → dusk → night → pull back.
//   node video/capture.mjs   →  video/capture.webm
//   ffmpeg -i video/capture.webm -c:v libx264 -pix_fmt yuv420p -crf 20 docs/launch.mp4
import { chromium } from 'playwright';

const URL = process.env.SITE || 'https://maqueta-live.vercel.app';

const b = await chromium.launch();
const ctx = await b.newContext({
  viewport: { width: 1280, height: 800 },
  recordVideo: { dir: 'video', size: { width: 1280, height: 800 } },
});
const p = await ctx.newPage();
await p.goto(`${URL}?sun=0.4`, { waitUntil: 'networkidle' });
await p.waitForTimeout(6000);                        // day, whole board
await p.click('#btn-late');                          // follow most delayed
await p.waitForTimeout(7000);                        // glide in, inspector opens
for (let i = 0; i <= 24; i++) {                      // dusk → night sweep
  const s = 0.4 - (i / 24) * 0.75;
  await p.evaluate(v => history.replaceState(null, '', '?sun=' + v), s.toFixed(3));
  await p.waitForTimeout(130);
}
await p.waitForTimeout(4500);                        // night: lamps, headlights
await p.evaluate(() => history.replaceState(null, '', '?sun=0.4'));
await p.click('#insp-close').catch(() => {});
await p.evaluate(() => document.getElementById('btn-follow').click());
await p.mouse.move(640, 400);
await p.mouse.wheel(0, 900);
await p.waitForTimeout(4500);
await ctx.close();
await b.close();
