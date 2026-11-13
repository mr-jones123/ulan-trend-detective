import type { Artifact, CellIndex, RegionId } from './rainfall';

export type Mode = 'mean' | 'year' | 'enso' | 'trend' | 'farm';
export const MODES: readonly Mode[] = ['mean', 'year', 'enso', 'trend', 'farm'];

export type Focus =
  | { readonly kind: 'country' }
  | { readonly kind: 'region'; readonly region: RegionId }
  | { readonly kind: 'cell'; readonly cell: CellIndex };

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
    focus: COUNTRY, unmetTrendStyle: 'faded', hover: null, playing: false, camera: { focus: COUNTRY, request: 0, reason: 'story' },
  }, 'rain', ctx);
}

function applyChapter(state: ViewState, chapter: ChapterId, ctx: Context): ViewState {
  const spec = CHAPTERS[chapter];
  const focus = spec.focus(ctx.artifact, ctx.pantabangan);
  return {
    ...state, phase: 'story', chapter, owner: 'story', mode: spec.mode,
    year: spec.year?.(ctx.artifact) ?? state.year, focus, unmetTrendStyle: spec.unmetTrendStyle, hover: null, playing: false,
    camera: { focus, request: state.camera.request + 1, reason: 'story' },
  };
}

export function reduce(state: ViewState, action: Action, ctx: Context): ViewState {
  const { start, end } = ctx.artifact.period;
  switch (action.type) {
    case 'scroll-chapter':
      if (state.owner === 'reader') return { ...state, phase: 'story', chapter: action.chapter };
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
      return state.owner === 'reader' ? state : { ...state, owner: 'reader' };
    case 'set-mode':
      return { ...state, mode: action.mode, owner: 'reader', playing: false, unmetTrendStyle: 'faded' };
    case 'set-year':
      return { ...state, year: Math.min(end, Math.max(start, action.year)), playing: false };
    case 'select':
      return { ...state, focus: action.focus, owner: 'reader', hover: null,
        camera: action.cameraReason === null ? state.camera : { focus: action.focus, request: state.camera.request + 1, reason: action.cameraReason } };
    case 'hover-region':
      return { ...state, hover: action.region };
    case 'play':
      return { ...state, playing: true, mode: 'year', year: state.year >= end ? start : state.year };
    case 'pause':
      return { ...state, playing: false };
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
    default: {
      const unreachable: never = focus;
      return unreachable;
    }
  }
}
