import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseArtifact } from '../src/lib/rainfall';
import { assign, maximin, sameLabels, update } from '../src/lib/kmeans';

const a = parseArtifact(JSON.parse(readFileSync(new URL('../public/data/philippines-rainfall.json', import.meta.url), 'utf8')));

test('browser k-means reproduces the published rain-calendar groups square by square', () => {
  const points = Array.from({ length: a.cells.count }, (_, i) => a.cells.month_share.slice(i * 12, i * 12 + 12).map((v) => v / 10000));
  let centroids = maximin(points, a.climate.k);
  let labels: Int8Array | null = null;
  let iterations = 0;
  for (;;) {
    const next = assign(points, centroids);
    if (sameLabels(labels, next)) break;
    labels = next;
    centroids = update(points, labels, centroids);
    iterations += 1;
  }
  const order = centroids.map((_, j) => j).sort((x, y) => {
    const s = (c: number[]) => c[0]! + c[1]! + c[2]! + c[3]!;
    return s(centroids[x]!) - s(centroids[y]!);
  });
  const rank = new Map(order.map((j, r) => [j, r]));
  assert.equal(iterations, a.climate.iterations);
  assert.deepEqual([...labels!].map((l) => rank.get(l)), a.cells.climate);
});
