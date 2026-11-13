import { fmt } from './story';

export type ChartInput = {
  readonly key: string;
  readonly name: string;
  readonly years: readonly number[];
  readonly totals: readonly number[];
  readonly period: 'annual' | 'January to April';
  readonly summary: string;
  readonly enso: readonly boolean[];
  readonly mean: number;
  readonly trend: {
    readonly senPerDecade: number;
    readonly mid: number;
    readonly label: string;
    readonly p: number;
    readonly meets: boolean;
    readonly alpha: number;
  } | null;
  readonly selectedYear: number | null;
} & (
  | { readonly unit: 'mm'; readonly baseline: 'zero' }
  | { readonly unit: '°C'; readonly baseline: 'mean' }
);

const SLOT = 10;
const BAR = 7;
const HEIGHT = 100;
const CENTER_YEAR = 2013;
const TICKS = [2001, 2010, 2020, 2025];

const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

export function chartHtml(c: ChartInput): string {
  const first = c.years[0] ?? CENTER_YEAR;
  const last = c.years[c.years.length - 1] ?? CENTER_YEAR;
  const trend = c.trend;
  const valueLabel = (value: number) => c.unit === 'mm' ? fmt.mm(value) : `${value.toFixed(2)} °C`;
  const lineAt = (year: number) => trend === null ? 0 : trend.mid + trend.senPerDecade / 10 * (year - CENTER_YEAR);
  const anomaly = c.baseline === 'mean';
  const origin = anomaly ? c.mean : 0;
  const extent = anomaly ? Math.max(...c.totals.map((value) => Math.abs(value - origin)),
    ...(trend === null ? [] : [Math.abs(lineAt(first) - origin), Math.abs(lineAt(last) - origin)])) : 0;
  const top = anomaly ? Math.max(0.5, Math.ceil(extent * 2) / 2)
    : Math.max(...c.totals, lineAt(first), lineAt(last)) * 1.12;
  const bottom = anomaly ? -top : 0;
  const y = (value: number) => anomaly
    ? HEIGHT - HEIGHT * ((value - origin - bottom) / (top - bottom))
    : HEIGHT - (HEIGHT * Math.max(0, value)) / top;
  const baselineY = y(origin);
  const baselineLabel = `Difference from the ${first}-${last} mean of ${valueLabel(c.mean)}. Zero line marks the mean.`;
  const width = SLOT * c.years.length;
  const xCenter = (index: number) => index * SLOT + SLOT / 2;
  const tallest = c.totals.indexOf(Math.max(...c.totals));

  const bars = c.years.map((year, index) => {
    const value = c.totals[index] ?? 0;
    const enso = c.enso[index] ?? false;
    const selected = year === c.selectedYear;
    return `<rect data-year="${year}" data-value="${value}" data-unit="${c.unit}" data-enso="${enso}" x="${index * SLOT + (SLOT - BAR) / 2}" y="${Math.min(y(value), baselineY).toFixed(2)}" width="${BAR}" height="${Math.abs(baselineY - y(value)).toFixed(2)}" class="${enso ? 'bar-enso' : 'bar-other'}${selected ? ' bar-selected' : ''}"></rect>`;
  }).join('');
  const line = trend === null ? '' : `<line data-slope="${trend.senPerDecade}" x1="${xCenter(0)}" y1="${y(lineAt(first)).toFixed(2)}" x2="${xCenter(c.years.length - 1)}" y2="${y(lineAt(last)).toFixed(2)}" class="${trend.meets ? 'trend-meets' : 'trend-chance'}" vector-effect="non-scaling-stroke"></line>`;
  const pct = (index: number) => ((xCenter(index) / width) * 100).toFixed(2);
  const ticks = TICKS.map((year) => `<span style="left:${pct(year - first)}%">${year}</span>`).join('');
  const trendLabel = trend?.label ?? '';
  const selectedIndex = c.selectedYear === null ? -1 : c.years.indexOf(c.selectedYear);
  const selectedLabel = anomaly || selectedIndex < 0 || selectedIndex === tallest ? ''
    : `<span class="chart-value chart-value-selected" style="left:${pct(selectedIndex)}%;bottom:${(100 - y(c.totals[selectedIndex] ?? 0)).toFixed(2)}%">${valueLabel(c.totals[selectedIndex] ?? 0)}</span>`;
  const label = anomaly
    ? `${c.name}: ${c.years.length} ${c.period} temperature anomalies in °C. ${baselineLabel} ${c.summary}`
    : `${c.name}: 25 ${c.period} values, average ${valueLabel(c.mean)}. ${c.summary}`;

  return `<div class="chart" data-chart data-series="${escape(c.key)}">`
    + '<p class="chart-key"><span class="key-enso">began in El Niño</span><span class="key-other">other years</span></p>'
    + (anomaly ? `<p class="chart-summary">${escape(baselineLabel)}</p><p style="margin:0" aria-hidden="true">+${valueLabel(top)}</p>` : '')
    + `<div class="chart-plot" role="img" aria-label="${escape(label)}">`
    + `<svg viewBox="0 0 ${width} ${HEIGHT}" preserveAspectRatio="none" aria-hidden="true" focusable="false">`
    + `<line x1="0" y1="${baselineY}" x2="${width}" y2="${baselineY}" class="baseline" vector-effect="non-scaling-stroke"></line>${bars}${line}</svg>`
    + (anomaly ? '' : `<span class="chart-value" style="left:${pct(tallest)}%;bottom:${(100 - y(c.totals[tallest] ?? 0)).toFixed(2)}%">${valueLabel(c.totals[tallest] ?? 0)}</span>`)
    + selectedLabel
    + (trend === null || anomaly ? '' : `<span class="chart-trend${trend.meets ? '' : ' chart-trend-chance'}" style="bottom:${(100 - y(lineAt(last))).toFixed(2)}%">${escape(trendLabel)}</span>`)
    + `<span class="chart-tag" hidden></span>`
    + '</div>'
    + (anomaly ? `<p style="margin:0" aria-hidden="true">${valueLabel(bottom)}</p>` : '')
    + `<div class="chart-ticks" aria-hidden="true">${ticks}</div>`
    + (anomaly && trend !== null ? `<p class="chart-summary" data-trend-label>Fitted trend ${escape(trendLabel)}.</p>` : '')
    + `<p class="chart-summary">${escape(c.summary)}</p>`
    + '</div>';
}
