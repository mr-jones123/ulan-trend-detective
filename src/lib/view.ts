import type { Artifact, AirIndex, CellIndex, RegionId, SiteIndex } from './rainfall';
import { isFarm, VARIABLES, type Variable, type Window } from './variable';

export type Mode = 'mean' | 'year' | 'enso' | 'trend' | 'farm';
export const MODES: readonly Mode[] = ['mean', 'year', 'enso', 'trend', 'farm'];

export type Focus =
  | { readonly kind: 'country' }
  | { readonly kind: 'region'; readonly region: RegionId }
  | { readonly kind: 'cell'; readonly cell: CellIndex }
  | { readonly kind: 'air-cell'; readonly cell: AirIndex }
  | { readonly kind: 'site'; readonly site: SiteIndex };

export const COUNTRY: Focus = { kind: 'country' };

export const CHAPTER_IDS = [
  'rain', 'driest', 'wettest', 'swing', 'enso', 'enso-region', 'pantabangan',
  'farm-enso', 'farm-night', 'trend', 'trend-where', 'trend-region', 'regions', 'next-year',
] as const;
export type ChapterId = (typeof CHAPTER_IDS)[number];

export type UnmetTrendStyle = 'faded' | 'ghost';

type ChapterSpec = {
  readonly mode: Mode;
  readonly year: ((a: Artifact) => number) | null;
  readonly focus: (a: Artifact, pantabangan: CellIndex) => Focus;
  readonly unmetTrendStyle: UnmetTrendStyle;
  readonly field: 'paper' | 'yellow';
};

const country = () => COUNTRY;

export const CHAPTERS: Readonly<Record<ChapterId, ChapterSpec>> = {
  rain: { mode: 'mean', year: null, focus: country, unmetTrendStyle: 'faded', field: 'paper' },
  driest: { mode: 'year', year: (a) => a.national.driest.year, focus: country, unmetTrendStyle: 'faded', field: 'paper' },
  wettest: { mode: 'year', year: (a) => a.national.wettest.year, focus: country, unmetTrendStyle: 'faded', field: 'paper' },
  swing: { mode: 'year', year: null, focus: country, unmetTrendStyle: 'faded', field: 'paper' },
  enso: { mode: 'enso', year: null, focus: country, unmetTrendStyle: 'faded', field: 'yellow' },
  'enso-region': { mode: 'enso', year: null, focus: (a) => ({ kind: 'region', region: a.facts.focus.enso_region[0] }), unmetTrendStyle: 'faded', field: 'yellow' },
  pantabangan: { mode: 'enso', year: null, focus: (_a, cell) => ({ kind: 'cell', cell }), unmetTrendStyle: 'faded', field: 'yellow' },
  'farm-enso': { mode: 'farm', year: null, focus: country, unmetTrendStyle: 'faded', field: 'yellow' },
  'farm-night': { mode: 'farm', year: null, focus: country, unmetTrendStyle: 'faded', field: 'paper' },
  trend: { mode: 'trend', year: null, focus: country, unmetTrendStyle: 'faded', field: 'paper' },
  'trend-where': { mode: 'trend', year: null, focus: country, unmetTrendStyle: 'ghost', field: 'paper' },
  'trend-region': { mode: 'trend', year: null, focus: (a) => ({ kind: 'region', region: a.facts.focus.trend_region[0] }), unmetTrendStyle: 'faded', field: 'paper' },
  regions: { mode: 'trend', year: null, focus: country, unmetTrendStyle: 'faded', field: 'paper' },
  'next-year': { mode: 'enso', year: null, focus: country, unmetTrendStyle: 'faded', field: 'yellow' },
};

export type MapOwner = 'story' | 'reader';
export type Phase = 'story' | 'explore';
export type CameraReason = 'story' | 'select' | 'reveal';

export type ViewState = {
  readonly phase: Phase;
  readonly chapter: ChapterId;
  readonly owner: MapOwner;
  readonly mode: Mode;
  readonly variable: Variable;
  readonly window: Window;
  readonly demo: { readonly id: DemoId; readonly step: number } | null;
  readonly year: number;
  readonly focus: Focus;
  readonly unmetTrendStyle: UnmetTrendStyle;
  readonly hover: RegionId | null;
  readonly playing: boolean;
  readonly camera: { readonly focus: Focus; readonly request: number; readonly reason: CameraReason };
};

export type Action =
  | { readonly type: 'scroll-chapter'; readonly chapter: ChapterId }
  | { readonly type: 'resume-chapter'; readonly chapter: ChapterId }
  | { readonly type: 'enter-explore' }
  | { readonly type: 'manual-camera' }
  | { readonly type: 'set-variable'; readonly variable: Variable }
  | { readonly type: 'set-window'; readonly window: Window }
  | { readonly type: 'restore'; readonly selection: Selection }
  | { readonly type: 'start-demo'; readonly id: DemoId }
  | { readonly type: 'demo-step'; readonly delta: -1 | 1 }
  | { readonly type: 'exit-demo' }
  | { readonly type: 'set-mode'; readonly mode: Mode }
  | { readonly type: 'set-year'; readonly year: number }
  | { readonly type: 'select'; readonly focus: Focus; readonly cameraReason: CameraReason | null }
  | { readonly type: 'hover-region'; readonly region: RegionId | null }
  | { readonly type: 'play' }
  | { readonly type: 'pause' }
  | { readonly type: 'tick' };

export type Context = { readonly artifact: Artifact; readonly pantabangan: CellIndex };

export function initialState(ctx: Context): ViewState {
  return applyChapter({
    phase: 'story', chapter: 'rain', owner: 'story', mode: 'mean', year: ctx.artifact.period.start,
    variable: 'rain', window: 'annual', demo: null,
    focus: COUNTRY, unmetTrendStyle: 'faded', hover: null, playing: false, camera: { focus: COUNTRY, request: 0, reason: 'story' },
  }, 'rain', ctx);
}

function applyChapter(state: ViewState, chapter: ChapterId, ctx: Context): ViewState {
  const spec = CHAPTERS[chapter];
  const focus = spec.focus(ctx.artifact, ctx.pantabangan);
  return {
    ...state, phase: 'story', chapter, owner: 'story', mode: spec.mode, variable: 'rain',
    window: spec.mode === 'enso' || spec.mode === 'farm' ? 'jan_apr' : 'annual', demo: null,
    year: spec.year?.(ctx.artifact) ?? state.year, focus, unmetTrendStyle: spec.unmetTrendStyle, hover: null, playing: false,
    camera: { focus, request: state.camera.request + 1, reason: 'story' },
  };
}

export type Selection = Pick<ViewState, 'variable' | 'window' | 'mode' | 'focus' | 'year'>;
export type DemoId = 'rain-air' | 'farm';
export type DemoStep = Selection & { readonly text: string };

export function demoSteps(ctx: Context, id: DemoId): readonly DemoStep[] {
  const year = ctx.artifact.period.start;
  const region = ctx.artifact.regions.find((r) => r.id === 'soccsksargen') ?? ctx.artifact.regions[0]!;
  if (id === 'rain-air') return [
    { variable: 'rain', window: 'annual', mode: 'trend', focus: COUNTRY, year, text: 'Start with country-wide annual rainfall. Read the fitted slope and the p-value together; a slope alone does not establish a trend.' },
    { variable: 'rain', window: 'annual', mode: 'trend', focus: { kind: 'region', region: region.id }, year, text: `Now inspect ${region.name}. A regional result need not match the country-wide result.` },
    { variable: 'rain', window: 'jan_apr', mode: 'trend', focus: { kind: 'region', region: region.id }, year, text: 'Keep the region but compare January to April only. This fixes the months being compared, not all seasonal influences. The map now colours regional aggregates, not uncomputed cell trends.' },
    { variable: 'air', window: 'annual', mode: 'trend', focus: COUNTRY, year, text: 'Switch to annual mean air temperature. These are native MERRA-2 model cells, not the smaller rainfall squares. The slope is in °C per decade. This is a different variable, not a dataset agreement test.' },
  ];
  return [
    { variable: 'farm-day', window: 'jan_apr', mode: 'enso', focus: { kind: 'site', site: 0 as SiteIndex }, year, text: 'Inspect sampled cropland site 1 by day. The El Niño-start difference is an association between groups of years, not proof that El Niño caused the difference.' },
    { variable: 'farm-night', window: 'jan_apr', mode: 'trend', focus: { kind: 'site', site: 0 as SiteIndex }, year, text: 'Keep the same site and switch to night. Compare the full slope and test with the 2001-2019 refit below. Terra orbit drift can affect later observations; the shorter refit also has fewer years.' },
    { variable: 'farm-night', window: 'jan_apr', mode: 'trend', focus: COUNTRY, year, text: 'Finally inspect the equal-site mean across all 12 sampled cropland sites. This is not a national temperature or yield estimate. Read its full-period test and pre-drift refit separately.' },
  ];
}

function normalize(selection: Selection, ctx: Context): Selection {
  let { variable, window, mode, focus, year } = selection;
  if (!VARIABLES[variable].modes.includes(mode)) mode = 'mean';
  if (mode === 'enso' || mode === 'farm' || isFarm(variable)) window = 'jan_apr';
  if (focus.kind === 'region') {
    const id = focus.region;
    if (!ctx.artifact.regions.some((r) => r.id === id) || isFarm(variable)) focus = COUNTRY;
  }
  if (focus.kind === 'cell' && (variable !== 'rain' || !Number.isInteger(focus.cell) || focus.cell < 0 || focus.cell >= ctx.artifact.cells.count)) focus = COUNTRY;
  if (focus.kind === 'air-cell' && (variable !== 'air' || !ctx.artifact.air.cells[focus.cell])) focus = COUNTRY;
  if (focus.kind === 'site' && (!isFarm(variable) || !ctx.artifact.farm.sites[focus.site])) focus = COUNTRY;
  if (variable === 'rain' && mode === 'trend' && window === 'jan_apr' && focus.kind === 'cell') {
    const region = ctx.artifact.regions[ctx.artifact.cells.region[focus.cell] ?? -1];
    focus = region ? { kind: 'region', region: region.id } : COUNTRY;
  }
  year = Number.isFinite(year) ? Math.min(ctx.artifact.period.end, Math.max(ctx.artifact.period.start, Math.round(year))) : ctx.artifact.period.start;
  return { variable, window, mode, focus, year };
}

function selectView(state: ViewState, selection: Selection, ctx: Context, demo: ViewState['demo'] = null): ViewState {
  const next = normalize(selection, ctx);
  return { ...state, ...next, owner: 'reader', playing: false, hover: null, demo, unmetTrendStyle: 'faded',
    camera: { focus: next.focus, request: state.camera.request + 1, reason: 'select' } };
}
export function reduce(state: ViewState, action: Action, ctx: Context): ViewState {
  const { start, end } = ctx.artifact.period;
  switch (action.type) {
    case 'set-variable':
      return selectView(state, { ...state, variable: action.variable }, ctx);
    case 'set-window':
      return selectView(state, { ...state, window: action.window }, ctx);
    case 'restore':
      return { ...selectView(state, action.selection, ctx), phase: 'explore' };
    case 'start-demo':
      return { ...selectView(state, demoSteps(ctx, action.id)[0]!, ctx, { id: action.id, step: 0 }), phase: 'explore' };
    case 'demo-step': {
      if (!state.demo) return state;
      const steps = demoSteps(ctx, state.demo.id);
      const step = Math.max(0, Math.min(steps.length - 1, state.demo.step + action.delta));
      return selectView(state, steps[step]!, ctx, { id: state.demo.id, step });
    }
    case 'exit-demo':
      return { ...state, demo: null };
    case 'scroll-chapter':
      if (state.owner === 'reader') return { ...state, phase: 'story', chapter: action.chapter, demo: null };
      if (state.phase === 'story' && state.chapter === action.chapter) return state;
      return applyChapter(state, action.chapter, ctx);
    case 'resume-chapter':
      return applyChapter(state, action.chapter, ctx);
    case 'enter-explore':
      if (state.phase === 'explore') return state;
      if (state.owner === 'reader') return { ...state, phase: 'explore' };
      return { ...state, phase: 'explore', focus: COUNTRY, unmetTrendStyle: 'faded', hover: null,
        camera: { focus: COUNTRY, request: state.camera.request + 1, reason: 'story' } };
    case 'manual-camera':
      return state.owner === 'reader' && state.demo === null ? state : { ...state, owner: 'reader', demo: null };
    case 'set-mode':
      return selectView(state, { ...state, mode: action.mode }, ctx);
    case 'set-year':
      return { ...selectView(state, { ...state, year: action.year }, ctx), owner: state.owner, camera: state.camera };
    case 'select': {
      const next = selectView(state, { ...state, focus: action.focus }, ctx);
      return action.cameraReason === null ? { ...next, camera: state.camera } : { ...next, camera: { ...next.camera, reason: action.cameraReason } };
    }
    case 'hover-region':
      return { ...state, hover: action.region };
    case 'play':
      return { ...state, demo: null, owner: 'reader', playing: true, mode: 'year', year: state.year >= end ? start : state.year };
    case 'pause':
      return { ...state, playing: false, demo: null };
    case 'tick':
      if (!state.playing) return state;
      return state.year >= end ? { ...state, playing: false } : { ...state, year: state.year + 1 };
    default: {
      const unreachable: never = action;
      return unreachable;
    }
  }
}

export function focusKey(focus: Focus, cellId: (cell: CellIndex) => string): string {
  switch (focus.kind) {
    case 'country': return 'country';
    case 'region': return `region:${focus.region}`;
    case 'cell': return `cell:${cellId(focus.cell)}`;
    case 'air-cell': return `air-cell:${focus.cell}`;
    case 'site': return `site:${focus.site}`;
    default: {
      const unreachable: never = focus;
      return unreachable;
    }
  }
}
