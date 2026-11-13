import { fmt } from './story';

export type ChartInput = {
  readonly key: string;
  readonly name: string;
  readonly years: readonly number[];
  readonly annual: readonly number[];
  readonly enso: readonly boolean[];
  readonly mean: number;
  readonly senPerDecade: number;
  readonly mid: number;
  readonly pctDecade: number;
  readonly p: number;
  readonly meets: boolean;
  readonly alpha: number;
  readonly selectedYear: number | null;
};

const SLOT = 10;
const BAR = 7;
const HEIGHT = 100;
const CENTER_YEAR = 2013;
const TICKS = [2001, 2010, 2020, 2025];

const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

export function chartHtml(c: ChartInput): string {
  const first = c.years[0] ?? CENTER_YEAR;
  const last = c.years[c.years.length - 1] ?? CENTER_YEAR;
  const perYear = c.senPerDecade / 10;
  const lineAt = (year: number) => c.mid + perYear * (year - CENTER_YEAR);
  const top = Math.max(...c.annual, lineAt(first), lineAt(last)) * 1.12;
  const y = (mm: number) => HEIGHT - (HEIGHT * Math.max(0, mm)) / top;
  const width = SLOT * c.years.length;
  const xCenter = (index: number) => index * SLOT + SLOT / 2;
  const tallest = c.annual.indexOf(Math.max(...c.annual));

  const bars = c.years.map((year, index) => {
    const mm = c.annual[index] ?? 0;
    const enso = c.enso[index] ?? false;
    const selected = year === c.selectedYear;
    return `<rect data-year="${year}" data-mm="${Math.round(mm)}" data-enso="${enso}" x="${index * SLOT + (SLOT - BAR) / 2}" y="${y(mm).toFixed(2)}" width="${BAR}" height="${(HEIGHT - y(mm)).toFixed(2)}" class="${enso ? 'bar-enso' : 'bar-other'}${selected ? ' bar-selected' : ''}"></rect>`;
  }).join('');
  const line = `<line data-slope="${c.senPerDecade}" x1="${xCenter(0)}" y1="${y(lineAt(first)).toFixed(2)}" x2="${xCenter(c.years.length - 1)}" y2="${y(lineAt(last)).toFixed(2)}" class="${c.meets ? 'trend-meets' : 'trend-chance'}" vector-effect="non-scaling-stroke"></line>`;
  const pct = (index: number) => ((xCenter(index) / width) * 100).toFixed(2);
  const ticks = TICKS.map((year) => `<span style="left:${pct(year - first)}%">${year}</span>`).join('');
  const trendLabel = c.meets ? `${fmt.signedPct(c.pctDecade)} per decade` : `could be chance, ${fmt.pSameSideOfAlpha(c.p, c.meets, c.alpha)}`;
  const selectedIndex = c.selectedYear === null ? -1 : c.years.indexOf(c.selectedYear);
  const selectedLabel = selectedIndex < 0 || selectedIndex === tallest ? ''
    : `<span class="chart-value chart-value-selected" style="left:${pct(selectedIndex)}%;bottom:${(100 - y(c.annual[selectedIndex] ?? 0)).toFixed(2)}%">${fmt.mm(c.annual[selectedIndex] ?? 0)}</span>`;
  const label = `${c.name}: 25 annual totals, average ${fmt.mm(c.mean)}, change ${fmt.signedPct(c.pctDecade)} per decade, ${c.meets ? 'meets the p < 0.05 test' : 'could be chance'}`;

  return `<div class="chart" data-chart data-series="${escape(c.key)}">`
    + '<p class="chart-key"><span class="key-enso">began in El Niño</span><span class="key-other">other years</span></p>'
    + `<div class="chart-plot" role="img" aria-label="${escape(label)}">`
    + `<svg viewBox="0 0 ${width} ${HEIGHT}" preserveAspectRatio="none" aria-hidden="true" focusable="false">`
    + `<line x1="0" y1="${HEIGHT}" x2="${width}" y2="${HEIGHT}" class="baseline" vector-effect="non-scaling-stroke"></line>${bars}${line}</svg>`
    + `<span class="chart-value" style="left:${pct(tallest)}%;bottom:${(100 - y(c.annual[tallest] ?? 0)).toFixed(2)}%">${fmt.mm(c.annual[tallest] ?? 0)}</span>`
    + selectedLabel
    + `<span class="chart-trend${c.meets ? '' : ' chart-trend-chance'}" style="bottom:${(100 - y(lineAt(last))).toFixed(2)}%">${escape(trendLabel)}</span>`
    + `<span class="chart-tag" hidden></span>`
    + '</div>'
    + `<div class="chart-ticks" aria-hidden="true">${ticks}</div>`
    + `<p class="chart-summary">Fitted change ${fmt.signedPct(c.pctDecade)} per decade (${fmt.pSameSideOfAlpha(c.p, c.meets, c.alpha)}), ${c.meets ? 'meets the unadjusted p < 0.05 test' : 'could be chance'}.</p>`
    + '</div>';
}
