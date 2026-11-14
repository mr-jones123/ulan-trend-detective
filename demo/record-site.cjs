// Record a ~30-second tour of the built site for the NASA Space Apps demo.
// Scripted and run by Claude Code (Claude Opus 5.5), an SI tool; demo/watermark-site.sh burns in the SI watermark.
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
  await wait(2200); // title and photo mosaic

  // Glide down to an element so the story's scroll-driven map and reveals react as they would for a reader.
  const glide = async (selector, ms, offset = 80) => {
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

  await glide('#ch-rain', 1500);
  await wait(2000); // rain squares
  await glide('#ch-enso', 1500);
  await wait(2600); // El Niño chapter, yellow field
  await glide('#ch-climate', 1500);
  await wait(1000);
  await glide('[data-kmeans]', 900, 16);
  await page.click('[data-kmeans] [data-run]');
  await wait(7500); // k-means running, map repainting
  await glide('#ch-farm-green', 1500);
  await wait(2600); // crops less green
  await glide('#explore', 1500, 0);
  await page.selectOption('[data-region-select]', { index: 4 }).catch(() => {});
  await wait(3000); // explorer, a region selected
  mark('end');

  await context.close();
  await browser.close();
  const video = fs.readdirSync(OUT).find((f) => f.endsWith('.webm'));
  fs.writeFileSync(path.join(OUT, 'marks.json'), JSON.stringify({ video, ...marks }));
  console.log(JSON.stringify({ video: path.join(OUT, video), ...marks }));
})();
