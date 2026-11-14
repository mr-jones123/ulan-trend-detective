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
import { colourExpression, temperatureColour } from '../lib/colour';
import { anomalyPct, type Artifact, type AirIndex, type CellGrid, type SiteIndex, type RegionId } from '../lib/rainfall';
import { regionById } from '../lib/story';
import { focusKey, type CameraReason, type Focus, type UnmetTrendStyle, type ViewState } from '../lib/view';
import { temperatureSeries, VARIABLES } from '../lib/variable';

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
  onSelect(focus: Focus): void;
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
  layerKey: string;
  variable: ViewState['variable'] | null;
  emphasis: RegionId | null | undefined;
  selected: string;
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
  let attribution = new AttributionControl({ compact: false, customAttribution: VARIABLES.rain.source });
  map.addControl(attribution, 'bottom-right');

  let ready = false;
  let pending: ViewState | null = null;
  const applied: Applied = { layerKey: '', variable: 'rain', emphasis: undefined, selected: '', cameraRequest: options.initialCameraRequest };

  const features = grid.all.map((cell) => ({
    type: 'Feature' as const,
    id: cell,
    geometry: { type: 'Polygon' as const, coordinates: [grid.ring(cell)] },
    properties: {
      mean: a.cells.mean_mm[cell] ?? 0,
      trend: a.cells.sen_pct_decade[cell] ?? 0,
      enso: a.cells.jan_apr_enso_diff_pct[cell] ?? 0,
      meets: a.cells.meets[cell] ?? 0,
      cropland: a.cells.cropland_pct[cell] ?? 0,
    },
  }));

  map.on('load', () => {
    const before = firstSymbolLayer(options.style);
    map.addSource('cells', { type: 'geojson', data: { type: 'FeatureCollection', features } });
    map.addSource('selected', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addSource('temperature', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({ id: 'temperature', type: 'fill', source: 'temperature', layout: { visibility: 'none' },
      paint: { 'fill-color': temperatureColour('mean'), 'fill-opacity': BASE_OPACITY } }, before);
    map.addLayer({ id: 'temperature-edges', type: 'line', source: 'temperature', layout: { visibility: 'none' },
      paint: { 'line-color': PAPER, 'line-width': 1 } }, before);
    map.addSource('farm-sites', { type: 'geojson', data: {
      type: 'FeatureCollection', features: a.farm.sites.map((site) => ({
        type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [site.outline] },
      })),
    } });
    map.addLayer({ id: 'rain', type: 'fill', source: 'cells', paint: { 'fill-color': colourExpression(a, 'mean'), 'fill-opacity': BASE_OPACITY } }, before);
    map.addLayer({
      id: 'rain-edges', type: 'line', source: 'cells', minzoom: 8,
      paint: { 'line-color': PAPER, 'line-width': 0.5, 'line-opacity': ['interpolate', ['linear'], ['zoom'], 8, 0, 9, 0.6] },
    }, before);
    map.addLayer({ id: 'selected-casing', type: 'line', source: 'selected', paint: { 'line-color': PAPER, 'line-width': 5 } }, before);
    map.addLayer({ id: 'selected-line', type: 'line', source: 'selected', paint: { 'line-color': INK, 'line-width': 2.5 } }, before);
    map.addLayer({ id: 'farm-sites', type: 'line', source: 'farm-sites', layout: { visibility: 'none' },
      paint: { 'line-color': INK, 'line-width': 1.5, 'line-dasharray': [3, 2] } }, before);
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
    if (cell !== null) {
      const regionIndex = a.cells.region[cell];
      const region = regionIndex === undefined ? undefined : a.regions[regionIndex];
      events.onSelect(current?.variable === 'rain' && current.window === 'jan_apr' && current.mode === 'trend'
        ? region ? { kind: 'region', region: region.id } : { kind: 'country' }
        : { kind: 'cell', cell });
    }
  });
  map.on('mouseenter', 'rain', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'rain', () => { map.getCanvas().style.cursor = ''; });
  map.on('click', 'temperature', (event) => {
    const id = event.features?.[0]?.id;
    if (typeof id !== 'number' || !current) return;
    events.onSelect(current.variable === 'air' ? { kind: 'air-cell', cell: id as AirIndex } : { kind: 'site', site: id as SiteIndex });
  });
  map.on('mouseenter', 'temperature', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'temperature', () => { map.getCanvas().style.cursor = ''; });
  map.on('error', (event) => {
    if ('sourceId' in event && event.sourceId === 'openmaptiles') events.onTileError();
    else console.error('Map error', event.error);
  });

  function opacity(state: ViewState): ExpressionSpecification {
    const base: ExpressionSpecification | number = state.mode === 'trend'
      ? ['case', ['==', ['get', 'meets'], 1], BASE_OPACITY, UNMET_TREND_OPACITY[state.unmetTrendStyle]]
      : state.mode === 'farm'
        ? ['case', ['>=', ['get', 'cropland'], a.farm.map_threshold_pct], BASE_OPACITY, 0.06]
        : BASE_OPACITY;
    return ['*', base, ['coalesce', ['get', 'coverage'], 1], ['case', ['boolean', ['feature-state', 'dim'], false], 0.25, 1]];
  }

  function applyRain(state: ViewState) {
    const seasonal = state.window === 'jan_apr';
    const index = state.year - a.period.start;
    const next = features.map((feature, i) => {
      const region = a.regions[a.cells.region[i] ?? -1];
      const mean = seasonal ? a.cells.jan_apr_mean_mm[i]! : a.cells.mean_mm[i]!;
      return { ...feature, properties: { ...feature.properties, mean,
        trend: seasonal ? region?.jan_apr.sen_pct_decade ?? 0 : feature.properties.trend,
        meets: seasonal ? Number(region?.jan_apr.meets_threshold ?? false) : feature.properties.meets,
        coverage: seasonal && state.mode === 'trend' && region === undefined ? 0 : 1,
      } };
    });
    map.getSource<GeoJSONSource>('cells')?.setData({ type: 'FeatureCollection', features: next });
    for (let i = 0; i < grid.count; i += 1) {
      const values = seasonal ? a.cells.jan_apr_mm : a.cells.annual_mm;
      const mean = seasonal ? a.cells.jan_apr_mean_mm[i]! : a.cells.mean_mm[i]!;
      map.setFeatureState({ source: 'cells', id: i }, { a: anomalyPct(values[i * a.period.years.length + index]!, mean) });
    }
  }

  function ring(focus: Focus): number[][] | null {
    if (focus.kind === 'cell') return grid.ring(focus.cell);
    if (focus.kind === 'site') return a.farm.sites[focus.site]!.outline;
    if (focus.kind === 'air-cell') {
      const [w, s, e, n] = a.air.cells[focus.cell]!.bounds;
      return [[w, s], [e, s], [e, n], [w, n], [w, s]];
    }
    return null;
  }

  function applyTemperature(state: ViewState) {
    const count = state.variable === 'air' ? a.air.cells.length : a.farm.sites.length;
    const temperatureFeatures = Array.from({ length: count }, (_, i) => {
      const focus: Focus = state.variable === 'air' ? { kind: 'air-cell', cell: i as AirIndex } : { kind: 'site', site: i as SiteIndex };
      const s = temperatureSeries(a, { ...state, focus });
      const region = state.hover ?? (state.focus.kind === 'region' ? state.focus.region : null);
      const members = state.variable === 'air' && region ? a.air.regions.find((r) => r.id === region)?.members : null;
      const value = state.mode === 'mean' ? s.mean_c : state.mode === 'trend' ? s.sen_c_decade
        : state.mode === 'enso' ? s.enso_diff_c : s.c[state.year - a.period.start]! - s.mean_c;
      return { type: 'Feature' as const, id: i, properties: { value, meets: Number(s.meets_threshold), dim: Number(members != null && !members.includes(i)) },
        geometry: { type: 'Polygon' as const, coordinates: [ring(focus)!] } };
    });
    map.getSource<GeoJSONSource>('temperature')?.setData({ type: 'FeatureCollection', features: temperatureFeatures });
    map.setPaintProperty('temperature', 'fill-color', temperatureColour(state.mode));
    map.setPaintProperty('temperature', 'fill-opacity', ['*', state.mode === 'trend'
      ? ['case', ['==', ['get', 'meets'], 1], BASE_OPACITY, 0.28] : BASE_OPACITY, ['case', ['==', ['get', 'dim'], 1], 0.25, 1]]);
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
      case 'air-cell':
        map.fitBounds(a.air.cells[focus.cell]!.bounds, { ...common, padding: 48, maxZoom: 8.5 });
        return;
      case 'site': {
        const site = a.farm.sites[focus.site]!;
        map.easeTo({ ...common, center: [site.lon, site.lat], zoom: 9 });
        return;
      }
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

  let current: ViewState | null = null;
  function render(state: ViewState) {
    current = state;
    if (!ready) {
      pending = state;
      return;
    }
    const temperatureRegion = state.variable === 'rain' ? '' : state.hover ?? (state.focus.kind === 'region' ? state.focus.region : '');
    const layerKey = `${state.variable}:${state.window}:${state.mode}:${state.mode === 'year' ? state.year : ''}:${state.unmetTrendStyle}:${temperatureRegion}`;
    if (layerKey !== applied.layerKey) {
      const rain = state.variable === 'rain';
      map.setLayoutProperty('rain', 'visibility', rain ? 'visible' : 'none');
      map.setLayoutProperty('rain-edges', 'visibility', rain ? 'visible' : 'none');
      map.setLayoutProperty('temperature', 'visibility', rain ? 'none' : 'visible');
      map.setLayoutProperty('temperature-edges', 'visibility', rain ? 'none' : 'visible');
      map.setLayoutProperty('farm-sites', 'visibility', rain && state.mode === 'farm' ? 'visible' : 'none');
      if (rain) {
        applyRain(state);
        map.setPaintProperty('rain', 'fill-color', colourExpression(a, state.mode, state.window));
        map.setPaintProperty('rain', 'fill-opacity', opacity(state));
      } else applyTemperature(state);
      if (state.variable !== applied.variable) {
        map.removeControl(attribution);
        attribution = new AttributionControl({ compact: false, customAttribution: VARIABLES[state.variable].source });
        map.addControl(attribution, 'bottom-right');
        applied.variable = state.variable;
      }
      applied.layerKey = layerKey;
    }
    const emphasis = state.hover ?? (state.focus.kind === 'region' ? state.focus.region : null);
    if (emphasis !== applied.emphasis) {
      applyEmphasis(emphasis);
      applied.emphasis = emphasis;
    }
    const selected = `${state.variable}:${focusKey(state.focus, grid.id)}`;
    if (selected !== applied.selected) {
      const source = map.getSource<GeoJSONSource>('selected');
      const outline = ring(state.focus);
      source?.setData({
        type: 'FeatureCollection',
        features: outline === null ? [] : [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [outline] } }],
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
