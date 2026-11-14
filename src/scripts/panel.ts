import { chartHtml } from '../lib/chart';
import { explorerLegend } from '../lib/colour';
import { ensoText, placeChart, placeOf, trendText, type Place } from '../lib/place';
import type { Artifact, CellGrid } from '../lib/rainfall';
import { fmt } from '../lib/story';
import { COUNTRY, demoSteps, focusKey, type ViewState } from '../lib/view';
import { isFarm, signedC, VARIABLES, windowLabel } from '../lib/variable';

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
    meanLabel: one<HTMLElement>(root, '[data-mean-label]'),
    trend: one<HTMLElement>(root, '[data-fact="trend"]'),
    enso: one<HTMLElement>(root, '[data-fact="enso"]'),
    land: one<HTMLElement>(root, '[data-fact="land"]'),
    landRow: one<HTMLElement>(root, '[data-fact-row="land"]'),
    cropland: one<HTMLElement>(root, '[data-fact="cropland"]'),
    croplandRow: one<HTMLElement>(root, '[data-fact-row="cropland"]'),
  };
  const exploreChart = one<HTMLElement>(root, '[data-place-chart="explore"]');
  const storyChart = one<HTMLElement>(root, '[data-place-chart="story"]');
  const table = one<HTMLElement>(root, '[data-place-table]');
  const caption = one<HTMLElement>(root, '[data-place-caption]');
  const regionSelect = one<HTMLSelectElement>(root, '[data-region-select]');
  const explorerYear = one<HTMLElement>(root, '[data-explorer-year]');
  const variableSelect = one<HTMLSelectElement>(root, '[data-variable-select]');
  const windowSelect = one<HTMLSelectElement>(root, '[data-window-select]');
  const siteSelect = one<HTMLSelectElement>(root, '[data-site-select]');
  const coverage = one<HTMLElement>(root, '[data-variable-description]');
  const refit = one<HTMLElement>(root, '[data-refit]');
  const demo = one<HTMLElement>(root, '[data-demo]');
  const demoText = one<HTMLElement>(root, '[data-demo-text]');
  const demoPrev = one<HTMLButtonElement>(root, '[data-demo-prev]');
  const demoNext = one<HTMLButtonElement>(root, '[data-demo-next]');
  const steps = [...root.querySelectorAll<HTMLElement>('[data-chapter].step')];
  const navLinks = [...root.querySelectorAll<HTMLAnchorElement>('.chapter-nav a[data-goto]')];
  const modeInputs = [...root.querySelectorAll<HTMLInputElement>('input[name="mode"]')];
  const yearInputs = [...root.querySelectorAll<HTMLInputElement>('[data-year-input]')];
  const yearOutputs = [...root.querySelectorAll<HTMLOutputElement>('[data-year-output]')];
  const playButtons = [...root.querySelectorAll<HTMLButtonElement>('[data-play]')];
  const nationalPlace = placeOf(a, grid, COUNTRY);

  let shown: { legend: string; place: string; storyYear: number | null } = { legend: '', place: '', storyYear: null };

  function placeFor(state: ViewState): Place {
    return placeOf(a, grid, state.focus, state.variable, state.window);
  }

  function renderLegend(state: ViewState) {
    const key = `${state.variable}:${state.window}:${state.mode}:${state.mode === 'year' ? state.year : ''}`;
    if (key === shown.legend) return;
    const model = explorerLegend(a, state);
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
    const seasonal = state.window === 'jan_apr';
    const totals = seasonal ? place.janApr : place.annual;
    const key = `${state.variable}:${state.window}:${place.key}:${state.mode}:${selectedYear ?? ''}`;
    if (key === shown.place) return;
    placeHeading.textContent = place.heading;
    const format = (value: number) => state.variable === 'rain' ? fmt.mm(value) : `${value.toFixed(2)} °C`;
    facts.meanLabel.textContent = `Average ${windowLabel(state.window).toLowerCase()}`;
    facts.mean.textContent = format(seasonal ? place.janAprMean : place.mean);
    facts.trend.textContent = trendText(a, place);
    facts.enso.textContent = ensoText(place);
    one<HTMLElement>(root, '[data-fact-trend-label]').textContent = `25-year change, ${windowLabel(state.window).toLowerCase()}`;
    one<HTMLElement>(root, '[data-value-heading]').textContent = `${VARIABLES[state.variable].label}, ${VARIABLES[state.variable].unit}`;
    refit.hidden = place.refit === null;
    refit.textContent = place.refit === null ? '' : `Terra drift sensitivity check, 2001-2019. ${signedC(place.refit.sen_c_decade)} per decade, ${fmt.pSameSideOfAlpha(place.refit.p, place.refit.meets_threshold, a.alpha)}, ${place.refit.meets_threshold ? 'meets' : 'does not meet'} the unadjusted p < 0.05 test. This shorter refit excludes later orbit drift but also uses fewer years. It is not a corrected full-period estimate.`;
    facts.landRow.hidden = place.landPct === null;
    facts.land.textContent = place.landPct === null ? '' : `${place.landPct}%`;
    facts.croplandRow.hidden = place.croplandPct === null;
    facts.cropland.textContent = place.croplandPct === null ? '' : `${place.croplandPct}% of land pixels, 2020`;
    exploreChart.innerHTML = chartHtml(placeChart(a, place, selectedYear, state.mode));
    caption.textContent = `${place.heading}, ${windowLabel(state.window)} ${VARIABLES[state.variable].label.toLowerCase()} in ${VARIABLES[state.variable].unit}`;
    table.replaceChildren(...a.period.years.map((year, index) => {
      const row = document.createElement('tr');
      const th = document.createElement('th');
      th.scope = 'row';
      th.textContent = String(year);
      const mm = document.createElement('td');
      mm.textContent = format(totals[index] ?? 0);
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
    storyChart.innerHTML = chartHtml(placeChart(a, nationalPlace, year, 'year'));
    shown = { ...shown, storyYear: year };
  }

  return {
    enable() {
      root.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLFieldSetElement>(
        '[data-find], [data-country], [data-region-select], [data-modes], [data-year-input], [data-play], [data-variable-select], [data-window-select], [data-site-select], [data-demo-start]',
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
      ds.variable = state.variable;
      ds.window = state.window;
      ds.demo = state.demo ? `${state.demo.id}:${state.demo.step}` : '';
      variableSelect.value = state.variable;
      windowSelect.value = state.window;
      windowSelect.disabled = isFarm(state.variable) || state.mode === 'enso' || state.mode === 'farm';
      regionSelect.disabled = isFarm(state.variable);
      siteSelect.closest<HTMLElement>('[data-site-field]')!.hidden = !isFarm(state.variable);
      one<HTMLElement>(root, '[data-country]').textContent = isFarm(state.variable) ? 'Mean of 12 sites' : 'Whole country';
      siteSelect.value = state.focus.kind === 'site' ? String(state.focus.site) : '';
      const metadata = VARIABLES[state.variable];
      coverage.textContent = `${metadata.definition} ${metadata.coverage} Source: ${metadata.source}.`;
      one<HTMLElement>(root, '[data-map-source]').textContent = metadata.source;
      mapElement.setAttribute('aria-label', `${metadata.label} map. ${metadata.coverage} Arrow keys pan; select observations in the explorer.`);
      demo.hidden = state.demo === null;
      if (state.demo) {
        const steps = demoSteps({ artifact: a, pantabangan: grid.fromId(a.facts.focus.pantabangan_cell)! }, state.demo.id);
        const place = placeFor(state);
        demoText.textContent = `Step ${state.demo.step + 1} of ${steps.length}. ${steps[state.demo.step]!.text} ${place.heading}. ${state.mode === 'enso' ? ensoText(place) : trendText(a, place)}`;
        demoPrev.disabled = state.demo.step === 0;
        demoNext.disabled = state.demo.step === steps.length - 1;
      }
      ds.focus = focusKey(state.focus, grid.id);
      for (const step of steps) step.toggleAttribute('data-active', state.phase === 'story' && step.dataset.chapter === state.chapter);
      for (const link of navLinks) {
        if (state.phase === 'story' && link.dataset.goto === state.chapter) link.setAttribute('aria-current', 'step');
        else link.removeAttribute('aria-current');
      }
      mapElement.setAttribute('aria-describedby', state.phase === 'explore' ? 'explore-heading' : `h-${state.chapter}`);
      back.hidden = !(state.phase === 'story' && state.owner === 'reader');
      for (const input of modeInputs) {
        input.checked = input.value === state.mode;
        const supported = metadata.modes.some((mode) => mode === input.value);
        input.disabled = !supported;
        input.closest<HTMLElement>('label')!.hidden = !supported;
      }
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
        const summary = state.mode === 'enso' || state.mode === 'farm' ? ensoText(place) : trendText(a, place);
        readout.append(strong, ` ${summary} `, link);
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
