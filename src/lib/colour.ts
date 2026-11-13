import type { ExpressionSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { Artifact } from './rainfall';
import type { Mode } from './view';

export const DIVERGING = ['#8c510a', '#bf812d', '#dfc27d', '#f6e8c3', '#c7eae5', '#80cdc1', '#35978f', '#01665e'] as const;
export const SEQUENTIAL = ['#eef3f1', '#cfe3df', '#a3cec7', '#6fb2ab', '#3f9294', '#1f6f79', '#0b4a5a'] as const;

export type LegendClass = { readonly colour: string; readonly label: string };
export type LegendModel = {
  readonly title: string;
  readonly classes: readonly LegendClass[];
  readonly ends: readonly [string, string];
};

const MINUS = '\u2212';
const signed = (value: number) => (value === 0 ? '0' : `${value > 0 ? '+' : MINUS}${Math.abs(value)}`);
const WHOLE = new Intl.NumberFormat('en-US');

function breaksFor(a: Artifact, mode: Mode): readonly number[] {
  switch (mode) {
    case 'mean': return a.legend.mean_mm;
    case 'year': return a.legend.year_pct;
    case 'enso': return a.legend.enso_pct;
    case 'trend': return a.legend.trend_pct;
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
  trend: () => 'Change per decade, % of the average year',
};

export function legendModel(a: Artifact, mode: Mode, year: number): LegendModel {
  const breaks = breaksFor(a, mode);
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
  trend: ['get', 'trend'],
};

export function colourExpression(a: Artifact, mode: Mode): ExpressionSpecification {
  const breaks = breaksFor(a, mode);
  const palette = paletteFor(mode, breaks.length - 1);
  const stops = breaks.slice(1, -1).flatMap((value, index): (number | string)[] => [value, palette[index + 1] ?? '#000000']);
  return ['step', PROPERTY[mode], palette[0] ?? '#000000', ...stops];
}
