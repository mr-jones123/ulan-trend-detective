import type { Artifact, AirIndex, SiteIndex } from './rainfall';
import type { Focus, Mode, ViewState } from './view';

export type Variable = 'rain' | 'air' | 'farm-day' | 'farm-night';
export type Window = 'annual' | 'jan_apr';
export const VARIABLES: Record<Variable, { label: string; unit: 'mm' | '°C'; definition: string; coverage: string; source: string; modes: readonly Mode[] }> = {
  rain: { label: 'Satellite rainfall', unit: 'mm', definition: 'IMERG precipitation totals. One millimetre is one litre of water spread over a square metre.', coverage: '2001-2025. Native 0.1° rain cells. January to April trends are available for country and regions only.', source: 'NASA GPM IMERG Final Run via NASA POWER', modes: ['mean', 'year', 'enso', 'trend', 'farm'] },
  air: { label: 'Model air temperature at 2 m', unit: '°C', definition: 'MERRA-2 T2M is mean air temperature two metres above the ground. Reanalysis combines observations with a weather model; it is not a thermometer in every cell.', coverage: '2001-2025. Native 0.5° latitude by 0.625° longitude cells. Annual or January to April day-weighted means; national and regional land-area weights.', source: 'NASA MERRA-2 T2M via NASA POWER', modes: ['mean', 'year', 'enso', 'trend'] },
  'farm-day': { label: 'Satellite farm surface, day', unit: '°C', definition: 'MODIS clear-sky daytime ground-surface temperature over sampled cropland pixels. This is not air temperature or crop yield.', coverage: 'January to April, 2001-2025. Twelve sampled cropland windows, not nationwide farm coverage. Country view is an equal-site mean. Regional averages are unavailable.', source: 'NASA Terra MODIS MOD11A2 and MCD12Q1 via ORNL DAAC', modes: ['mean', 'year', 'enso', 'trend'] },
  'farm-night': { label: 'Satellite farm surface, night', unit: '°C', definition: 'MODIS clear-sky nighttime ground-surface temperature over sampled cropland pixels. This is not air temperature or crop yield.', coverage: 'January to April, 2001-2025. Twelve sampled cropland windows, not nationwide farm coverage. Country view is an equal-site mean. Regional averages are unavailable.', source: 'NASA Terra MODIS MOD11A2 and MCD12Q1 via ORNL DAAC', modes: ['mean', 'year', 'enso', 'trend'] },
};
export const isVariable = (value: string): value is Variable => Object.hasOwn(VARIABLES, value);
export const isFarm = (variable: Variable) => variable === 'farm-day' || variable === 'farm-night';
export const signedC = (value: number) => `${value > 0 ? '+' : ''}${value.toFixed(2)} °C`;
export const windowLabel = (window: Window) => window === 'annual' ? 'Annual' : 'January to April';
export function focusAt(a: Artifact, variable: Variable, lon: number, lat: number): Focus | null {
  if (variable === 'air') {
    const i = a.air.cells.findIndex(({ bounds: [w, s, e, n] }) => lon >= w && lon < e && lat >= s && lat < n);
    return i < 0 ? null : { kind: 'air-cell', cell: i as AirIndex };
  }
  if (isFarm(variable)) {
    const i = a.farm.sites.findIndex(({ outline }) => {
      let inside = false;
      for (let j = 1; j < outline.length; j += 1) {
        const [x1, y1] = outline[j - 1]!;
        const [x2, y2] = outline[j]!;
        const cross = (lon - x1) * (y2 - y1) - (lat - y1) * (x2 - x1);
        if (Math.abs(cross) < 1e-10
          && lon >= Math.min(x1, x2) && lon <= Math.max(x1, x2)
          && lat >= Math.min(y1, y2) && lat <= Math.max(y1, y2)) return true;
        if ((y1 > lat) !== (y2 > lat) && lon < (x2 - x1) * (lat - y1) / (y2 - y1) + x1) inside = !inside;
      }
      return inside;
    });
    return i < 0 ? null : { kind: 'site', site: i as SiteIndex };
  }
  return null;
}
export function temperatureSeries(a: Artifact, state: Pick<ViewState, 'variable' | 'window' | 'focus'>) {
  const focus = state.focus;
  if (state.variable === 'air') {
    const group = focus.kind === 'air-cell' ? a.air.cells[focus.cell]
      : focus.kind === 'region' ? a.air.regions.find((r) => r.id === focus.region) : a.air.national;
    if (!group) throw new Error('Missing air coverage');
    return group[state.window];
  }
  const period = state.variable === 'farm-night' ? 'night' : 'day';
  return state.focus.kind === 'site' ? a.farm.sites[state.focus.site]![period] : a.farm[period];
}
