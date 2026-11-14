import type { ExpressionSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { Artifact } from './rainfall';
import type { Mode, ViewState } from './view';
import { VARIABLES, windowLabel, type Window } from './variable';

export const DIVERGING = ['#8c510a', '#bf812d', '#dfc27d', '#f6e8c3', '#c7eae5', '#80cdc1', '#35978f', '#01665e'] as const;
export const SEQUENTIAL = ['#eef3f1', '#cfe3df', '#a3cec7', '#6fb2ab', '#3f9294', '#1f6f79', '#0b4a5a'] as const;

// Rain-calendar groups, ordered by January to April share: dry half-year (brown) to winter-wet (teal).
// Extra colours serve the k-means demo when a reader asks for five or six groups.
export const CLIMATE = ['#8c510a', '#d8a33b', '#5fa8a0', '#01665e', '#6c5b9e', '#c2477d'] as const;
export const CLIMATE_NAMES: Record<'I' | 'II' | 'III' | 'IV', string> = {
  I: 'Dry half-year', III: 'Short dry spell', IV: 'Even year-round', II: 'Wettest in winter',
};

export type LegendClass = { readonly colour: string; readonly label: string };
export type LegendModel = {
  readonly title: string;
  readonly classes: readonly LegendClass[];
  readonly ends: readonly [string, string];
};

const MINUS = '\u2212';
const signed = (value: number) => (value === 0 ? '0' : `${value > 0 ? '+' : MINUS}${Math.abs(value)}`);
const WHOLE = new Intl.NumberFormat('en-US');

function breaksFor(a: Artifact, mode: Mode, window: Window = 'annual'): readonly number[] {
  switch (mode) {
    case 'mean': return window === 'jan_apr' ? a.legend.jan_apr_mean_mm : a.legend.mean_mm;
    case 'year': return a.legend.year_pct;
    case 'enso': return a.legend.enso_pct;
    case 'farm': return a.legend.enso_pct;
    case 'trend': return a.legend.trend_pct;
    case 'climate': return [];
    default: {
      const unreachable: never = mode;
      return unreachable;
    }
  }
}

function paletteFor(mode: Mode, classes: number): readonly string[] {
  if (mode !== 'mean') return DIVERGING;
  const start = Math.floor((SEQUENTIAL.length - classes) / 2);
  return SEQUENTIAL.slice(start, start + classes);
}

const TITLES: Record<Mode, (year: number) => string> = {
  mean: () => 'Average year, 2001-2025, mm',
  year: (year) => `${year} against each square's 2001-2025 average, %`,
  enso: () => 'January to April, El Niño-start years against other years, %',
  farm: () => 'Cropland January to April rain, El Niño gap, %. Outlines are temperature sites.',
  trend: () => 'Change per decade, % of the average year',
  climate: () => '',
};

export function legendModel(a: Artifact, mode: Mode, year: number, window: Window = 'annual'): LegendModel {
  if (mode === 'climate') {
    return { title: 'Rain calendar found by k-means, with the PAGASA type it resembles',
      classes: a.climate.groups.map((g, i) => ({ colour: CLIMATE[i]!, label: `${CLIMATE_NAMES[g.pagasa_type]} (Type ${g.pagasa_type})` })),
      ends: ['dry January to April', 'wet January to April'] };
  }
  const breaks = breaksFor(a, mode, window);
  const classes = breaks.length - 1;
  const palette = paletteFor(mode, classes);
  const label = (value: number) => (mode === 'mean' ? WHOLE.format(value) : signed(value));
  return {
    title: TITLES[mode](year),
    classes: palette.map((colour, index) => {
      const low = breaks[index] ?? 0;
      const high = breaks[index + 1] ?? 0;
      if (index === 0) return { colour, label: `under ${label(high)}` };
      if (index === classes - 1) return { colour, label: `${label(low)} or more` };
      return { colour, label: `${label(low)} to ${label(high)}` };
    }),
    ends: mode === 'mean' ? ['less rain', 'more rain'] : ['drier', 'wetter'],
  };
}

const PROPERTY: Record<Mode, ExpressionSpecification> = {
  mean: ['get', 'mean'],
  year: ['coalesce', ['feature-state', 'a'], 0],
  enso: ['get', 'enso'],
  farm: ['get', 'enso'],
  trend: ['get', 'trend'],
  climate: ['get', 'climate'],
};

export function colourExpression(a: Artifact, mode: Mode, window: Window = 'annual'): ExpressionSpecification {
  if (mode === 'climate') {
    // feature-state 'k' carries a live k-means run; otherwise the published group
    return ['match', ['to-number', ['coalesce', ['feature-state', 'k'], ['get', 'climate']]],
      ...CLIMATE.flatMap((colour, i): (number | string)[] => [i, colour]), '#cccccc'] as unknown as ExpressionSpecification;
  }
  const breaks = breaksFor(a, mode, window);
  const palette = paletteFor(mode, breaks.length - 1);
  const stops = breaks.slice(1, -1).flatMap((value, index): (number | string)[] => [value, palette[index + 1] ?? '#000000']);
  return ['step', PROPERTY[mode], palette[0] ?? '#000000', ...stops];
}

const TEMP_MEAN = [10, 20, 24, 26, 28, 30, 34, 45];
const TEMP_CHANGE = [-2, -1, -0.5, -0.2, 0, 0.2, 0.5, 1, 2];
export function explorerLegend(a: Artifact, state: ViewState): LegendModel {
  if (state.variable === 'rain') {
    const model = legendModel(a, state.mode, state.year, state.window);
    if (state.window === 'annual' || state.mode === 'enso' || state.mode === 'farm') return model;
    return { ...model, title: state.mode === 'trend' ? 'Regional January to April change per decade, % of regional average. Cell trends unavailable.'
      : state.mode === 'year' ? `${state.year} January to April against each cell's 2001-2025 average, %`
      : 'Average January to April, 2001-2025, mm' };
  }
  const breaks = state.mode === 'mean' ? TEMP_MEAN : TEMP_CHANGE;
  const palette = state.mode === 'mean' ? SEQUENTIAL : DIVERGING;
  const measure = state.mode === 'mean' ? '2001-2025 mean, °C' : state.mode === 'trend' ? 'change per decade, °C'
    : state.mode === 'enso' ? 'El Niño-start years minus other years, °C' : `${state.year} minus 2001-2025 mean, °C`;
  return {
    title: `${VARIABLES[state.variable].label}. ${windowLabel(state.window)} ${measure}`,
    classes: palette.map((colour, i) => ({ colour, label: i === 0 ? `under ${breaks[1]}` : i === palette.length - 1 ? `${breaks[i]} or more` : `${breaks[i]} to ${breaks[i + 1]}` })),
    ends: ['cooler', 'warmer'],
  };
}

export function temperatureColour(mode: Mode): ExpressionSpecification {
  const breaks = mode === 'mean' ? TEMP_MEAN : TEMP_CHANGE;
  const palette = mode === 'mean' ? SEQUENTIAL : DIVERGING;
  return ['step', ['get', 'value'], palette[0]!, ...breaks.slice(1, -1).flatMap((v, i) => [v, palette[i + 1]!])];
}
