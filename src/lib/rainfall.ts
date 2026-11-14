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
const bbox = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90), z.number().min(-180).max(180), z.number().min(-90).max(90)])
  .refine(([west, south, east, north]) => west < east && south < north, 'Bounds must have positive area');
const yearly = z.array(z.number()).length(YEAR_COUNT);
const direction = z.enum(['up', 'down', 'zero']);
const share = z.number().min(0).max(1);
const yearPoint = z.object({ year: z.int().min(FIRST_YEAR), mm: z.number().nonnegative(), anomaly_pct: z.number() });

const ensoComparison = z.object({
  mean_mm: z.number().nonnegative(), other_mean_mm: z.number().positive(), diff_pct: z.number(), direction,
  below_mean: z.int().nonnegative(), group_size: z.int().positive(), other_size: z.int().positive(),
  p: z.number().min(0).max(1), meets_threshold: z.boolean(),
});

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
  enso: ensoComparison,
  jan_apr: z.object({
    mm: yearly, mean_mm: z.number().positive(), anomaly_pct: yearly, enso: ensoComparison,
    sen_mm_decade: z.number(), sen_pct_decade: z.number(), sen_mid_mm: z.number(),
    p: z.number().min(0).max(1), direction, meets_threshold: z.boolean(),
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

const airSeries = z.object({
  c: z.array(z.number().min(-100).max(80)).length(YEAR_COUNT),
  mean_c: z.number().min(-100).max(80), sen_c_decade: z.number(), sen_mid_c: z.number(),
  p: z.number().min(0).max(1), direction, meets_threshold: z.boolean(),
  enso_diff_c: z.number(), enso_direction: direction,
});
const temperature = airSeries.extend({
  enso_p: z.number().min(0).max(1),
  refit: z.object({
    start: z.literal(2001), end: z.literal(2019), sen_c_decade: z.number(),
    p: z.number().min(0).max(1), direction, meets_threshold: z.boolean(),
  }),
});
const greenness = z.object({
  ndvi: z.array(z.number().min(-0.2).max(1)).length(YEAR_COUNT),
  mean_ndvi: z.number().min(-0.2).max(1), sen_ndvi_decade: z.number(), sen_mid_ndvi: z.number(),
  p: z.number().min(0).max(1), direction, meets_threshold: z.boolean(),
  enso_diff_ndvi: z.number(), enso_direction: direction, enso_p: z.number().min(0).max(1),
  refit: z.object({
    start: z.literal(2001), end: z.literal(2019), sen_ndvi_decade: z.number(),
    p: z.number().min(0).max(1), direction, meets_threshold: z.boolean(),
  }),
});

const climateGroup = z.object({
  pagasa_type: z.enum(['I', 'II', 'III', 'IV']), count: z.int().positive(), land_share: z.number().min(0).max(1),
  month_share_pct: z.array(z.number().min(0).max(100)).length(12), jan_apr_share_pct: z.number().min(0).max(100),
  wettest_month: z.int().min(1).max(12), enso: ensoComparison,
});

export const rainfallSchema = z.object({
  schema: z.literal('ph-rain-imerg-v4'),
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
    began_el_nino: z.array(z.boolean()).length(YEAR_COUNT), years: z.array(z.int()), permutations: z.int().positive(),
    source: snapshot.extend({ provider: z.string() }),
  }),
  legend: z.object({
    mean_mm: z.array(z.number()).min(3).max(8), trend_pct: diverging, enso_pct: diverging, year_pct: diverging,
    jan_apr_mean_mm: z.array(z.number()).min(3).max(8),
  }),
  national: series,
  air: z.object({
    grid: z.object({ lat_step: z.literal(0.5), lon_step: z.literal(0.625) }),
    source: z.object({
      provider: z.literal('NASA POWER'), dataset: z.literal('MERRA-2'), parameter: z.literal('T2M'),
      units: z.literal('C'), time_standard: z.literal('UTC'), endpoint: z.url(),
    }),
    cells: z.array(z.object({
      id: z.string().regex(/^\d+-\d+$/), lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180),
      bounds: bbox, weight: z.number().positive(), annual: airSeries, jan_apr: airSeries,
    })).min(1),
    national: z.object({ annual: airSeries, jan_apr: airSeries }),
    regions: z.array(z.object({
      id: regionId, members: z.array(z.int().nonnegative()).min(1),
      weights: z.array(z.number().positive()).min(1), annual: airSeries, jan_apr: airSeries,
    })).length(17),
  }),
  farm: z.object({
    mask_year: z.literal(2020), map_threshold_pct: z.literal(10),
    rain: z.object({ mm: yearly, mean_mm: z.number().positive(), enso: ensoComparison }),
    day: temperature, night: temperature, night_rising_meets: z.int().min(0).max(12),
    night_air: temperature, night_air_rising_meets: z.int().min(0).max(12),
    green: greenness, green_lower_sites: z.int().min(0).max(12),
    sites: z.array(z.object({
      lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180), cropland_pixels: z.int().positive(),
      outline: z.array(z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)])).length(5),
      day: temperature, night: temperature, green: greenness,
    })).length(12),
  }),
  climate: z.object({ k: z.literal(4), iterations: z.int().positive(), inertia: z.number().positive(),
    groups: z.array(climateGroup).length(4) }),
  news: z.object({
    file: z.string(), sha256, retrieved: z.string(), near_normal_pct: z.number().positive(),
    events: z.array(z.object({
      year: z.int().min(FIRST_YEAR), national_anomaly_pct: z.number(), region_count: z.int().positive(),
      reports: z.array(z.object({ outlet: z.string(), title: z.string(), url: z.url(), published: z.string(), sha256, quote: z.string() })).min(1),
      regions: z.array(z.object({ id: regionId, name: z.string(), reported: z.string(), jan_apr_anomaly_pct: z.number(),
        dry_rank: z.int().positive(), near_normal: z.boolean() })).min(1),
    })).min(1),
    research: z.object({ author: z.string(), title: z.string(), url: z.url(), quote: z.string() }),
  }),
  regions: z.array(region).length(17),
  cells: z.object({
    count: z.int().positive(),
    row: z.array(z.int().min(0).max(1799)),
    col: z.array(z.int().min(0).max(3599)),
    region: z.array(z.int().min(-1).max(16)),
    land_pct: z.array(z.int().min(0).max(100)),
    cropland_pct: z.array(z.int().min(0).max(100)),
    weight: z.array(z.number().nonnegative()),
    mean_mm: z.array(z.int().positive()),
    annual_mm: z.array(z.int().nonnegative()),
    jan_apr_mm: z.array(z.int().nonnegative()),
    jan_apr_mean_mm: z.array(z.int().positive()),
    sen_mm_decade: z.array(z.number()),
    sen_pct_decade: z.array(z.number()),
    sen_mid_mm: z.array(z.int()),
    p: z.array(z.number().min(0).max(1)),
    trend_sign: z.array(sign),
    meets: z.array(z.union([z.literal(0), z.literal(1)])),
    jan_apr_enso_diff_pct: z.array(z.number()),
    jan_apr_enso_sign: z.array(sign),
    climate: z.array(z.int().min(0).max(3)),
    month_share: z.array(z.int().min(0).max(10000)),
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
      jan_apr_mean_mm: z.number().positive(), jan_apr_mm_2024: z.number().nonnegative(), jan_apr_anomaly_2024_pct: z.number(),
      jan_apr_direction_2024: direction, jan_apr_enso_diff_pct: z.number(), jan_apr_enso_direction: direction,
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
    merra2: z.object({
      file: z.string().min(1), sha256, bytes: z.int().positive(), manifest: z.string().min(1),
      manifest_sha256: sha256, manifest_bytes: z.int().positive(), requests: z.int().positive(), boundary_sha256: sha256,
      source: z.object({
        provider: z.literal('NASA POWER'), dataset: z.literal('MERRA-2'), parameter: z.literal('T2M'),
        units: z.literal('C'), time_standard: z.literal('UTC'), endpoint: z.url(),
      }),
      api: z.array(z.object({ name: z.string().min(1), version: z.string().min(1) })).min(1),
    }),
    imerg: z.object({ file: z.string(), sha256, bytes: z.int().positive(), manifest: z.string(), manifest_sha256: sha256 }).loose(),
    tmin: z.object({ file: z.string(), sha256, bytes: z.int().positive(), manifest_sha256: sha256, requests: z.literal(12),
      source: z.object({ provider: z.literal('NASA POWER'), dataset: z.literal('MERRA-2'), parameter: z.literal('T2M_MIN'),
        units: z.literal('C'), time_standard: z.literal('UTC'), endpoint: z.url() }) }),
    ndvi: z.object({ file: z.string(), sha256, bytes: z.int().positive(), manifest_sha256: sha256,
      requests: z.int().positive(), boundary_sha256: sha256 }),
    modis: z.object({ file: z.string(), sha256, bytes: z.int().positive(), manifest_sha256: sha256,
      requests: z.int().positive(), boundary_sha256: sha256 }),
    snapshots: z.record(z.string(), snapshot),
    source_audit: z.object({
      point: z.tuple([z.number(), z.number()]),
      years: z.array(z.int()).length(YEAR_COUNT),
      merra2_mm: yearly, imerg_mm: yearly, ratio: yearly,
      max_ratio_year: z.int(),
      other_ratio_range: z.tuple([z.number(), z.number()]),
      merra2_source: z.string(), imerg_source: z.string(),
    }),
    giovanni: z.object({
      file: z.string(), sha256, bytes: z.int().positive(), url: z.url(), bbox, dataset: z.literal('GPM_3IMERGM v07'),
      jan_apr_mm: yearly, mean_mm: z.number().positive(), anomaly_pct: yearly, r: z.number().min(-1).max(1),
      enso: ensoComparison, sen_pct_decade: z.number(), p: z.number().min(0).max(1), direction,
      meets_threshold: z.boolean(),
    }),
  }),
}).superRefine((data, context) => {
  const { cells } = data;
  const perCell = [cells.row, cells.col, cells.region, cells.land_pct, cells.weight, cells.mean_mm, cells.sen_mm_decade,
    cells.sen_pct_decade, cells.sen_mid_mm, cells.p, cells.trend_sign, cells.meets,
    cells.jan_apr_mean_mm, cells.jan_apr_enso_diff_pct, cells.jan_apr_enso_sign, cells.cropland_pct, cells.climate];
  if (perCell.some((column) => column.length !== cells.count)
    || [cells.annual_mm, cells.jan_apr_mm].some((column) => column.length !== cells.count * YEAR_COUNT)
    || cells.month_share.length !== cells.count * 12) {
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
  if (ids.size !== data.regions.length || data.period.years.some((year, i) => year !== FIRST_YEAR + i)) {
    context.addIssue({ code: 'custom', message: 'Regions must be unique and years consecutive' });
  }
  const airIds = new Set(data.air.cells.map((cell) => cell.id));
  if (airIds.size !== data.air.cells.length || new Set(data.air.regions.map((r) => r.id)).size !== ids.size) {
    context.addIssue({ code: 'custom', path: ['air'], message: 'Air cells and regions must have unique IDs' });
  }
  for (const cell of data.air.cells) {
    const [w, s, e, n] = cell.bounds;
    if (cell.id !== `${cell.lat / 0.5}-${cell.lon / 0.625}`) {
      context.addIssue({ code: 'custom', path: ['air', 'cells'], message: 'Air IDs must identify native grid coordinates' });
    }
    if (Math.abs(e - w - 0.625) > 1e-6 || Math.abs(n - s - 0.5) > 1e-6
      || Math.abs((w + e) / 2 - cell.lon) > 1e-6 || Math.abs((s + n) / 2 - cell.lat) > 1e-6) {
      context.addIssue({ code: 'custom', path: ['air', 'cells'], message: 'Air bounds must describe the native cell centered on its coordinates' });
    }
  }
  for (const r of data.air.regions) {
    if (!ids.has(r.id) || r.members.length !== r.weights.length
      || new Set(r.members).size !== r.members.length || r.members.some((m) => m >= data.air.cells.length)) {
      context.addIssue({ code: 'custom', path: ['air', 'regions'], message: 'Air region members and weights must match existing unique cells' });
    }
  }
  for (const r of data.regions) {
    if (r.members.length !== r.weights.length || new Set(r.members).size !== r.members.length || r.members.some((m) => m >= cells.count)) {
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
export type AirIndex = number & { readonly __brand: 'AirIndex' };
export type SiteIndex = number & { readonly __brand: 'SiteIndex' };
export type AirSeries = z.infer<typeof airSeries>;

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
  janApr(cell: CellIndex): number[];
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
    janApr: (cell) => cells.jan_apr_mm.slice(cell * YEAR_COUNT, cell * YEAR_COUNT + YEAR_COUNT),
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
