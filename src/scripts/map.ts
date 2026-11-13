import type { ExpressionSpecification, StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import {
  AttributionControl,
  Map as MapLibreMap,
  NavigationControl,
  setWorkerUrl,
  type GeoJSONSource,
  type LngLatBoundsLike,
} from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import { firstSymbolLayer } from '../lib/basemap';
import { colourExpression } from '../lib/colour';
import { anomalyPct, type Artifact, type CellGrid, type CellIndex, type RegionId } from '../lib/rainfall';
import { regionById } from '../lib/story';
import type { CameraReason, Focus, UnmetTrendStyle, ViewState } from '../lib/view';

setWorkerUrl(workerUrl);

export const MAX_BOUNDS: LngLatBoundsLike = [[108, 0], [134, 25]];
const PAPER = '#f7f7f7';
const INK = '#0d2a1c';
const BASE_OPACITY = 0.86;
const UNMET_TREND_OPACITY: Record<UnmetTrendStyle, number> = { faded: 0.28, ghost: 0.08 };
const CELL_ZOOM = 9.5;
const DURATION: Record<CameraReason, number> = { story: 1000, select: 500, reveal: 500 };
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const strongInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

export type MapEvents = {
  onManual(): void;
  onCellClick(cell: CellIndex): void;
  onTileError(): void;
  onCamera(camera: string): void;
};

export type RainMap = {
  render(state: ViewState): void;
  setCooperative(enabled: boolean): void;
  center(): [number, number];
  canvas(): HTMLCanvasElement;
};

type Applied = {
  mode: ViewState['mode'] | null;
  unmetTrendStyle: UnmetTrendStyle | null;
  year: number | null;
  emphasis: RegionId | null | undefined;
  selected: CellIndex | null | undefined;
  cameraRequest: number;
};

export function createMap(options: {
  container: HTMLElement;
  style: StyleSpecification;
  artifact: Artifact;
  grid: CellGrid;
  events: MapEvents;
  initialCameraRequest: number;
  onReady(cells: number): void;
}): RainMap {
  const { artifact: a, grid, events } = options;
  const map = new MapLibreMap({
    container: options.container,
    style: options.style,
    bounds: a.bounds,
    fitBoundsOptions: { padding: 32 },
    minZoom: 3.5,
    maxZoom: 11,
    maxBounds: MAX_BOUNDS,
    renderWorldCopies: false,
    maxPitch: 0,
    attributionControl: false,
    cooperativeGestures: false,
  });
  map.dragRotate.disable();
  map.touchZoomRotate.disableRotation();
  map.touchPitch.disable();
  map.keyboard.disableRotation();
  map.addControl(new NavigationControl({ showCompass: false }), 'top-right');
  map.addControl(new AttributionControl({ compact: false, customAttribution: 'Rainfall: NASA GPM IMERG via NASA POWER' }), 'bottom-right');

  let ready = false;
  let pending: ViewState | null = null;
  const applied: Applied = { mode: null, unmetTrendStyle: null, year: null, emphasis: undefined, selected: undefined, cameraRequest: options.initialCameraRequest };

  const features = grid.all.map((cell) => ({
    type: 'Feature' as const,
    id: cell,
    geometry: { type: 'Polygon' as const, coordinates: [grid.ring(cell)] },
    properties: {
      mean: a.cells.mean_mm[cell] ?? 0,
      trend: a.cells.sen_pct_decade[cell] ?? 0,
      enso: a.cells.jan_apr_enso_diff_pct[cell] ?? 0,
      meets: a.cells.meets[cell] ?? 0,
    },
  }));

  map.on('load', () => {
    const before = firstSymbolLayer(options.style);
    map.addSource('cells', { type: 'geojson', data: { type: 'FeatureCollection', features } });
    map.addSource('selected', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({ id: 'rain', type: 'fill', source: 'cells', paint: { 'fill-color': colourExpression(a, 'mean'), 'fill-opacity': BASE_OPACITY } }, before);
    map.addLayer({
      id: 'rain-edges', type: 'line', source: 'cells', minzoom: 8,
      paint: { 'line-color': PAPER, 'line-width': 0.5, 'line-opacity': ['interpolate', ['linear'], ['zoom'], 8, 0, 9, 0.6] },
    }, before);
    map.addLayer({ id: 'selected-casing', type: 'line', source: 'selected', paint: { 'line-color': PAPER, 'line-width': 5 } }, before);
    map.addLayer({ id: 'selected-line', type: 'line', source: 'selected', paint: { 'line-color': INK, 'line-width': 2.5 } }, before);
    ready = true;
    options.onReady(features.length);
    if (pending !== null) render(pending);
  });

  for (const type of ['wheel', 'pointerdown', 'touchstart', 'dblclick', 'keydown'] as const) {
    map.getContainer().addEventListener(type, () => events.onManual(), { passive: true });
  }
  map.on('moveend', () => {
    const c = map.getCenter();
    events.onCamera(`${c.lng.toFixed(4)},${c.lat.toFixed(4)},${map.getZoom().toFixed(4)}`);
  });
  map.on('click', 'rain', (event) => {
    const id = event.features?.[0]?.id;
    const cell = typeof id === 'number' ? grid.at(id) : null;
    if (cell !== null) events.onCellClick(cell);
  });
  map.on('mouseenter', 'rain', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'rain', () => { map.getCanvas().style.cursor = ''; });
  map.on('error', (event) => {
    if ('sourceId' in event && event.sourceId === 'openmaptiles') events.onTileError();
    else console.error('Map error', event.error);
  });

  function opacity(state: ViewState): ExpressionSpecification {
    const base: ExpressionSpecification | number = state.mode === 'trend'
      ? ['case', ['==', ['get', 'meets'], 1], BASE_OPACITY, UNMET_TREND_OPACITY[state.unmetTrendStyle]]
      : BASE_OPACITY;
    return ['*', base, ['case', ['boolean', ['feature-state', 'dim'], false], 0.25, 1]];
  }

  function applyYear(year: number) {
    const index = year - a.period.start;
    for (let i = 0; i < grid.count; i += 1) {
      const annual = a.cells.annual_mm[i * a.period.years.length + index] ?? 0;
      map.setFeatureState({ source: 'cells', id: i }, { a: anomalyPct(annual, a.cells.mean_mm[i] ?? 1) });
    }
  }

  function applyEmphasis(region: RegionId | null) {
    const members = region === null ? null : new Set(regionById(a, region).members);
    for (let i = 0; i < grid.count; i += 1) {
      map.setFeatureState({ source: 'cells', id: i }, { dim: members !== null && !members.has(i) });
    }
  }

  function move(focus: Focus, reason: CameraReason) {
    const duration = reduceMotion.matches ? 0 : DURATION[reason];
    const common = { duration, easing: strongInOut };
    switch (focus.kind) {
      case 'country':
        map.fitBounds(a.bounds, { ...common, padding: 32 });
        return;
      case 'region':
        map.fitBounds(regionById(a, focus.region).bounds, { ...common, padding: 48, maxZoom: 8.5 });
        return;
      case 'cell': {
        const center = grid.center(focus.cell);
        if (reason === 'reveal') {
          const point = map.project(center);
          const { width, height } = map.getContainer().getBoundingClientRect();
          const inside = point.x > width * 0.2 && point.x < width * 0.8 && point.y > height * 0.2 && point.y < height * 0.8;
          if (!inside) map.easeTo({ ...common, center });
          return;
        }
        map.easeTo({ ...common, center, zoom: Math.max(CELL_ZOOM, reason === 'select' ? map.getZoom() : CELL_ZOOM) });
        return;
      }
      default: {
        const unreachable: never = focus;
        return unreachable;
      }
    }
  }

  function render(state: ViewState) {
    if (!ready) {
      pending = state;
      return;
    }
    if (state.mode !== applied.mode) map.setPaintProperty('rain', 'fill-color', colourExpression(a, state.mode));
    if (state.mode !== applied.mode || state.unmetTrendStyle !== applied.unmetTrendStyle) map.setPaintProperty('rain', 'fill-opacity', opacity(state));
    if (state.mode === 'year' && state.year !== applied.year) {
      applyYear(state.year);
      applied.year = state.year;
    }
    applied.mode = state.mode;
    applied.unmetTrendStyle = state.unmetTrendStyle;

    const emphasis = state.hover ?? (state.focus.kind === 'region' ? state.focus.region : null);
    if (emphasis !== applied.emphasis) {
      applyEmphasis(emphasis);
      applied.emphasis = emphasis;
    }
    const selected = state.focus.kind === 'cell' ? state.focus.cell : null;
    if (selected !== applied.selected) {
      const source = map.getSource<GeoJSONSource>('selected');
      source?.setData({
        type: 'FeatureCollection',
        features: selected === null ? [] : [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [grid.ring(selected)] } }],
      });
      applied.selected = selected;
    }
    if (state.camera.request !== applied.cameraRequest) {
      move(state.camera.focus, state.camera.reason);
      applied.cameraRequest = state.camera.request;
    }
  }

  return {
    render,
    setCooperative(enabled) {
      if (enabled) map.cooperativeGestures.enable();
      else map.cooperativeGestures.disable();
    },
    center() {
      const c = map.getCenter();
      return [c.lng, c.lat];
    },
    canvas: () => map.getCanvas(),
  };
}
