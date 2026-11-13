import type { ChartInput } from './chart';
import { fmt, regionById } from './story';
import type { Artifact, CellGrid, Direction, Series } from './rainfall';
import type { Focus, Mode } from './view';

export type Place = {
  readonly key: string;
  readonly heading: string;
  readonly annual: readonly number[];
  readonly mean: number;
  readonly janApr: readonly number[];
  readonly janAprMean: number;
  readonly senPerDecade: number;
  readonly pctDecade: number;
  readonly mid: number;
  readonly p: number;
  readonly meets: boolean;
  readonly ensoDiffPct: number;
  readonly ensoDirection: Direction;
  readonly landPct: number | null;
  readonly kind: Focus['kind'];
};

const SIGN_DIRECTION: Record<-1 | 0 | 1, Direction> = { [-1]: 'down', 0: 'zero', 1: 'up' };

function fromSeries(key: string, heading: string, kind: Focus['kind'], s: Series): Place {
  return {
    key, heading, kind, annual: s.annual_mm, mean: s.mean_mm, senPerDecade: s.sen_mm_decade, pctDecade: s.sen_pct_decade,
    janApr: s.jan_apr.mm, janAprMean: s.jan_apr.mean_mm,
    mid: s.sen_mid_mm, p: s.p, meets: s.meets_threshold,
    ensoDiffPct: s.jan_apr.enso.diff_pct, ensoDirection: s.jan_apr.enso.direction, landPct: null,
  };
}

export function placeOf(a: Artifact, grid: CellGrid, focus: Focus): Place {
  switch (focus.kind) {
    case 'country':
      return fromSeries('country', 'Philippines', 'country', a.national);
    case 'region': {
      const region = regionById(a, focus.region);
      return fromSeries(`region:${region.id}`, region.name, 'region', region);
    }
    case 'cell': {
      const c = a.cells;
      const i = focus.cell;
      const [lon, lat] = grid.center(i);
      const regionIndex = c.region[i] ?? -1;
      const regionName = a.regions[regionIndex]?.name;
      return {
        key: `cell:${grid.id(i)}`, kind: 'cell',
        heading: `Square at ${fmt.lat(lat)}, ${fmt.lon(lon)}${regionName === undefined ? '' : `, ${regionName}`}`,
        annual: grid.annual(i), mean: c.mean_mm[i] ?? 0, senPerDecade: c.sen_mm_decade[i] ?? 0, pctDecade: c.sen_pct_decade[i] ?? 0,
        mid: c.sen_mid_mm[i] ?? 0, p: c.p[i] ?? 1, meets: c.meets[i] === 1,
        janApr: grid.janApr(i), janAprMean: c.jan_apr_mean_mm[i] ?? 0,
        ensoDiffPct: c.jan_apr_enso_diff_pct[i] ?? 0,
        ensoDirection: SIGN_DIRECTION[c.jan_apr_enso_sign[i] ?? 0], landPct: c.land_pct[i] ?? null,
      };
    }
    default: {
      const unreachable: never = focus;
      return unreachable;
    }
  }
}

export function placeChart(a: Artifact, place: Place, selectedYear: number | null, mode: Mode): ChartInput {
  const seasonal = mode === 'enso';
  return {
    key: `${place.key}:${seasonal ? 'jan_apr' : 'annual'}`, name: place.heading, years: a.period.years,
    totals: seasonal ? place.janApr : place.annual, period: seasonal ? 'January to April' : 'annual',
    enso: a.enso.began_el_nino, mean: seasonal ? place.janAprMean : place.mean,
    trend: seasonal ? null : { senPerDecade: place.senPerDecade, mid: place.mid, pctDecade: place.pctDecade,
      p: place.p, meets: place.meets, alpha: a.alpha },
    ensoDiffPct: place.ensoDiffPct, selectedYear,
  };
}
