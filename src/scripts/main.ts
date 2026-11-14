import type { StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import { fallbackStyle, STYLE_TIMEOUT_MS, STYLE_URL, transformPositron } from '../lib/basemap';
import { cellAt, DATA_URL, decodeCells, parseArtifact, regionId, type Artifact, type AirIndex, type CellGrid, type CellIndex, type SiteIndex } from '../lib/rainfall';
import { fmt } from '../lib/story';
import { ensoText, trendText } from '../lib/place';
import { focusAt, isFarm, isVariable, VARIABLES, windowLabel } from '../lib/variable';
import {
  CHAPTER_IDS, COUNTRY, MODES, initialState, reduce,
  type Action, type ChapterId, type Context, type Focus, type Mode, type Selection, type ViewState,
} from '../lib/view';
import { createMap, type RainMap } from './map';
import { createPanel, type Panel } from './panel';

const root = document.querySelector<HTMLElement>('[data-rainfall-app]');
const desktop = matchMedia('(min-width: 900px)');
const coarse = matchMedia('(pointer: coarse)');
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const PLAY_MS = 800;
const SETTLE_MS = 120;
const ANNOUNCE_MS = 250;
const STEP_SEARCH = 10;

type Direction = 'n' | 's' | 'e' | 'w';
const ARROWS: Record<string, Direction> = { ArrowUp: 'n', ArrowDown: 's', ArrowRight: 'e', ArrowLeft: 'w' };
const OFFSETS: Record<Direction, [number, number]> = { n: [1, 0], s: [-1, 0], e: [0, 1], w: [0, -1] };
const DIRECTION_WORDS: Record<Direction, string> = { n: 'north', s: 'south', e: 'east', w: 'west' };
const GEO_ERRORS: Record<number, string> = {
  1: 'Location is off for this page. Choose a region instead.',
  2: 'Your browser could not find a location. Choose a region instead.',
  3: 'Your browser could not find a location. Choose a region instead.',
};

function isChapter(value: string | undefined): value is ChapterId {
  return CHAPTER_IDS.some((id) => id === value);
}
function isMode(value: string | undefined): value is Mode {
  return MODES.some((mode) => mode === value);
}

async function loadStyle(): Promise<{ style: StyleSpecification; basemap: 'ok' | 'fallback' }> {
  try {
    const response = await fetch(STYLE_URL, { signal: AbortSignal.timeout(STYLE_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`Style request failed with HTTP ${response.status}`);
    const style: StyleSpecification = await response.json();
    if (!Array.isArray(style.layers)) throw new Error('Style has no layers');
    return { style: transformPositron(style), basemap: 'ok' };
  } catch (error) {
    console.warn('Basemap style unavailable', error);
    return { style: fallbackStyle(), basemap: 'fallback' };
  }
}

async function loadArtifact(): Promise<Artifact> {
  const response = await fetch(DATA_URL);
  if (!response.ok) throw new Error(`Rainfall data request failed with HTTP ${response.status}`);
  return parseArtifact(await response.json());
}

function parseHash(hash: string, a: Artifact, grid: CellGrid): Selection | null {
  if (!hash.startsWith('#explore')) return null;
  const params = new URLSearchParams(hash.slice('#explore'.length).replace(/^&/, ''));
  const mode = params.get('mode') ?? '';
  const variable = params.get('variable') ?? 'rain';
  const cell = grid.fromId(params.get('cell') ?? '');
  const region = regionId.safeParse(params.get('region'));
  const airCell = a.air.cells.findIndex((c) => c.id === params.get('air'));
  const site = params.has('site') ? Number(params.get('site')) : -1;
  const focus: Focus = airCell >= 0 ? { kind: 'air-cell', cell: airCell as AirIndex }
    : Number.isInteger(site) && site >= 0 && site < a.farm.sites.length ? { kind: 'site', site: site as SiteIndex }
    : cell !== null ? { kind: 'cell', cell }
    : region.success && a.regions.some((r) => r.id === region.data) ? { kind: 'region', region: region.data } : COUNTRY;
  return { variable: isVariable(variable) ? variable : 'rain', window: params.get('window') === 'jan_apr' ? 'jan_apr' : 'annual',
    mode: isMode(mode) ? mode : 'mean', year: params.has('year') ? Number(params.get('year')) : a.period.start, focus };
}

function hashFor(state: ViewState, grid: CellGrid, a: Artifact): string {
  const parts = ['#explore', `variable=${state.variable}`, `window=${state.window}`, `mode=${state.mode}`];
  if (state.mode === 'year') parts.push(`year=${state.year}`);
  if (state.focus.kind === 'region') parts.push(`region=${state.focus.region}`);
  if (state.focus.kind === 'cell') parts.push(`cell=${grid.id(state.focus.cell)}`);
  if (state.focus.kind === 'air-cell') parts.push(`air=${encodeURIComponent(a.air.cells[state.focus.cell]!.id)}`);
  if (state.focus.kind === 'site') parts.push(`site=${state.focus.site}`);
  return parts.join('&');
}

function nearestCell(grid: CellGrid, lon: number, lat: number): CellIndex | null {
  let best: CellIndex | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const cell of grid.all) {
    const [x, y] = grid.center(cell);
    const distance = (x - lon) ** 2 + (y - lat) ** 2;
    if (distance < bestDistance) {
      best = cell;
      bestDistance = distance;
    }
  }
  return best;
}

function stepCell(grid: CellGrid, from: CellIndex, direction: Direction): CellIndex | null {
  const [row, col] = grid.rowCol(from);
  const [dRow, dCol] = OFFSETS[direction];
  for (let k = 1; k <= STEP_SEARCH; k += 1) {
    const found = grid.index(row + dRow * k, col + dCol * k);
    if (found !== null) return found;
  }
  return null;
}

function start(app: HTMLElement) {
  const mapMessage = app.querySelector<HTMLElement>('[data-map-message]');
  const status = app.querySelector<HTMLElement>('[data-status]');
  const alert = app.querySelector<HTMLElement>('[data-alert]');
  if (mapMessage) mapMessage.hidden = true;

  async function attempt() {
    app.dataset.state = 'loading';
    if (alert) alert.hidden = true;
    if (status) status.hidden = false;
    const stylePromise = loadStyle();
    let artifact: Artifact;
    try {
      artifact = await loadArtifact();
    } catch (error) {
      console.error('Rainfall data failed to load', error);
      app.dataset.state = 'error';
      if (status) status.hidden = true;
      if (alert) alert.hidden = false;
      const explorerAlert = app.querySelector<HTMLElement>('[data-explorer-alert]');
      if (explorerAlert) {
        explorerAlert.hidden = false;
        explorerAlert.textContent = 'The rainfall squares could not load, so the explorer is off. The numbers in the story come from the same data and are still correct.';
      }
      return;
    }
    run(app, artifact, stylePromise);
  }

  app.querySelector('[data-retry]')?.addEventListener('click', () => { void attempt(); });
  void attempt();
}

function run(app: HTMLElement, a: Artifact, stylePromise: Promise<{ style: StyleSpecification; basemap: 'ok' | 'fallback' }>) {
  const grid = decodeCells(a);
  const pantabangan = grid.fromId(a.facts.focus.pantabangan_cell);
  if (pantabangan === null) throw new Error('Pantabangan cell missing from the artifact');
  const ctx: Context = { artifact: a, pantabangan };
  const panel: Panel = createPanel(app, a, grid);
  let state = initialState(ctx);
  const initialCameraRequest = state.camera.request;
  let map: RainMap | null = null;
  let playTimer: number | undefined;
  let announceTimer: number | undefined;
  let pendingGoto: { chapter: ChapterId; until: number } | null = null;

  function dispatch(action: Action) {
    const previous = state;
    state = reduce(state, action, ctx);
    if (state === previous) return;
    panel.render(state);
    map?.render(state);
    map?.setCooperative(coarse.matches && state.phase === 'story');
    if (state.playing !== previous.playing) syncPlayback();
    if (state.phase === 'explore') history.replaceState(null, '', hashFor(state, grid, a));
    else if (previous.phase === 'explore' && location.hash.startsWith('#explore')) history.replaceState(null, '', location.pathname);
    if (previous.playing && !state.playing) panel.announce(yearAnnouncement());
  }

  function yearAnnouncement(): string {
    const index = state.year - a.period.start;
    const place = panel.place(state);
    const values = state.window === 'annual' ? place.annual : place.janApr;
    const value = values[index]!;
    return `${state.year}, ${place.heading}, ${windowLabel(state.window)} ${VARIABLES[state.variable].label}, ${state.variable === 'rain' ? fmt.mm(value) : `${value.toFixed(2)} °C`}.`;
  }

  function syncPlayback() {
    window.clearInterval(playTimer);
    if (state.playing) playTimer = window.setInterval(() => dispatch({ type: 'tick' }), PLAY_MS);
  }

  function select(focus: Focus, cameraReason: 'select' | 'reveal' | null) {
    if (state.variable === 'rain' && state.window === 'jan_apr' && state.mode === 'trend' && focus.kind === 'cell') {
      const region = a.regions[a.cells.region[focus.cell] ?? -1];
      if (!region) {
        panel.explorerAlert('January to April trends are available for regions, but this square has no assigned region.');
        return;
      }
      panel.explorerAlert(`January to April cell trends are unavailable. Showing the regional trend for ${region.name}.`);
    } else panel.explorerAlert(null);
    dispatch({ type: 'select', focus, cameraReason });
    window.clearTimeout(announceTimer);
    announceTimer = window.setTimeout(() => {
      const place = panel.place(state);
      panel.announce(`${place.heading}. ${state.mode === 'enso' ? ensoText(place) : trendText(a, place)}`);
    }, ANNOUNCE_MS);
  }

  panel.enable();
  panel.explorerAlert(null);
  panel.render(state);
  panel.status(`Loading ${fmt.count(a.cells.count)} rainfall squares…`);

  void stylePromise.then(({ style, basemap }) => {
    app.dataset.basemap = basemap === 'ok' ? 'loading' : 'fallback';
    const container = app.querySelector<HTMLElement>('#map');
    if (container === null) return;
    try {
      map = createMap({
        container, style, artifact: a, grid, initialCameraRequest,
        events: {
          onManual: () => dispatch({ type: 'manual-camera' }),
          onSelect: (focus) => select(focus, null),
          onTileError: () => {
            if (app.dataset.basemap === 'fallback') return;
            app.dataset.basemap = 'fallback';
            panel.status('Base map unavailable. The rainfall squares still show.');
          },
          onCamera: (camera) => { app.dataset.camera = camera; },
        },
        onReady: (cells) => {
          app.dataset.cells = String(cells);
          app.dataset.state = 'ready';
          if (app.dataset.basemap === 'loading') app.dataset.basemap = 'ok';
          panel.status(app.dataset.basemap === 'fallback' ? 'Base map unavailable. The rainfall squares still show.' : null);
        },
      });
      map.render(state);
      map.setCooperative(coarse.matches && state.phase === 'story');
    } catch (error) {
      console.error('Map could not start', error);
      app.dataset.state = 'no-map';
      panel.status(null);
      const message = app.querySelector<HTMLElement>('[data-map-message]');
      if (message) {
        message.hidden = false;
        message.textContent = 'Your browser cannot draw the interactive map. The story, the region table and the data file still work.';
      }
    }
  });

  const steps = [...app.querySelectorAll<HTMLElement>('.step[data-chapter]')];
  const explore = app.querySelector<HTMLElement>('#explore');
  let settleTimer: number | undefined;

  function activeFromLayout(): { phase: 'story'; chapter: ChapterId } | { phase: 'explore' } | null {
    const line = window.innerHeight * (desktop.matches ? 0.5 : 0.75);
    if (explore && explore.getBoundingClientRect().top <= line) return { phase: 'explore' };
    let active: ChapterId | null = null;
    for (const step of steps) {
      const chapter = step.dataset.chapter;
      if (step.getBoundingClientRect().top <= line && isChapter(chapter)) active = chapter;
    }
    return active === null ? null : { phase: 'story', chapter: active };
  }

  function onLayout() {
    window.clearTimeout(settleTimer);
    settleTimer = window.setTimeout(() => {
      const active = activeFromLayout();
      if (active === null) return;
      if (pendingGoto !== null) {
        if (active.phase === 'story' && active.chapter === pendingGoto.chapter) pendingGoto = null;
        else if (performance.now() < pendingGoto.until) return;
        else pendingGoto = null;
      }
      if (active.phase === 'explore') dispatch({ type: 'enter-explore' });
      else dispatch({ type: 'scroll-chapter', chapter: active.chapter });
    }, SETTLE_MS);
  }

  let observer: IntersectionObserver | null = null;
  function observe() {
    observer?.disconnect();
    observer = new IntersectionObserver(onLayout, { rootMargin: desktop.matches ? '-45% 0px -45% 0px' : '-72% 0px -22% 0px' });
    for (const step of steps) observer.observe(step);
    if (explore) observer.observe(explore);
  }
  observe();
  desktop.addEventListener('change', observe);

  function goToChapter(chapter: ChapterId) {
    pendingGoto = { chapter, until: performance.now() + 2000 };
    dispatch({ type: 'resume-chapter', chapter });
    const heading = document.getElementById(`h-${chapter}`);
    document.getElementById(`ch-${chapter}`)?.scrollIntoView({ behavior: reduceMotion.matches ? 'auto' : 'smooth', block: 'start' });
    if (heading) {
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
  }

  app.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const demoStart = target.closest<HTMLElement>('[data-demo-start]')?.dataset.demoStart;
    if (demoStart === 'rain-air' || demoStart === 'farm') { dispatch({ type: 'start-demo', id: demoStart }); return; }
    if (target.closest('[data-demo-prev]')) { dispatch({ type: 'demo-step', delta: -1 }); return; }
    if (target.closest('[data-demo-next]')) { dispatch({ type: 'demo-step', delta: 1 }); return; }
    if (target.closest('[data-demo-exit]')) { dispatch({ type: 'exit-demo' }); return; }
    const goto = target.closest<HTMLElement>('[data-goto]');
    const chapter = goto?.dataset.goto;
    if (goto && isChapter(chapter)) {
      event.preventDefault();
      history.replaceState(null, '', `#ch-${chapter}`);
      goToChapter(chapter);
      return;
    }
    if (target.closest('[data-back]')) {
      dispatch({ type: 'resume-chapter', chapter: state.chapter });
      return;
    }
    const regionButton = target.closest<HTMLElement>('[data-region-button]');
    const region = regionId.safeParse(regionButton?.dataset.regionButton);
    if (regionButton && region.success) {
      select({ kind: 'region', region: region.data }, 'select');
      explore?.scrollIntoView({ behavior: reduceMotion.matches ? 'auto' : 'smooth', block: 'start' });
      return;
    }
    if (target.closest('[data-country]')) select(COUNTRY, 'select');
    const play = target.closest('[data-play]');
    if (play) dispatch({ type: state.playing ? 'pause' : 'play' });
  });

  for (const row of app.querySelectorAll<HTMLElement>('tr[data-region]')) {
    const region = regionId.safeParse(row.dataset.region);
    if (!region.success) continue;
    const enter = () => dispatch({ type: 'hover-region', region: region.data });
    const leave = () => dispatch({ type: 'hover-region', region: null });
    row.addEventListener('pointerenter', enter);
    row.addEventListener('pointerleave', leave);
    row.addEventListener('focusin', enter);
    row.addEventListener('focusout', leave);
  }

  if (matchMedia('(hover: hover)').matches) {
    app.addEventListener('pointerover', (event) => {
      const bar = event.target instanceof SVGRectElement && event.target.dataset.year ? event.target : null;
      const chart = bar?.closest<HTMLElement>('[data-chart]');
      const tag = chart?.querySelector<HTMLElement>('.chart-tag');
      const svg = bar?.ownerSVGElement;
      if (!bar || !tag || !svg) return;
      const width = svg.viewBox.baseVal.width || 1;
      const x = Number(bar.getAttribute('x')) + Number(bar.getAttribute('width')) / 2;
      const value = Number(bar.dataset.value);
      tag.textContent = `${bar.dataset.year}, ${bar.dataset.unit === '°C' ? `${value.toFixed(2)} °C` : fmt.mm(value)}${bar.dataset.enso === 'true' ? ', began in El Niño' : ''}`;
      tag.style.left = `${(x / width) * 100}%`;
      tag.dataset.instant = tag.hidden ? 'false' : 'true';
      tag.hidden = false;
    });
    app.addEventListener('pointerout', (event) => {
      if (!(event.target instanceof SVGRectElement)) return;
      const related = event.relatedTarget;
      if (related instanceof SVGRectElement && related.dataset.year) return;
      event.target.closest('[data-chart]')?.querySelector<HTMLElement>('.chart-tag')?.setAttribute('hidden', '');
    });
  }

  app.addEventListener('input', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;
    if (target.matches('[data-variable-select]') && isVariable(target.value)) {
      dispatch({ type: 'set-variable', variable: target.value });
      panel.announce(`${VARIABLES[state.variable].label}. ${VARIABLES[state.variable].coverage}`);
      return;
    }
    if (target.matches('[data-window-select]')) {
      dispatch({ type: 'set-window', window: target.value === 'jan_apr' ? 'jan_apr' : 'annual' });
      return;
    }
    if (target.matches('[data-site-select]')) {
      const site = Number(target.value);
      select(target.value !== '' && Number.isInteger(site) && a.farm.sites[site] ? { kind: 'site', site: site as SiteIndex } : COUNTRY, 'select');
      return;
    }
    if (target instanceof HTMLInputElement && target.matches('[data-year-input]')) {
      dispatch({ type: 'set-year', year: Number(target.value) });
      if (!state.playing) panel.announce(yearAnnouncement());
    } else if (target instanceof HTMLInputElement && target.name === 'mode' && isMode(target.value)) {
      dispatch({ type: 'set-mode', mode: target.value });
    } else if (target instanceof HTMLSelectElement && target.matches('[data-region-select]')) {
      const region = regionId.safeParse(target.value);
      select(region.success && target.value !== '' ? { kind: 'region', region: region.data } : COUNTRY, 'select');
    }
  });

  const place = app.querySelector<HTMLElement>('[data-place]');
  place?.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      select(COUNTRY, 'select');
      return;
    }
    const direction = ARROWS[event.key];
    if (direction === undefined) return;
    event.preventDefault();
    if (state.variable !== 'rain') {
      const points = state.variable === 'air' ? a.air.cells : a.farm.sites;
      const selected = state.focus.kind === 'air-cell' ? state.focus.cell : state.focus.kind === 'site' ? state.focus.site : null;
      const origin = selected === null ? map?.center() ?? [121, 13] : [points[selected]!.lon, points[selected]!.lat];
      const [dy, dx] = OFFSETS[direction];
      const candidates = points.map((point, i) => ({ i, x: point.lon - origin[0]!, y: point.lat - origin[1]! }))
        .filter((p) => selected === null || p.x * dx + p.y * dy > 0)
        .sort((p, q) => (p.x * p.x + p.y * p.y) - (q.x * q.x + q.y * q.y));
      const next = candidates[0]?.i;
      if (next === undefined) panel.announce(`No observation further ${DIRECTION_WORDS[direction]}.`);
      else select(state.variable === 'air' ? { kind: 'air-cell', cell: next as AirIndex } : { kind: 'site', site: next as SiteIndex }, 'reveal');
      return;
    }
    if (state.focus.kind !== 'cell') {
      const [lon, lat] = map?.center() ?? grid.center(pantabangan);
      const first = cellAt(grid, lon, lat) ?? nearestCell(grid, lon, lat);
      if (first !== null) select({ kind: 'cell', cell: first }, 'reveal');
      return;
    }
    const next = stepCell(grid, state.focus.cell, direction);
    if (next === null) panel.announce(`No square further ${DIRECTION_WORDS[direction]}.`);
    else select({ kind: 'cell', cell: next }, 'reveal');
  });

  function findMySquare() {
    panel.explorerAlert(null);
    if (!('geolocation' in navigator)) {
      panel.explorerAlert(GEO_ERRORS[2] ?? '');
      return;
    }
    navigator.geolocation.getCurrentPosition((position) => {
      if (state.variable !== 'rain') {
        const focus = focusAt(a, state.variable, position.coords.longitude, position.coords.latitude);
        if (focus === null) panel.explorerAlert(`No ${isFarm(state.variable) ? 'sampled cropland site' : 'MERRA-2 land cell'} covers your location. Choose a mapped observation instead.`);
        else select(focus, 'select');
        return;
      }
      const cell = cellAt(grid, position.coords.longitude, position.coords.latitude);
      if (cell === null) {
        panel.explorerAlert('That location is outside the mapped squares.');
        return;
      }
      select({ kind: 'cell', cell }, 'select');
    }, (error) => {
      panel.explorerAlert(GEO_ERRORS[error.code] ?? GEO_ERRORS[2] ?? '');
    }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 });
  }

  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-find]')) {
    button.addEventListener('click', () => {
      explore?.scrollIntoView({ behavior: reduceMotion.matches ? 'auto' : 'smooth', block: 'start' });
      findMySquare();
    });
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && state.playing) dispatch({ type: 'pause' });
  });

  const deepLink = parseHash(location.hash, a, grid);
  if (deepLink !== null) {
    dispatch({ type: 'restore', selection: deepLink });
    explore?.scrollIntoView({ block: 'start' });
  } else {
    const initialChapter = location.hash.startsWith('#ch-') ? location.hash.slice(4) : undefined;
    if (isChapter(initialChapter)) goToChapter(initialChapter);
    else onLayout();
  }
  window.addEventListener('hashchange', () => {
    if (location.hash === '#explore') {
      dispatch({ type: 'enter-explore' });
      history.replaceState(null, '', hashFor(state, grid, a));
      return;
    }
    const link = parseHash(location.hash, a, grid);
    if (link) {
      dispatch({ type: 'restore', selection: link });
      explore?.scrollIntoView({ block: 'start' });
    }
  });
}

if (root !== null) start(root);
