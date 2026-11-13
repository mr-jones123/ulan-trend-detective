import { chartHtml } from '../lib/chart';
import { legendModel } from '../lib/colour';
import { placeChart, placeOf, type Place } from '../lib/place';
import type { Artifact, CellGrid } from '../lib/rainfall';
import { fmt, TEST_WORDS } from '../lib/story';
import { COUNTRY, focusKey, type ViewState } from '../lib/view';

export type Panel = {
  enable(): void;
  render(state: ViewState): void;
  status(text: string | null): void;
  dataError(visible: boolean): void;
  explorerAlert(text: string | null): void;
  announce(text: string): void;
  place(state: ViewState): Place;
};

function one<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (element === null) throw new Error(`Missing element ${selector}`);
  return element;
}

export function createPanel(root: HTMLElement, a: Artifact, grid: CellGrid): Panel {
  const legend = one<HTMLElement>(root, '[data-legend]');
  const legendTitle = one<HTMLElement>(legend, '[data-legend-title]');
  const legendSwatches = one<HTMLOListElement>(legend, '[data-legend-swatches]');
  const legendEnds = one<HTMLElement>(legend, '[data-legend-ends]');
  const legendFaded = one<HTMLElement>(legend, '[data-legend-faded]');
  const status = one<HTMLElement>(root, '[data-status]');
  const alert = one<HTMLElement>(root, '[data-alert]');
  const readout = one<HTMLElement>(root, '[data-readout]');
  const back = one<HTMLButtonElement>(root, '[data-back]');
  const mapElement = one<HTMLElement>(root, '#map');
  const live = one<HTMLElement>(root, '[data-live]');
  const explorerAlert = one<HTMLElement>(root, '[data-explorer-alert]');
  const placeHeading = one<HTMLElement>(root, '[data-place-heading]');
  const facts = {
    mean: one<HTMLElement>(root, '[data-fact="mean"]'),
    trend: one<HTMLElement>(root, '[data-fact="trend"]'),
    enso: one<HTMLElement>(root, '[data-fact="enso"]'),
    land: one<HTMLElement>(root, '[data-fact="land"]'),
    landRow: one<HTMLElement>(root, '[data-fact-row="land"]'),
  };
  const exploreChart = one<HTMLElement>(root, '[data-place-chart="explore"]');
  const storyChart = one<HTMLElement>(root, '[data-place-chart="story"]');
  const table = one<HTMLElement>(root, '[data-place-table]');
  const caption = one<HTMLElement>(root, '[data-place-caption]');
  const regionSelect = one<HTMLSelectElement>(root, '[data-region-select]');
  const explorerYear = one<HTMLElement>(root, '[data-explorer-year]');
  const steps = [...root.querySelectorAll<HTMLElement>('[data-chapter].step')];
  const navLinks = [...root.querySelectorAll<HTMLAnchorElement>('.chapter-nav a[data-goto]')];
  const modeInputs = [...root.querySelectorAll<HTMLInputElement>('input[name="mode"]')];
  const yearInputs = [...root.querySelectorAll<HTMLInputElement>('[data-year-input]')];
  const yearOutputs = [...root.querySelectorAll<HTMLOutputElement>('[data-year-output]')];
  const playButtons = [...root.querySelectorAll<HTMLButtonElement>('[data-play]')];
  const nationalPlace = placeOf(a, grid, COUNTRY);

  let shown: { legend: string; place: string; storyYear: number | null } = { legend: '', place: '', storyYear: null };

  function placeFor(state: ViewState): Place {
    return placeOf(a, grid, state.focus);
  }

  function renderLegend(state: ViewState) {
    const key = `${state.mode}:${state.mode === 'year' ? state.year : ''}`;
    if (key === shown.legend) return;
    const model = legendModel(a, state.mode, state.year);
    legend.dataset.mode = state.mode;
    legend.setAttribute('aria-label', model.title);
    legendTitle.textContent = model.title;
    legendSwatches.replaceChildren(...model.classes.map((item) => {
      const li = document.createElement('li');
      li.dataset.swatch = '';
      const swatch = document.createElement('span');
      swatch.className = 'swatch';
      swatch.style.background = item.colour;
      const label = document.createElement('span');
      label.textContent = item.label;
      li.append(swatch, label);
      return li;
    }));
    const [low, high] = legendEnds.querySelectorAll('span');
    if (low) low.textContent = model.ends[0];
    if (high) high.textContent = model.ends[1];
    legendFaded.hidden = state.mode !== 'trend';
    shown = { ...shown, legend: key };
  }

  function renderPlace(state: ViewState) {
    const place = placeFor(state);
    const selectedYear = state.mode === 'year' ? state.year : null;
    const key = `${place.key}:${selectedYear ?? ''}`;
    if (key === shown.place) return;
    placeHeading.textContent = place.heading;
    const signedMm = `${place.senPerDecade > 0 ? '+' : place.senPerDecade < 0 ? '\u2212' : ''}${fmt.mm(Math.abs(place.senPerDecade))}`;
    facts.mean.textContent = fmt.mm(place.mean);
    facts.trend.textContent = `${fmt.signedPct(place.pctDecade)} per decade (${signedMm}), ${place.meets ? TEST_WORDS.meets : TEST_WORDS.chance}, ${fmt.pSameSideOfAlpha(place.p, place.meets, a.alpha)}`;
    facts.enso.textContent = `${fmt.signedPct(place.ensoDiffPct)} against other years`;
    facts.landRow.hidden = place.landPct === null;
    facts.land.textContent = place.landPct === null ? '' : `${place.landPct}%`;
    exploreChart.innerHTML = chartHtml(placeChart(a, place, selectedYear));
    caption.textContent = `${place.heading}, annual rainfall in mm`;
    table.replaceChildren(...a.period.years.map((year, index) => {
      const row = document.createElement('tr');
      const th = document.createElement('th');
      th.scope = 'row';
      th.textContent = String(year);
      const mm = document.createElement('td');
      mm.textContent = fmt.mm(place.annual[index] ?? 0);
      const enso = document.createElement('td');
      enso.textContent = a.enso.began_el_nino[index] ? 'began in El Niño' : '';
      row.append(th, mm, enso);
      return row;
    }));
    regionSelect.value = state.focus.kind === 'region' ? state.focus.region : '';
    shown = { ...shown, place: key };
  }

  function renderStoryChart(state: ViewState) {
    const year = state.mode === 'year' ? state.year : null;
    if (year === shown.storyYear) return;
    storyChart.innerHTML = chartHtml(placeChart(a, nationalPlace, year));
    shown = { ...shown, storyYear: year };
  }

  return {
    enable() {
      root.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLFieldSetElement>(
        '[data-find], [data-country], [data-region-select], [data-modes], [data-year-input], [data-play]',
      ).forEach((control) => { control.disabled = false; });
      document.querySelectorAll<HTMLButtonElement>('[data-find]').forEach((button) => { button.disabled = false; });
    },
    render(state) {
      const ds = root.dataset;
      ds.phase = state.phase;
      ds.chapter = state.chapter;
      ds.owner = state.owner;
      ds.mode = state.mode;
      ds.year = String(state.year);
      ds.focus = focusKey(state.focus, grid.id);
      for (const step of steps) step.toggleAttribute('data-active', state.phase === 'story' && step.dataset.chapter === state.chapter);
      for (const link of navLinks) {
        if (state.phase === 'story' && link.dataset.goto === state.chapter) link.setAttribute('aria-current', 'step');
        else link.removeAttribute('aria-current');
      }
      mapElement.setAttribute('aria-describedby', state.phase === 'explore' ? 'explore-heading' : `h-${state.chapter}`);
      back.hidden = !(state.phase === 'story' && state.owner === 'reader');
      for (const input of modeInputs) input.checked = input.value === state.mode;
      explorerYear.hidden = state.mode !== 'year';
      const yearText = a.enso.years.includes(state.year) ? `${state.year}, began in El Niño` : String(state.year);
      for (const input of yearInputs) input.value = String(state.year);
      for (const output of yearOutputs) output.textContent = yearText;
      for (const button of playButtons) {
        button.setAttribute('aria-pressed', String(state.playing));
        button.textContent = state.playing ? 'Pause' : 'Play';
      }
      renderLegend(state);
      renderPlace(state);
      renderStoryChart(state);
      const place = placeFor(state);
      readout.hidden = state.phase !== 'story' || state.focus.kind === 'country' || state.owner !== 'reader';
      if (!readout.hidden) {
        readout.innerHTML = '';
        const strong = document.createElement('strong');
        strong.textContent = place.heading;
        const link = document.createElement('a');
        link.href = '#explore';
        link.textContent = 'Open in the explorer';
        readout.append(strong, ` ${fmt.mm(place.mean)} in an average year, ${fmt.signedPct(place.pctDecade)} per decade. `, link);
      }
    },
    status(text) {
      status.hidden = text === null;
      status.textContent = text ?? '';
      legend.setAttribute('aria-busy', String(text !== null && root.dataset.state === 'loading'));
    },
    dataError(visible) {
      alert.hidden = !visible;
    },
    explorerAlert(text) {
      explorerAlert.hidden = text === null;
      explorerAlert.textContent = text ?? '';
    },
    announce(text) {
      live.textContent = text;
    },
    place: placeFor,
  };
}
