// Record a 30-second narrated tour of the built site for the NASA Space Apps demo.
// Scripted and run by Claude Code (Claude Opus 5.5), an SI tool. demo/compose.sh adds the SI-generated
// ElevenLabs narration and rain ambience and burns in the SI watermark.
// Scene timing follows demo/narration.json: title, El Niño, k-means, farms and damage reports, why it matters.
// Usage: npm run build && npm run preview, then
//   NODE_PATH=<dir containing playwright> node demo/record-site.cjs [http://127.0.0.1:4399/]
const { chromium } = require('playwright');
const path = require('node:path');
const fs = require('node:fs');

const URL = process.argv[2] ?? 'http://127.0.0.1:4399/';
const OUT = path.join(__dirname, 'site-raw');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  const browser = await chromium.launch({ channel: 'chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir: OUT, size: { width: 1280, height: 720 } } });
  const page = await context.newPage();
  const marks = {};
  const t0 = Date.now();
  const mark = (name) => { marks[name] = (Date.now() - t0) / 1000; };

  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-rainfall-app][data-state="ready"]', { timeout: 30000 });
  mark('ready');

  // Glide to an element so the story's scroll-driven map and reveals react as they would for a reader.
  const glide = async (selector, ms, offset = 40) => {
    await page.evaluate(async ({ selector, ms, offset }) => {
      const target = document.querySelector(selector).getBoundingClientRect().top + scrollY - offset;
      const start = scrollY;
      const t = performance.now();
      await new Promise((done) => {
        const step = (now) => {
          const k = Math.min(1, (now - t) / ms);
          // The site sets scroll-behavior: smooth; each frame must jump, or the animations cancel each other.
          scrollTo({ top: start + (target - start) * (k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2), behavior: 'instant' });
          if (k < 1) requestAnimationFrame(step); else done();
        };
        requestAnimationFrame(step);
      });
    }, { selector, ms, offset });
  };

  await wait(3300);                                   // 1. title: "NASA rain over the Philippines, put to the test."
  await glide('#h-enso', 600);
  mark('enso');
  await wait(8500);                                   // 2. El Niño and its permutation test
  await glide('[data-kmeans]', 600, 16);
  await page.click('[data-kmeans] [data-run]');
  mark('kmeans');
  await wait(4400);                                   // 3. k-means repainting the map
  await glide('.news-check', 600, 10);
  mark('farms');
  await wait(2600);                                   // 4a. damage reports beside regional rain
  await glide('[data-claim="farm-green-chart"]', 500, 160);
  await wait(2300);                                   // 4b. crops less green at all 12 sites
  await glide('#why', 600, -60);
  mark('why');
  await wait(6300);                                   // 5. why it matters
  mark('end');

  await context.close();
  await browser.close();
  const video = fs.readdirSync(OUT).find((f) => f.endsWith('.webm'));
  fs.writeFileSync(path.join(OUT, 'marks.json'), JSON.stringify({ video, ...marks }));
  console.log(JSON.stringify({ video: path.join(OUT, video), ...marks }));
})();
