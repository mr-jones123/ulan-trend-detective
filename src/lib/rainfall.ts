import { z } from 'zod';

export const YEAR_COUNT = 25;
export const FIRST_YEAR = 2001;
export const DATA_URL = '/data/philippines-rainfall.json';

const GRID_STEP_DEGREES = 0.1;
const EDGE_SLACK_CELLS = 1e-9;

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const snapshot = z.object({
  url: z.url(), file: z.string().min(1), sha256, bytes: z.int().positive(),
  retrieved_at: z.iso.datetime({ offset: true }),
});
const bbox = z.tuple([z.number(), z.number(), z.number(), z.number()])
  .refine(([west, south, east, north]) => west < east && south < north, 'Bounds must have positive area');
const yearly = z.array(z.number()).length(YEAR_COUNT);
const direction = z.enum(['up', 'down', 'zero']);
const share = z.number().min(0).max(1);
const yearPoint = z.object({ year: z.int().min(FIRST_YEAR), mm: z.number().nonnegative(), anomaly_pct: z.number() });

const series = z.object({
  annual_mm: yearly,
  anomaly_pct: yearly,
  mean_mm: z.number().positive(),
  sen_mm_decade: z.number(),
  sen_pct_decade: z.number(),
  sen_mid_mm: z.number(),
  mk_s: z.int(),
  p: z.number().min(0).max(1),
  direction,
  meets_threshold: z.boolean(),
  enso: z.object({
    mean_mm: z.number().nonnegative(), other_mean_mm: z.number().positive(), diff_pct: z.number(), direction,
    below_mean: z.int().nonnegative(), group_size: z.int().positive(), other_size: z.int().positive(),
  }),
  wettest: yearPoint,
  driest: yearPoint,
});

const shareSet = z.object({ up: share, down: share, zero: share, meets_up: share, meets_down: share });
const countSet = z.object({
  up: z.int().nonnegative(), down: z.int().nonnegative(), zero: z.int().nonnegative(),
  meets_up: z.int().nonnegative(), meets_down: z.int().nonnegative(),
});
const shares = z.object({ area: shareSet, count: countSet, total_count: z.int().positive() });

export const regionId = z.string().regex(/^[a-z0-9-]+$/).brand<'RegionId'>();
export type RegionId = z.infer<typeof regionId>;

const region = series.extend({
  id: regionId,
  name: z.string().min(1),
  iso: z.string().min(1),
  bounds: bbox,
  members: z.array(z.int().nonnegative()).min(1),
  weights: z.array(z.number().positive()).min(1),
  shares,
});

const diverging = z.array(z.number()).length(9)
  .refine((breaks) => breaks.every((value, index) => value === -(breaks[breaks.length - 1 - index] ?? Number.NaN)),
    'Diverging breaks must be symmetric around zero');
const sign = z.union([z.literal(-1), z.literal(0), z.literal(1)]);
const ranked = z.array(z.object({ id: regionId, share }));

export const rainfallSchema = z.object({
  schema: z.literal('ph-rain-imerg-v1'),
  period: z.object({ start: z.literal(FIRST_YEAR), end: z.literal(2025), years: z.array(z.int()).length(YEAR_COUNT) }),
  alpha: z.literal(0.05),
  source: z.object({
    provider: z.literal('NASA POWER'), dataset: z.literal('GPM IMERG Final Run'), parameter: z.literal('IMERG_PRECTOT'),
    endpoint: z.url(), api_versions: z.array(z.string()).min(1), time_standard: z.literal('UTC'),
    units: z.literal('mm/day'), tiles: z.int().positive(), requests: z.int().positive(),
    cube_sha256: sha256, manifest_sha256: sha256,
  }),
  grid: z.object({ lat_origin: z.literal(-89.95), lon_origin: z.literal(-179.95), step: z.literal(GRID_STEP_DEGREES) }),
  bounds: bbox,
  boundaries: z.object({
    adm0: snapshot.extend({ provider: z.string(), source: z.string(), revision: z.string(), license: z.string(), license_url: z.url() }),
    adm1: snapshot.extend({ provider: z.string(), source: z.string(), revision: z.string(), license: z.string(), license_url: z.url() }),
  }),
  enso: z.object({
    rule: z.string(), threshold: z.literal(0.5), oni_djf: yearly,
    began_el_nino: z.array(z.boolean()).length(YEAR_COUNT), years: z.array(z.int()),
    source: snapshot.extend({ provider: z.string() }),
  }),
  legend: z.object({
    mean_mm: z.array(z.number()).min(3).max(8), trend_pct: diverging, enso_pct: diverging, year_pct: diverging,
  }),
  national: series,
  regions: z.array(region).length(17),
  cells: z.object({
    count: z.int().positive(),
    row: z.array(z.int().min(0).max(1799)),
    col: z.array(z.int().min(0).max(3599)),
    region: z.array(z.int().min(-1).max(16)),
    land_pct: z.array(z.int().min(0).max(100)),
    weight: z.array(z.number().nonnegative()),
    mean_mm: z.array(z.int().positive()),
    annual_mm: z.array(z.int().nonnegative()),
    sen_mm_decade: z.array(z.number()),
    sen_pct_decade: z.array(z.number()),
    sen_mid_mm: z.array(z.int()),
    p: z.array(z.number().min(0).max(1)),
    trend_sign: z.array(sign),
    meets: z.array(z.union([z.literal(0), z.literal(1)])),
    enso_diff_pct: z.array(z.number()),
    enso_sign: z.array(sign),
  }),
  facts: z.object({
    shares,
    enso_less_area_share: share,
    regions_enso_less: z.int().min(0).max(17),
    regions_meeting: z.array(regionId),
    meeting_regions: z.object({ up: ranked, down: ranked }),
    swing: z.object({ range_mm: z.number().nonnegative(), trend_change_mm: z.number().nonnegative(), range_exceeds_trend: z.boolean() }),
    pantabangan: z.object({
      mean_mm: z.number().positive(), mm_2024: z.number().nonnegative(), anomaly_2024_pct: z.number(),
      direction_2024: direction, enso_diff_pct: z.number(), enso_direction: direction,
    }),
    focus: z.object({
      wettest_mean_region: z.tuple([regionId], regionId),
      driest_mean_region: z.tuple([regionId], regionId),
      enso_region: z.tuple([regionId], regionId),
      trend_region: z.tuple([regionId], regionId),
      pantabangan_cell: z.string().regex(/^\d+-\d+$/),
    }),
  }),
  provenance: z.object({
    imerg: z.object({ file: z.string(), sha256, bytes: z.int().positive(), manifest: z.string(), manifest_sha256: sha256 }).loose(),
    snapshots: z.record(z.string(), snapshot),
    source_audit: z.object({
      point: z.tuple([z.number(), z.number()]),
      years: z.array(z.int()).length(YEAR_COUNT),
      merra2_mm: yearly, imerg_mm: yearly, ratio: yearly,
      max_ratio_year: z.int(),
      other_ratio_range: z.tuple([z.number(), z.number()]),
      merra2_source: z.string(), imerg_source: z.string(),
    }),
  }),
}).superRefine((data, context) => {
  const { cells } = data;
  const perCell = [cells.row, cells.col, cells.region, cells.land_pct, cells.weight, cells.mean_mm, cells.sen_mm_decade,
    cells.sen_pct_decade, cells.sen_mid_mm, cells.p, cells.trend_sign, cells.meets, cells.enso_diff_pct, cells.enso_sign];
  if (perCell.some((column) => column.length !== cells.count) || cells.annual_mm.length !== cells.count * YEAR_COUNT) {
    context.addIssue({ code: 'custom', path: ['cells'], message: 'Cell columns must match the cell count' });
  }
  for (let i = 1; i < cells.count; i += 1) {
    const previous = (cells.row[i - 1] ?? 0) * 3600 + (cells.col[i - 1] ?? 0);
    if ((cells.row[i] ?? 0) * 3600 + (cells.col[i] ?? 0) <= previous) {
      context.addIssue({ code: 'custom', path: ['cells', 'row'], message: 'Cells must be unique and sorted by row, then column' });
      break;
    }
  }
  const ids = new Set(data.regions.map((r) => r.id));
  for (const r of data.regions) {
    if (r.members.length !== r.weights.length || r.members.some((m) => m >= cells.count)) {
      context.addIssue({ code: 'custom', path: ['regions', r.id], message: 'Region members must index cells' });
    }
  }
  const focus = data.facts.focus;
  const named = [...focus.wettest_mean_region, ...focus.driest_mean_region, ...focus.enso_region, ...focus.trend_region,
    ...data.facts.regions_meeting, ...data.facts.meeting_regions.up.map((r) => r.id), ...data.facts.meeting_regions.down.map((r) => r.id)];
  if (named.some((id) => !ids.has(id))) {
    context.addIssue({ code: 'custom', path: ['facts'], message: 'Facts must name existing regions' });
  }
  const [row, col] = focus.pantabangan_cell.split('-').map(Number);
  if (!cells.row.some((r, i) => r === row && cells.col[i] === col)) {
    context.addIssue({ code: 'custom', path: ['facts', 'focus', 'pantabangan_cell'], message: 'Pantabangan cell must exist' });
  }
});

export type Artifact = z.infer<typeof rainfallSchema>;
export type Series = Artifact['national'];
export type Region = Artifact['regions'][number];
export type Direction = Series['direction'];

export type CellIndex = number & { readonly __brand: 'CellIndex' };

export function parseArtifact(input: unknown): Artifact {
  return rainfallSchema.parse(input);
}

export type CellGrid = {
  readonly count: number;
  readonly all: readonly CellIndex[];
  at(position: number): CellIndex | null;
  index(row: number, col: number): CellIndex | null;
  fromId(id: string): CellIndex | null;
  rowCol(cell: CellIndex): [number, number];
  id(cell: CellIndex): string;
  center(cell: CellIndex): [number, number];
  ring(cell: CellIndex): [number, number][];
  annual(cell: CellIndex): number[];
};

export function decodeCells(a: Artifact): CellGrid {
  const { cells, grid } = a;
  const all = Array.from({ length: cells.count }, (_, i) => i as CellIndex);
  const lookup = new Map<number, CellIndex>();
  for (const cell of all) lookup.set((cells.row[cell] ?? 0) * 3600 + (cells.col[cell] ?? 0), cell);
  const row = (cell: CellIndex) => cells.row[cell] ?? 0;
  const col = (cell: CellIndex) => cells.col[cell] ?? 0;
  const index = (r: number, c: number) => lookup.get(r * 3600 + c) ?? null;
  return {
    count: cells.count,
    all,
    at: (position) => all[position] ?? null,
    index,
    rowCol: (cell) => [row(cell), col(cell)],
    fromId(id) {
      const match = /^(\d+)-(\d+)$/.exec(id);
      return match ? index(Number(match[1]), Number(match[2])) : null;
    },
    id: (cell) => `${row(cell)}-${col(cell)}`,
    center: (cell) => [round4(grid.lon_origin + grid.step * col(cell)), round4(grid.lat_origin + grid.step * row(cell))],
    ring(cell) {
      const west = round4(-180 + grid.step * col(cell));
      const south = round4(-90 + grid.step * row(cell));
      const east = round4(west + grid.step);
      const north = round4(south + grid.step);
      return [[west, south], [east, south], [east, north], [west, north], [west, south]];
    },
    annual: (cell) => cells.annual_mm.slice(cell * YEAR_COUNT, cell * YEAR_COUNT + YEAR_COUNT),
  };
}

function round4(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}

export function containingRowCol(lon: number, lat: number): [number, number] {
  return [Math.floor((lat + 90) / GRID_STEP_DEGREES + EDGE_SLACK_CELLS), Math.floor((lon + 180) / GRID_STEP_DEGREES + EDGE_SLACK_CELLS)];
}

export function cellAt(grid: CellGrid, lon: number, lat: number): CellIndex | null {
  const [row, col] = containingRowCol(lon, lat);
  return grid.index(row, col);
}

export function anomalyPct(annual: number, mean: number): number {
  return (100 * (annual - mean)) / mean;
}
