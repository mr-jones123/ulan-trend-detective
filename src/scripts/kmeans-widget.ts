import { CLIMATE } from '../lib/colour';
import { assign, inertia, maximin, randomCentroids, sameLabels, update, type Point } from '../lib/kmeans';
import type { Artifact } from '../lib/rainfall';

const STEP_MS = 280;
const janApr = (p: Point) => p[0]! + p[1]! + p[2]! + p[3]!;
const junSep = (p: Point) => p[5]! + p[6]! + p[7]! + p[8]!;

// Interactive k-means over every rain square. Each half-step either assigns squares
// to their nearest centre or moves centres to their members' mean; both repaint the map.
export function createKmeansWidget(root: HTMLElement, a: Artifact, paint: (labels: Int8Array | null) => void): void {
  const points: Point[] = Array.from({ length: a.cells.count }, (_, i) =>
    a.cells.month_share.slice(i * 12, i * 12 + 12).map((v) => v / 10000));
  const q = <T extends Element>(selector: string) => root.querySelector<T>(selector)!;
  const canvas = q<HTMLCanvasElement>('[data-kmeans-plot]');
  const kInput = q<HTMLInputElement>('[data-k]');
  const kOut = q<HTMLOutputElement>('[data-k-out]');
  const stepButton = q<HTMLButtonElement>('[data-step]');
  const runButton = q<HTMLButtonElement>('[data-run]');
  const iterationOut = q<HTMLElement>('[data-iteration]');
  const nextOut = q<HTMLElement>('[data-next]');
  const inertiaOut = q<HTMLElement>('[data-inertia]');
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

  const xs = points.map(janApr);
  const ys = points.map(junSep);
  const xMax = Math.ceil(Math.max(...xs) * 10) / 10;
  const yMax = Math.ceil(Math.max(...ys) * 10) / 10;

  let k = Number(kInput.value);
  let centroids: number[][] = [];
  let trails: [number, number][][] = [];
  let labels: Int8Array | null = null;
  let phase: 'assign' | 'update' | 'done' = 'assign';
  let iteration = 0;
  let timer: number | null = null;

  // Colour each group by its centre's January to April share, dry (brown) to wet (teal),
  // so a finished k = 4 run matches the published map legend.
  const ranks = () => {
    const order = centroids.map((_, j) => j).sort((x, y) => janApr(centroids[x]!) - janApr(centroids[y]!));
    const rank = new Array<number>(centroids.length);
    order.forEach((j, r) => { rank[j] = r; });
    return rank;
  };

  function reset(start: number[][]) {
    stop();
    centroids = start;
    trails = start.map((c) => [[janApr(c), junSep(c)]]);
    labels = null;
    phase = 'assign';
    iteration = 0;
    paint(null);
    draw();
  }

  function step() {
    if (phase === 'done') return;
    if (phase === 'assign') {
      const next = assign(points, centroids);
      if (sameLabels(labels, next)) {
        phase = 'done';
        stop();
      } else {
        labels = next;
        iteration += 1;
        phase = 'update';
      }
      const rank = ranks();
      paint(next.map((l) => rank[l]!));
    } else {
      centroids = update(points, labels!, centroids);
      centroids.forEach((c, j) => trails[j]!.push([janApr(c), junSep(c)]));
      phase = 'assign';
    }
    draw();
  }

  const settled = () => phase === 'done';

  function stop() {
    if (timer !== null) window.clearInterval(timer);
    timer = null;
    runButton.textContent = 'Run';
    runButton.setAttribute('aria-pressed', 'false');
  }

  function run() {
    if (timer !== null) { stop(); return; }
    if (phase === 'done') return;
    if (reduceMotion.matches) {
      for (let guard = 0; guard < 1000 && !settled(); guard += 1) step();
      return;
    }
    runButton.textContent = 'Pause';
    runButton.setAttribute('aria-pressed', 'true');
    timer = window.setInterval(step, STEP_MS);
  }

  function draw() {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const ratio = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(width * ratio)) {
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const style = getComputedStyle(root);
    const ink = style.getPropertyValue('--ink').trim() || '#0d2a1c';
    const muted = style.getPropertyValue('--muted').trim() || '#4d5a53';
    const pad = { left: 44, right: 12, top: 12, bottom: 36 };
    const px = (x: number) => pad.left + (x / xMax) * (width - pad.left - pad.right);
    const py = (y: number) => height - pad.bottom - (y / yMax) * (height - pad.top - pad.bottom);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.font = '12px "Albert Sans", sans-serif';
    ctx.lineWidth = 1;
    for (let v = 0; v <= xMax + 1e-9; v += 0.1) {
      ctx.strokeStyle = 'rgba(13, 42, 28, 0.1)';
      ctx.beginPath(); ctx.moveTo(px(v), py(0)); ctx.lineTo(px(v), py(yMax)); ctx.stroke();
      ctx.fillStyle = muted; ctx.textAlign = 'center';
      ctx.fillText(`${Math.round(v * 100)}%`, px(v), height - pad.bottom + 16);
    }
    for (let v = 0; v <= yMax + 1e-9; v += 0.1) {
      ctx.strokeStyle = 'rgba(13, 42, 28, 0.1)';
      ctx.beginPath(); ctx.moveTo(px(0), py(v)); ctx.lineTo(px(xMax), py(v)); ctx.stroke();
      ctx.fillStyle = muted; ctx.textAlign = 'right';
      ctx.fillText(`${Math.round(v * 100)}%`, pad.left - 6, py(v) + 4);
    }
    const rank = ranks();
    const colour = (j: number) => CLIMATE[rank[j]!] ?? ink;
    ctx.globalAlpha = 0.7;
    points.forEach((_, i) => {
      ctx.fillStyle = labels === null ? '#9aa39e' : colour(labels[i]!);
      ctx.beginPath(); ctx.arc(px(xs[i]!), py(ys[i]!), 2, 0, Math.PI * 2); ctx.fill();
    });
    ctx.globalAlpha = 1;
    trails.forEach((trail, j) => {
      ctx.strokeStyle = colour(j); ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]);
      ctx.beginPath();
      trail.forEach(([x, y], t) => (t === 0 ? ctx.moveTo(px(x), py(y)) : ctx.lineTo(px(x), py(y))));
      ctx.stroke();
    });
    ctx.setLineDash([]);
    centroids.forEach((c, j) => {
      const x = px(janApr(c)); const y = py(junSep(c)); const s = 9;
      ctx.fillStyle = colour(j); ctx.strokeStyle = '#f7f7f7'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x, y - s); ctx.lineTo(x + s, y); ctx.lineTo(x, y + s); ctx.lineTo(x - s, y); ctx.closePath();
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#ffffff'; ctx.textAlign = 'center'; ctx.font = '600 10px "Albert Sans", sans-serif';
      ctx.fillText(String(rank[j]! + 1), x, y + 3.5);
      ctx.font = '12px "Albert Sans", sans-serif';
    });
    iterationOut.textContent = String(iteration);
    nextOut.textContent = phase === 'done' ? 'Settled' : phase === 'assign' ? 'Assign squares' : 'Move centres';
    inertiaOut.textContent = labels === null ? '–' : inertia(points, labels, centroids).toFixed(2);
    stepButton.disabled = phase === 'done';
    runButton.disabled = phase === 'done';
    canvas.setAttribute('aria-label', `Scatter of ${points.length} rain squares by January to April share and June to September share of yearly rain. k = ${k}. Iteration ${iteration}. ${phase === 'done' ? 'Settled.' : ''}`);
  }

  kInput.addEventListener('input', () => {
    k = Number(kInput.value);
    kOut.textContent = String(k);
    reset(maximin(points, k));
  });
  stepButton.addEventListener('click', step);
  runButton.addEventListener('click', run);
  q<HTMLButtonElement>('[data-new]').addEventListener('click', () => reset(randomCentroids(points, k)));
  q<HTMLButtonElement>('[data-reset]').addEventListener('click', () => reset(maximin(points, k)));
  new ResizeObserver(() => draw()).observe(canvas);
  reset(maximin(points, k));
}
