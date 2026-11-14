import type { ChartInput } from './chart';
import { CLIMATE_NAMES } from './colour';
import { fmt, regionById } from './story';
import type { Artifact, CellGrid, Direction, Series } from './rainfall';
import type { Focus, Mode } from './view';
import { signedC, temperatureSeries, type Variable, type Window } from './variable';

export type Place = {
  readonly key: string;
  readonly heading: string;
  readonly variable: Variable;
  readonly window: Window;
  readonly trendAvailable: boolean;
  readonly refit: Artifact['farm']['day']['refit'] | null;
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
  readonly croplandPct: number | null;
  readonly kind: Focus['kind'];
  readonly climate: number | null;
};

const SIGN_DIRECTION: Record<-1 | 0 | 1, Direction> = { [-1]: 'down', 0: 'zero', 1: 'up' };

function fromSeries(key: string, heading: string, kind: Focus['kind'], s: Series, window: Window): Place {
  const trend = window === 'jan_apr' ? s.jan_apr : s;
  return {
    key, heading, kind, variable: 'rain', window, trendAvailable: true, refit: null,
    annual: s.annual_mm, mean: s.mean_mm, senPerDecade: trend.sen_mm_decade, pctDecade: trend.sen_pct_decade,
    janApr: s.jan_apr.mm, janAprMean: s.jan_apr.mean_mm,
    mid: trend.sen_mid_mm, p: trend.p, meets: trend.meets_threshold,
    ensoDiffPct: s.jan_apr.enso.diff_pct, ensoDirection: s.jan_apr.enso.direction, landPct: null, croplandPct: null, climate: null,
  };
}

export function placeOf(a: Artifact, grid: CellGrid, focus: Focus, variable: Variable = 'rain', window: Window = 'annual'): Place {
  if (variable !== 'rain') {
    const s = temperatureSeries(a, { variable, window, focus });
    const enso = temperatureSeries(a, { variable, window: 'jan_apr', focus });
    const heading = focus.kind === 'site' ? `Sampled cropland site ${focus.site + 1}, ${fmt.lat(a.farm.sites[focus.site]!.lat)}, ${fmt.lon(a.farm.sites[focus.site]!.lon)}`
      : focus.kind === 'air-cell' ? `MERRA-2 cell at ${fmt.lat(a.air.cells[focus.cell]!.lat)}, ${fmt.lon(a.air.cells[focus.cell]!.lon)}`
      : focus.kind === 'region' ? regionById(a, focus.region).name
      : variable === 'air' ? 'Philippines' : 'Mean of 12 sampled cropland sites';
    return {
      key: `${variable}:${focus.kind}:${focus.kind === 'site' ? focus.site : focus.kind === 'air-cell' ? focus.cell : focus.kind === 'region' ? focus.region : ''}`,
      heading, kind: focus.kind, variable, window, trendAvailable: true,
      annual: s.c, janApr: s.c, mean: s.mean_c, janAprMean: s.mean_c,
      senPerDecade: s.sen_c_decade, pctDecade: 0, mid: s.sen_mid_c, p: s.p, meets: s.meets_threshold,
      ensoDiffPct: enso.enso_diff_c, ensoDirection: enso.enso_direction, landPct: null, croplandPct: null,
      refit: 'refit' in s ? s.refit as Artifact['farm']['day']['refit'] : null, climate: null,
    };
  }
  switch (focus.kind) {
    case 'country':
      return fromSeries('country', 'Philippines', 'country', a.national, window);
    case 'region': {
      const region = regionById(a, focus.region);
      return fromSeries(`region:${region.id}`, region.name, 'region', region, window);
    }
    case 'cell': {
      const c = a.cells;
      const i = focus.cell;
      const [lon, lat] = grid.center(i);
      const regionIndex = c.region[i] ?? -1;
      const regionName = a.regions[regionIndex]?.name;
      return {
        key: `cell:${grid.id(i)}`, kind: 'cell',
        variable, window, trendAvailable: window === 'annual', refit: null,
        heading: `Square at ${fmt.lat(lat)}, ${fmt.lon(lon)}${regionName === undefined ? '' : `, ${regionName}`}`,
        annual: grid.annual(i), mean: c.mean_mm[i] ?? 0, senPerDecade: c.sen_mm_decade[i] ?? 0, pctDecade: c.sen_pct_decade[i] ?? 0,
        mid: c.sen_mid_mm[i] ?? 0, p: c.p[i] ?? 1, meets: c.meets[i] === 1,
        janApr: grid.janApr(i), janAprMean: c.jan_apr_mean_mm[i] ?? 0,
        ensoDiffPct: c.jan_apr_enso_diff_pct[i] ?? 0,
        ensoDirection: SIGN_DIRECTION[c.jan_apr_enso_sign[i] ?? 0], landPct: c.land_pct[i] ?? null,
        croplandPct: c.cropland_pct[i] ?? null, climate: c.climate[i] ?? null,
      };
    }
    case 'air-cell':
    case 'site':
      throw new Error('Temperature focus cannot select rainfall');
    default: {
      const unreachable: never = focus;
      return unreachable;
    }
  }
}

export function trendText(a: Artifact, place: Place): string {
  if (!place.trendAvailable) return 'January to April cell trends are unavailable. Select a region or the whole country.';
  const amount = place.variable === 'rain'
    ? `${fmt.signedPct(place.pctDecade)} (${place.senPerDecade.toFixed(2)} mm) per decade`
    : `${signedC(place.senPerDecade)} per decade`;
  return `${amount}, ${fmt.pSameSideOfAlpha(place.p, place.meets, a.alpha)}, ${place.meets ? 'meets' : 'does not meet'} the unadjusted p < 0.05 test.`;
}

export function climateText(a: Artifact, place: Place): string {
  if (place.climate === null) return 'Select a square to see which of the four rain calendars it belongs to.';
  const g = a.climate.groups[place.climate]!;
  return `Rain calendar: ${CLIMATE_NAMES[g.pagasa_type].toLowerCase()}, like PAGASA Type ${g.pagasa_type}. Its group gets ${g.jan_apr_share_pct.toFixed(1)}% of the year's rain from January to April.`;
}

export function modeText(a: Artifact, place: Place, mode: Mode): string {
  if (mode === 'climate') return climateText(a, place);
  return mode === 'enso' || mode === 'farm' ? ensoText(place) : trendText(a, place);
}

export function ensoText(place: Place): string {
  return `${place.variable === 'rain' ? fmt.signedPct(place.ensoDiffPct) : signedC(place.ensoDiffPct)} in El Niño-start years against other years, January to April. Association, not attribution.`;
}

export function placeChart(a: Artifact, place: Place, selectedYear: number | null, mode: Mode): ChartInput {
  const seasonal = place.window === 'jan_apr' || mode === 'enso' || mode === 'farm';
  const rain = place.variable === 'rain';
  const trend = place.trendAvailable && mode !== 'enso' && mode !== 'farm';
  return {
    ...(rain ? { unit: 'mm', baseline: 'zero' } as const : { unit: '°C', baseline: 'mean' } as const),
    summary: mode === 'enso' || mode === 'farm' ? ensoText(place) : trendText(a, place),
    key: `${place.key}:${seasonal ? 'jan_apr' : 'annual'}`, name: place.heading, years: a.period.years,
    totals: seasonal ? place.janApr : place.annual, period: seasonal ? 'January to April' : 'annual',
    enso: a.enso.began_el_nino, mean: seasonal ? place.janAprMean : place.mean,
    trend: trend ? { senPerDecade: place.senPerDecade, mid: place.mid,
      label: rain ? `${fmt.signedPct(place.pctDecade)} per decade` : `${signedC(place.senPerDecade)} per decade`,
      p: place.p, meets: place.meets, alpha: a.alpha } : null,
    selectedYear,
  };
}

export function greenChart(a: Artifact, summary: string): ChartInput {
  const s = a.farm.green;
  return {
    key: 'farm:green', name: 'Cropland sites, crop greenness (NDVI)', years: a.period.years,
    totals: s.ndvi, period: 'January to April', unit: 'NDVI', baseline: 'mean', summary,
    enso: a.enso.began_el_nino, mean: s.mean_ndvi, selectedYear: null,
    trend: { senPerDecade: s.sen_ndvi_decade, mid: s.sen_mid_ndvi,
      label: `${s.sen_ndvi_decade > 0 ? '+' : ''}${s.sen_ndvi_decade.toFixed(3)} NDVI per decade, ${fmt.pSameSideOfAlpha(s.p, s.meets_threshold, a.alpha)}`,
      p: s.p, meets: s.meets_threshold, alpha: a.alpha },
  };
}

export function farmChart(a: Artifact, period: 'day' | 'night', summary: string): ChartInput {
  const s = a.farm[period];
  return {
    key: `farm:${period}`, name: `Cropland sites, ${period} surface temperature`, years: a.period.years,
    totals: s.c, period: 'January to April', unit: '°C', baseline: 'mean', summary,
    enso: a.enso.began_el_nino, mean: s.mean_c, selectedYear: null,
    trend: { senPerDecade: s.sen_c_decade, mid: s.sen_mid_c,
      label: s.meets_threshold ? `${s.sen_c_decade > 0 ? '+' : ''}${s.sen_c_decade.toFixed(2)} °C per decade`
        : `could be chance, ${fmt.pSameSideOfAlpha(s.p, s.meets_threshold, a.alpha)}`,
      p: s.p, meets: s.meets_threshold, alpha: a.alpha },
  };
}
