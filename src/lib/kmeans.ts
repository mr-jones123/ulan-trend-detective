// k-means on 12-month rain shapes. The arithmetic order matches scripts/climate.py,
// so stepping this in the browser reproduces the builder's published groups.
export type Point = readonly number[];

export function distance(x: Point, c: Point): number {
  let d = 0;
  for (let m = 0; m < 12; m += 1) {
    const diff = x[m]! - c[m]!;
    d += diff * diff;
  }
  return d;
}

const janApr = (p: Point) => p[0]! + p[1]! + p[2]! + p[3]!;

export function maximin(points: readonly Point[], k: number): number[][] {
  let first = 0;
  for (let i = 1; i < points.length; i += 1) if (janApr(points[i]!) > janApr(points[first]!)) first = i;
  const centroids = [[...points[first]!]];
  let nearest = points.map((p) => distance(p, centroids[0]!));
  while (centroids.length < k) {
    let far = 0;
    for (let i = 1; i < points.length; i += 1) if (nearest[i]! > nearest[far]!) far = i;
    const next = [...points[far]!];
    centroids.push(next);
    nearest = points.map((p, i) => Math.min(nearest[i]!, distance(p, next)));
  }
  return centroids;
}

export function randomCentroids(points: readonly Point[], k: number, random = Math.random): number[][] {
  const picked = new Set<number>();
  while (picked.size < k) picked.add(Math.floor(random() * points.length));
  return [...picked].map((i) => [...points[i]!]);
}

export function assign(points: readonly Point[], centroids: readonly Point[]): Int8Array {
  const labels = new Int8Array(points.length);
  points.forEach((p, i) => {
    let best = 0;
    let bestD = distance(p, centroids[0]!);
    for (let j = 1; j < centroids.length; j += 1) {
      const d = distance(p, centroids[j]!);
      if (d < bestD) { best = j; bestD = d; }
    }
    labels[i] = best;
  });
  return labels;
}

export function update(points: readonly Point[], labels: Int8Array, centroids: readonly Point[]): number[][] {
  const sums = centroids.map(() => new Array<number>(12).fill(0));
  const counts = centroids.map(() => 0);
  points.forEach((p, i) => {
    const label = labels[i]!;
    counts[label]! += 1;
    for (let m = 0; m < 12; m += 1) sums[label]![m]! += p[m]!;
  });
  return sums.map((s, j) => (counts[j]! > 0 ? s.map((v) => v / counts[j]!) : [...centroids[j]!]));
}

export function inertia(points: readonly Point[], labels: Int8Array, centroids: readonly Point[]): number {
  let total = 0;
  points.forEach((p, i) => { total += distance(p, centroids[labels[i]!]!); });
  return total;
}

export const sameLabels = (a: Int8Array | null, b: Int8Array) => a !== null && a.every((v, i) => v === b[i]);
