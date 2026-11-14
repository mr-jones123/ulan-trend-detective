import type { Artifact, Direction, Region, RegionId, Series } from './rainfall';

const WHOLE = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const MINUS = '\u2212';

export const fmt = {
  mm: (value: number) => `${WHOLE.format(Math.round(value))} mm`,
  count: (value: number) => WHOLE.format(value),
  pct: (value: number) => `${Math.abs(value).toFixed(1)}%`,
  signedPct(value: number): string {
    const shown = Math.abs(value).toFixed(1);
    if (shown === '0.0') return '0.0%';
    return `${value > 0 ? '+' : MINUS}${shown}%`;
  },
  share: (value: number) => `${(100 * value).toFixed(1)}%`,
  pSameSideOfAlpha(p: number, meets: boolean, alpha: number): string {
    for (let digits = 2; digits <= 6; digits += 1) {
      const shown = Number(p.toFixed(digits));
      if (shown === 0) return `p < ${(10 ** -digits).toFixed(digits)}`;
      if (shown < alpha === meets) return `p = ${p.toFixed(digits)}`;
    }
    return `p = ${p.toFixed(6)}`;
  },
  list(items: readonly string[]): string {
    if (items.length <= 2) return items.join(' and ');
    return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
  },
  lat: (value: number) => `${Math.abs(value).toFixed(2)}° ${value >= 0 ? 'N' : 'S'}`,
  lon: (value: number) => `${Math.abs(value).toFixed(2)}° ${value >= 0 ? 'E' : 'W'}`,
};

export function perDecade(value: number): string {
  const shown = fmt.pct(value);
  return shown === '0.0%' && value !== 0 ? '0.0% per decade, which rounds to zero at this precision' : `${shown} per decade`;
}

export type TrendVerdict = 'rise_meets' | 'fall_meets' | 'rise' | 'fall' | 'zero';
export type ClaimDirection = 'up' | 'down' | 'none' | 'mixed';

export function trendVerdict(s: Pick<Series, 'direction' | 'meets_threshold'>): TrendVerdict {
  switch (s.direction) {
    case 'up': return s.meets_threshold ? 'rise_meets' : 'rise';
    case 'down': return s.meets_threshold ? 'fall_meets' : 'fall';
    case 'zero': return 'zero';
    default: {
      const unreachable: never = s.direction;
      return unreachable;
    }
  }
}

export const TEST_WORDS: Record<'meets' | 'chance', string> = {
  meets: 'meets the p < 0.05 test',
  chance: 'could be chance',
};

const TREND_DIRECTION: Record<TrendVerdict, ClaimDirection> = {
  rise_meets: 'up', rise: 'up', fall_meets: 'down', fall: 'down', zero: 'none',
};

const TREND_HEADING: Record<TrendVerdict, string> = {
  rise_meets: 'A rise that meets the test',
  fall_meets: 'A fall that meets the test',
  rise: 'A rise that could be chance',
  fall: 'A fall that could be chance',
  zero: 'The fitted slope is zero',
};

export const CLAIM_IDS = [
  'standfirst-enso', 'standfirst-trend', 'rain', 'driest', 'wettest', 'swing', 'enso', 'enso-land',
  'enso-region', 'pantabangan-enso', 'pantabangan-2024', 'trend', 'trend-where', 'trend-where-other',
  'trend-region', 'next-year', 'audit', 'season-window', 'pantabangan-context', 'pantabangan-limit',
  'comparison-limit', 'method-totals', 'method-weights', 'method-enso', 'method-limits',
  'farm-rain', 'farm-day', 'farm-night', 'farm-sites', 'farm-drift', 'farm-context', 'farm-limit', 'farm-chart', 'method-farm', 'giovanni', 'farm-night-air', 'farm-green', 'farm-green-trend', 'farm-green-chart', 'climate', 'climate-enso', 'climate-method',
] as const;
export type ClaimId = (typeof CLAIM_IDS)[number];

export type Claim = {
  readonly id: ClaimId;
  readonly verdict: string;
  readonly direction: ClaimDirection;
  readonly heading?: string;
  readonly text: string;
};
export type Claims = Readonly<Record<ClaimId, Claim>>;

export function regionById(a: Artifact, id: RegionId): Region {
  const region = a.regions.find((r) => r.id === id);
  if (region === undefined) throw new Error(`Unknown region ${id}`);
  return region;
}

function regionNames(a: Artifact, ids: readonly RegionId[]): string {
  return fmt.list(ids.map((id) => regionById(a, id).name));
}

function trendSentence(subject: string, s: Series, alpha: number): { verdict: TrendVerdict; text: string } {
  const verdict = trendVerdict(s);
  const p = fmt.pSameSideOfAlpha(s.p, s.meets_threshold, alpha);
  const size = `${perDecade(s.sen_pct_decade)} (${fmt.mm(Math.abs(s.sen_mm_decade))})`;
  const chance = `but years swing so much that chance could give a slope this size (${p}). It does not meet the unadjusted p < 0.05 test.`;
  switch (verdict) {
    case 'rise_meets': return { verdict, text: `${subject}, yearly rain rose ${size}. That meets the unadjusted p < 0.05 test (${p}).` };
    case 'fall_meets': return { verdict, text: `${subject}, yearly rain fell ${size}. That meets the unadjusted p < 0.05 test (${p}).` };
    case 'rise': return { verdict, text: `${subject}, yearly rain rose ${size}, ${chance}` };
    case 'fall': return { verdict, text: `${subject}, yearly rain fell ${size}, ${chance}` };
    case 'zero': return { verdict, text: `${subject}, the fitted 25-year slope is zero (${p}).` };
    default: {
      const unreachable: never = verdict;
      return unreachable;
    }
  }
}

function ensoBelow(e: Series['enso'], noun: string, baseline: string): { text: string; direction: 'up' | 'down' } {
  const group = noun === '' ? `${e.group_size}` : `${e.group_size} ${noun}`;
  if (e.below_mean === 0) return { text: `All ${group} were at or above ${baseline}.`, direction: 'up' };
  const subject = e.below_mean === e.group_size ? `All ${group}` : `${e.below_mean} of the ${group}`;
  return { text: `${subject} had less rain than ${baseline}.`, direction: 'down' };
}

function gapClaim(id: ClaimId, direction: Direction, texts: Record<Direction, string>): Claim {
  const claimDirection: Record<Direction, ClaimDirection> = { up: 'up', down: 'down', zero: 'none' };
  return { id, verdict: direction, direction: claimDirection[direction], text: texts[direction] };
}

export function buildClaims(a: Artifact): Claims {
  const n = a.national;
  const f = a.facts;
  const { alpha } = a;
  const enso = n.jan_apr.enso;
  const annualGap = {
    down: `${fmt.pct(n.enso.diff_pct)} less across the whole year`,
    up: `${fmt.pct(n.enso.diff_pct)} more across the whole year`,
    zero: 'no difference across the whole year',
  }[n.enso.direction];
  const seasonalGap = {
    down: `${fmt.pct(enso.diff_pct)} less rain`,
    up: `${fmt.pct(enso.diff_pct)} more rain`,
    zero: 'the same rain',
  }[enso.direction];
  const regionCount = a.regions.length;
  const total = f.shares.total_count;
  const counts = f.shares.count;
  const area = f.shares.area;
  const began = (year: number) => (a.enso.years.includes(year) ? 'It began in El Niño.' : 'It did not begin in El Niño.');
  const each = (ids: readonly RegionId[]) => (ids.length > 1 ? ' each' : '');

  const trend = trendSentence('Nationally', n, alpha);
  const standfirstEnso = ensoBelow(enso, 'years that began in El Niño', 'the 2001-2025 January to April average');
  const nextYear = ensoBelow(enso, 'years in this record that began in El Niño', 'the 2001-2025 national January to April average');

  const ensoIntro = `${enso.group_size} of the 25 years began in El Niño by this page's rule, a December-to-February ONI of +0.5 °C or more: ${fmt.list(a.enso.years.map(String))}.`;
  const ensoMeans = `From January to April, they averaged ${fmt.mm(enso.mean_mm)} nationally`;
  const ensoBelowText = ensoBelow(enso, '', 'the 2001-2025 January to April average').text;
  const ensoClaim: Record<Direction, Claim> = {
    down: { id: 'enso', verdict: 'down', direction: 'down', heading: 'El Niño, less rain from January to April',
      text: `${ensoIntro} ${ensoMeans}, ${fmt.pct(enso.diff_pct)} less than the other ${enso.other_size} years' ${fmt.mm(enso.other_mean_mm)}. ${ensoBelowText}` },
    up: { id: 'enso', verdict: 'up', direction: 'mixed', heading: 'El Niño, more rain from January to April',
      text: `${ensoIntro} ${ensoMeans}, ${fmt.pct(enso.diff_pct)} more than the other ${enso.other_size} years' ${fmt.mm(enso.other_mean_mm)}. ${ensoBelowText}` },
    zero: { id: 'enso', verdict: 'zero', direction: 'mixed', heading: 'January to April matched the other years',
      text: `${ensoIntro} ${ensoMeans}, the same as the other ${enso.other_size} years. ${ensoBelowText}` },
  };

  const ensoIds = f.focus.enso_region;
  const ensoLead = regionById(a, ensoIds[0]);
  const ensoNames = regionNames(a, ensoIds);
  const less = f.regions_enso_less;
  const lessCount = less === regionCount ? `All ${less} regions` : less === 0 ? 'No region' : `${less} of the ${regionCount} regions`;
  const ensoRegionClaim: Record<Direction, Claim> = {
    down: { id: 'enso-region', verdict: 'down', direction: 'down',
      heading: ensoIds.length > 1 ? `${ensoIds.length} regions share the widest gap` : `${ensoLead.name} had the widest gap`,
      text: `From January to April in ${ensoNames}, El Niño-start years averaged ${fmt.pct(ensoLead.jan_apr.enso.diff_pct)} less rain than other years, the widest gap among the ${regionCount} regions. ${lessCount} had less rain in that window.` },
    up: { id: 'enso-region', verdict: 'up', direction: 'up', heading: 'Every region had more rain in El Niño years',
      text: `From January to April in ${ensoNames}, where El Niño-start years compare lowest against other years, those years averaged ${fmt.pct(ensoLead.jan_apr.enso.diff_pct)} more rain.` },
    zero: { id: 'enso-region', verdict: 'zero', direction: 'none', heading: 'No region stood apart in El Niño years',
      text: `From January to April in ${ensoNames}, where El Niño-start years compare lowest against other years, the two averages are equal.` },
  };

  const pan = f.pantabangan;
  const pan2024 = `From January to April 2024, the same square received ${fmt.mm(pan.jan_apr_mm_2024)}`;

  const baseline = `If nothing were changing and squares were independent, about ${Math.round(alpha * 100)}% of land would meet the test by chance. Neighbouring squares move together, so that share is only a rough guide.`;
  const ranked = (list: Artifact['facts']['meeting_regions']['up']) =>
    list.length === 0 ? '' : ` The regions with the largest share of their land in such squares are ${fmt.list(list.map((r) => `${regionById(a, r.id).name} (${fmt.share(r.share)})`))}.`;
  const trendWhere: Claim = counts.meets_up === 0 && counts.meets_down === 0
    ? { id: 'trend-where', verdict: 'none', direction: 'none', heading: 'No square meets the test',
      text: `No square's 25-year change meets the unadjusted p < 0.05 test in either direction. ${baseline}` }
    : counts.meets_down === 0
      ? { id: 'trend-where', verdict: 'up_only', direction: 'up', heading: 'Where the rise meets the test',
        text: `${fmt.share(area.meets_up)} of land lies in the ${fmt.count(counts.meets_up)} squares whose rise meets the unadjusted p < 0.05 test.${ranked(f.meeting_regions.up)} ${baseline}` }
      : counts.meets_up === 0
        ? { id: 'trend-where', verdict: 'down_only', direction: 'down', heading: 'Where the fall meets the test',
          text: `${fmt.share(area.meets_down)} of land lies in the ${fmt.count(counts.meets_down)} squares whose fall meets the unadjusted p < 0.05 test.${ranked(f.meeting_regions.down)} ${baseline}` }
        : { id: 'trend-where', verdict: 'both', direction: 'mixed', heading: 'Rises and falls that meet the test',
          text: `${fmt.share(area.meets_up)} of land lies in squares whose rise meets the unadjusted p < 0.05 test and ${fmt.share(area.meets_down)} in squares whose fall does. ${baseline}` };
  const oneSided = (counts.meets_up === 0) !== (counts.meets_down === 0);
  const trendWhereOther: Claim = oneSided
    ? { id: 'trend-where-other', verdict: 'none_other', direction: 'none',
      text: `None of the ${fmt.count(total)} squares meets the test in the other direction.` }
    : { id: 'trend-where-other', verdict: 'counts', direction: 'none',
      text: `Counted by squares, ${fmt.count(counts.meets_up + counts.meets_down)} of the ${fmt.count(total)} meet the test.` };

  const trendIds = f.focus.trend_region;
  const trendSentences = trendIds.map((id) => trendSentence(`In ${regionById(a, id).name}`, regionById(a, id), alpha));
  const trendDirections = [...new Set(trendSentences.map((s) => TREND_DIRECTION[s.verdict]))];
  const meeting = f.regions_meeting;
  const meetingText = meeting.length === 0
    ? `None of the ${regionCount} regions meets the test.`
    : `${meeting.length} of the ${regionCount} regions meet the test: ${regionNames(a, meeting)}.`;
  const trendTie = trendIds.length > 1 ? `${regionNames(a, trendIds)} share the largest fitted change of the ${regionCount} regions. ` : '';

  const audit = a.provenance.source_audit;
  const peak = audit.years.indexOf(audit.max_ratio_year);
  const [lowRatio, highRatio] = audit.other_ratio_range;
  const swing = f.swing;
  const wettestIds = f.focus.wettest_mean_region;
  const driestIds = f.focus.driest_mean_region;
  const farm = a.farm;
  const farmGap = farm.rain.enso;
  const day = farm.day;
  const night = farm.night;
  const nightVerdict = trendVerdict(night);
  const thermalWord: Record<Direction, string> = { up: 'warmer', down: 'cooler', zero: 'unchanged' };
  const temperatureGap = day.enso_direction === 'zero' ? 'had the same daytime surface temperature'
    : `were ${Math.abs(day.enso_diff_c).toFixed(2)} °C ${thermalWord[day.enso_direction]} by day`;
  const nightChange = night.direction === 'zero' ? 'has a zero fitted slope'
    : `${night.direction === 'up' ? 'rose' : 'fell'} ${Math.abs(night.sen_c_decade).toFixed(2)} °C per decade`;
  const refit = night.refit;
  const refitChange = refit.direction === 'zero' ? 'a zero slope'
    : `${refit.direction === 'up' ? '+' : '−'}${Math.abs(refit.sen_c_decade).toFixed(2)} °C per decade`;

  const claims: Claims = {
    'standfirst-enso': { id: 'standfirst-enso', verdict: enso.direction,
      direction: enso.direction === n.enso.direction && enso.direction === standfirstEnso.direction ? standfirstEnso.direction : 'mixed',
      text: `El Niño-start years averaged ${seasonalGap} from January to April, against ${annualGap}. ${standfirstEnso.text}` },
    'standfirst-trend': { id: 'standfirst-trend', verdict: trend.verdict, direction: TREND_DIRECTION[trend.verdict],
      text: trend.verdict === 'zero' ? 'The fitted 25-year slope is zero.'
        : `The 25-year ${TREND_DIRECTION[trend.verdict] === 'up' ? 'rise' : 'fall'}, ${perDecade(n.sen_pct_decade)}, ${n.meets_threshold ? 'meets the unadjusted p < 0.05 test' : 'could still be chance'}.` },
    rain: { id: 'rain', verdict: 'fixed', direction: 'none',
      text: `Each square is one IMERG cell, 0.1° on a side, about 11 km. An average year from 2001 to 2025 brought ${fmt.mm(n.mean_mm)} across the country. ${regionNames(a, wettestIds)} got the most, ${fmt.mm(regionById(a, wettestIds[0]).mean_mm)}${each(wettestIds)}. ${regionNames(a, driestIds)} got the least, ${fmt.mm(regionById(a, driestIds[0]).mean_mm)}${each(driestIds)}.` },
    driest: { id: 'driest', verdict: 'down', direction: 'down', heading: `${n.driest.year} was the driest year`,
      text: `Nationally, ${n.driest.year} brought ${fmt.mm(n.driest.mm)}, ${fmt.pct(n.driest.anomaly_pct)} below the 2001-2025 average. ${began(n.driest.year)}` },
    wettest: { id: 'wettest', verdict: 'up', direction: 'up', heading: `${n.wettest.year} was the wettest year`,
      text: `Nationally, ${n.wettest.year} brought ${fmt.mm(n.wettest.mm)}, ${fmt.pct(n.wettest.anomaly_pct)} above the 2001-2025 average. ${began(n.wettest.year)}` },
    swing: swing.range_exceeds_trend
      ? { id: 'swing', verdict: 'range', direction: 'none', heading: "One year's swing beats 25 years",
        text: `The driest and wettest years were ${fmt.mm(swing.range_mm)} apart. Along the fitted trend line, the national total changed by ${fmt.mm(swing.trend_change_mm)} from 2001 to 2025. Press Play to watch the years.` }
      : { id: 'swing', verdict: 'trend', direction: 'none', heading: 'The trend outgrew the swings',
        text: `Along the fitted trend line, the national total changed by ${fmt.mm(swing.trend_change_mm)} from 2001 to 2025, more than the ${fmt.mm(swing.range_mm)} between the driest and wettest years. Press Play to watch the years.` },
    enso: ensoClaim[enso.direction],
    'enso-land': a.cells.jan_apr_enso_sign.every((sign) => sign === -1)
      ? { id: 'enso-land', verdict: 'all', direction: 'down',
        text: `Every one of the ${fmt.count(a.cells.count)} squares had less rain from January to April in El Niño-start years than in other years.` }
      : { id: 'enso-land', verdict: f.enso_less_area_share >= 0.5 ? 'majority' : 'minority', direction: 'down',
        text: `${f.enso_less_area_share >= 0.5 ? '' : 'Only '}${fmt.share(f.enso_less_area_share)} of land had less rain from January to April in El Niño-start years than in other years.` },
    'enso-region': ensoRegionClaim[ensoLead.jan_apr.enso.direction],
    'pantabangan-enso': gapClaim('pantabangan-enso', pan.jan_apr_enso_direction, {
      down: `In the square over the lake, El Niño-start years averaged ${fmt.pct(pan.jan_apr_enso_diff_pct)} less rain from January to April than other years.`,
      up: `In the square over the lake, El Niño-start years averaged ${fmt.pct(pan.jan_apr_enso_diff_pct)} more rain from January to April than other years.`,
      zero: 'In the square over the lake, El Niño-start years averaged the same rain from January to April as other years.',
    }),
    'pantabangan-2024': gapClaim('pantabangan-2024', pan.jan_apr_direction_2024, {
      down: `${pan2024}, ${fmt.pct(pan.jan_apr_anomaly_2024_pct)} below its 2001-2025 January to April average of ${fmt.mm(pan.jan_apr_mean_mm)}.`,
      up: `${pan2024}, ${fmt.pct(pan.jan_apr_anomaly_2024_pct)} above its 2001-2025 January to April average of ${fmt.mm(pan.jan_apr_mean_mm)}.`,
      zero: `${pan2024}, equal to its 2001-2025 January to April average.`,
    }),
    'farm-rain': {
      ...gapClaim('farm-rain', farmGap.direction, {
        down: `Across cropland-weighted IMERG squares, January to April rain averaged ${fmt.pct(farmGap.diff_pct)} less in El Niño-start years than in other years, ${fmt.mm(farmGap.mean_mm)} against ${fmt.mm(farmGap.other_mean_mm)}.`,
        up: `Across cropland-weighted IMERG squares, January to April rain averaged ${fmt.pct(farmGap.diff_pct)} more in El Niño-start years than in other years, ${fmt.mm(farmGap.mean_mm)} against ${fmt.mm(farmGap.other_mean_mm)}.`,
        zero: 'Across cropland-weighted IMERG squares, January to April rain averaged the same in El Niño-start years and other years.',
      }),
      heading: 'Farmland in El Niño-start years',
    },
    'farm-day': { id: 'farm-day', verdict: day.enso_direction,
      direction: day.enso_direction === 'zero' ? 'none' : day.enso_direction,
      text: `Across ${farm.sites.length} cropland sites, January to April fields ${temperatureGap} in El Niño-start years ${day.enso_direction === 'zero' ? 'as' : 'than'} in other years. This is an equal-weight mean of the outlined sites, not every farm in the country.` },
    'farm-night': { id: 'farm-night', verdict: nightVerdict, direction: TREND_DIRECTION[nightVerdict],
      heading: night.meets_threshold && !night.refit.meets_threshold
        ? (nightVerdict === 'rise_meets' ? 'Warmer farm nights, or a drifting satellite?' : 'Cooler farm nights, or a drifting satellite?')
        : { rise_meets: 'Farm nights are warming', fall_meets: 'Farm nights are cooling',
          rise: 'Farm nights could be warming', fall: 'Farm nights could be cooling', zero: 'Farm nights have no fitted change' }[nightVerdict],
      text: `The site-mean January to April night surface temperature ${nightChange} over 2001-2025. It ${night.meets_threshold ? 'meets' : 'does not meet'} the unadjusted p < 0.05 test (${fmt.pSameSideOfAlpha(night.p, night.meets_threshold, alpha)}).` },
    'farm-sites': { id: 'farm-sites', verdict: farm.night_rising_meets === 0 ? 'none' : 'up',
      direction: farm.night_rising_meets === 0 ? 'none' : 'up',
      text: farm.night_rising_meets === 0 ? 'No site has a positive night slope that meets the test.'
        : `At ${farm.night_rising_meets} of ${farm.sites.length} sites, a rising night slope meets the test.` },
    'farm-drift': { id: 'farm-drift', verdict: trendVerdict(refit), direction: 'none',
      text: `Terra's orbit drift after 2020 moved its overpasses earlier. Refitting only 2001-2019 gives ${refitChange} (${fmt.pSameSideOfAlpha(refit.p, refit.meets_threshold, alpha)}), which ${refit.meets_threshold ? 'meets' : 'does not meet'} the test. The full-record result cannot separate climate from changing observation time.` },
    ...greenClaims(farm, alpha),
    ...climateClaims(a),
    'farm-night-air': nightAirClaim(farm.night, farm.night_air, alpha),
    'farm-context': { id: 'farm-context', verdict: 'context-only', direction: 'mixed',
      text: 'Peng and colleagues reported in 2004 that dry-season rice grain yield at IRRI in Los Baños fell about 10% per 1 °C of higher minimum air temperature. Their January to April field study is context, not a conversion from these satellite observations to Philippine yield loss.' },
    'farm-limit': { id: 'farm-limit', verdict: 'fixed', direction: 'none',
      text: 'MODIS measures land surface temperature under clear skies, not air temperature. Clouds hide observations, and the sites are selected for cropland density, not as a representative national sample. A fixed 2020 cropland mask does not track land-use change. These comparisons are descriptive, not evidence that El Niño caused each difference.' },
    'farm-chart': { id: 'farm-chart', verdict: 'fixed', direction: 'none',
      text: 'January to April clear-sky surface temperature, equal-weight site mean.' },
    'method-farm': { id: 'method-farm', verdict: 'fixed', direction: 'none',
      text: `MCD12Q1 LC_Type1 class 12 in 2020 defines cropland. Each square's integer share counts cropland among 500 m pixel centres inside ADM0. Rain weights multiply land weight by that share. Squares with at least ${farm.map_threshold_pct}% cropland are visible in the farmland view; the rest are ghosted. The ${farm.sites.length} densest half-degree cropland cells are selected greedily, with at least 1° separation in latitude or longitude. MOD11A2 day and night windows extend 25 km each way. A 1 km pixel counts as cropland when at least three of its four 500 m pixels are class 12. Each 8-day composite needs valid values in at least 30% of its cropland pixels. We average retained composites starting on days 001 through 113, then give each site equal weight. Temperatures use the same Sen and Mann-Kendall methods as annual rain, in °C per decade. The 2001-2019 refit excludes the period of Terra's orbit drift.` },
    trend: { id: 'trend', verdict: trend.verdict, direction: TREND_DIRECTION[trend.verdict], heading: TREND_HEADING[trend.verdict], text: trend.text },
    'trend-where': trendWhere,
    'trend-where-other': trendWhereOther,
    'trend-region': { id: 'trend-region', verdict: trendSentences.map((s) => s.verdict).join('+'),
      direction: trendDirections.length === 1 ? trendDirections[0] ?? 'mixed' : 'mixed',
      heading: `Largest fitted change of the ${regionCount} regions`,
      text: `${trendTie}${trendSentences.map((s) => s.text).join(' ')} ${meetingText}` },
    'next-year': { id: 'next-year', verdict: nextYear.direction, direction: nextYear.direction,
      heading: 'PAGASA expects El Niño into 2027',
      text: `PAGASA's El Niño Advisory No. 5 says the current El Niño may last into the first half of 2027, which includes January to April. ${nextYear.text}` },
    'season-window': { id: 'season-window', verdict: 'fixed', direction: 'none',
      text: "We compare the same January to April months each year. This controls the comparison window, not all seasonal influences; it is not full seasonal adjustment or deseasonalization. These months are not uniformly dry nationwide. Eastern Type II areas, including Eastern Visayas and Caraga, are wet then." },
    'pantabangan-context': { id: 'pantabangan-context', verdict: 'fixed', direction: 'none',
      text: 'In April 2024, during a drought, low water in Pantabangan Lake in Nueva Ecija exposed more of the old town, submerged when the reservoir was built. Drag the line to compare 29 April 2023 with 15 April 2024.' },
    'pantabangan-limit': { id: 'pantabangan-limit', verdict: 'fixed', direction: 'none',
      text: 'Rainfall over this square is not reservoir storage. It does not measure inflows across the catchment, releases or evaporation. The January to April total also includes days after the 15 April photograph.' },
    'comparison-limit': { id: 'comparison-limit', verdict: 'fixed', direction: 'none',
      text: 'These are averages of what happened. They do not show what caused the difference, and they are not a forecast.' },
    'method-totals': { id: 'method-totals', verdict: 'fixed', direction: 'none',
      text: 'NASA POWER serves IMERG as daily totals in UTC days. We add them into months, then sum all twelve for each annual total and months one through four for each January to April total. Both windows stay within the same calendar year.' },
    'method-weights': { id: 'method-weights', verdict: 'fixed', direction: 'none',
      text: `Regional and national series use the same land-area weights for annual and January to April totals. Each square counts by its land area inside the boundary, times the cosine of its latitude. Border squares count toward every region they touch. Rainfall trends use only the annual series. The ${regionCount} regions come from geoBoundaries ADM1, which still names the Bangsamoro region ARMM.` },
    'method-enso': { id: 'method-enso', verdict: 'fixed', direction: 'none',
      text: "A year began in El Niño when NOAA's December-to-February Oceanic Niño Index is +0.5 °C or more. This is this page's start-of-year rule, not NOAA's full episode definition. The map compares January to April totals in those years with the same months in other years. Annual comparisons remain as context. The comparison has no significance test and does not separate El Niño from other causes." },
    'method-limits': { id: 'method-limits', verdict: 'fixed', direction: 'none',
      text: 'Annual and January to April totals cannot show daily extremes, rain timing within either window or typhoon intensity. Coastal squares include sea. The Mann-Kendall test uses 25 annual values, with no correction for autocorrelation or multiple testing. Neighbouring squares are not independent. Nothing here is a forecast. The boundary files mark data coverage, not a position on territorial claims.' },
    giovanni: giovanniClaim(a),
    audit: { id: 'audit', verdict: 'fixed', direction: 'none',
      text: `In ${audit.max_ratio_year}, MERRA-2 gave ${fmt.mm(audit.merra2_mm[peak] ?? Number.NaN)} at ${fmt.lon(audit.point[0])}, ${fmt.lat(audit.point[1])}, ${(audit.ratio[peak] ?? Number.NaN).toFixed(2)} times the ${fmt.mm(audit.imerg_mm[peak] ?? Number.NaN)} IMERG measured there. In the other ${audit.years.length - 1} years the ratio stayed between ${lowRatio.toFixed(2)} and ${highRatio.toFixed(2)}.` },
  };
  assertClaims(claims);
  return claims;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function climateClaims(a: Artifact): Pick<Claims, 'climate' | 'climate-enso' | 'climate-method'> {
  const c = a.climate;
  const kWord = ['zero', 'one', 'two', 'three', 'four', 'five', 'six'][c.k] ?? String(c.k);
  const groups = c.groups.map((g) => `Type ${g.pagasa_type} gets ${g.jan_apr_share_pct.toFixed(1)}% from January to April and peaks in ${MONTHS[g.wettest_month - 1]}`);
  const gaps = c.groups.map((g) => `Type ${g.pagasa_type} ${fmt.signedPct(g.enso.diff_pct)}`);
  const directions = new Set(c.groups.map((g) => g.enso.direction));
  const allDown = directions.size === 1 && directions.has('down');
  const wettest = c.groups.reduce((x, y) => (y.jan_apr_share_pct > x.jan_apr_share_pct ? y : x));
  return {
    climate: { id: 'climate', verdict: 'found', direction: 'none', heading: `The data found ${kWord} rain calendars`,
      text: `We gave a k-means algorithm each square's average year as 12 monthly shares of its rain, and nothing about where the square is. It sorted the ${fmt.count(a.cells.count)} squares into ${kWord} groups that resemble the four climate types PAGASA uses. ${fmt.list(groups)}.` },
    'climate-enso': { id: 'climate-enso', verdict: allDown ? 'all-down' : 'mixed', direction: allDown ? 'down' : 'mixed',
      text: allDown
        ? `El Niño-start years had less January to April rain in every group: ${fmt.list(gaps)}. For Type ${wettest.pagasa_type} those months carry ${wettest.jan_apr_share_pct.toFixed(1)}% of the year, so the same El Niño takes away part of its wet season, not its dry one.`
        : `The January to April El Niño gap by group: ${fmt.list(gaps)}.` },
    'climate-method': { id: 'climate-method', verdict: 'fixed', direction: 'none',
      text: `k-means groups the shape of the year, not its total. We asked for ${kWord} groups to compare with PAGASA's four types; the algorithm does not choose that number. It starts from the square with the largest January to April share, adds the square farthest from the chosen centres until there are ${kWord}, then alternates assigning squares and moving centres. It settled after ${c.iterations} rounds. The group edges are the data's own and differ from PAGASA's map in places.` },
  };
}

function greenClaims(farm: Artifact['farm'], alpha: number): Pick<Claims, 'farm-green' | 'farm-green-trend' | 'farm-green-chart'> {
  const g = farm.green;
  const n = farm.sites.length;
  const signed = (v: number) => `${v > 0 ? '+' : v < 0 ? MINUS : ''}${Math.abs(v).toFixed(3)} NDVI per decade`;
  const word = { down: 'lower', up: 'higher', zero: 'the same' }[g.enso_direction];
  const ending = g.meets_threshold && !g.refit.meets_threshold
    ? 'Over 2001-2019, before Terra drifted, it does not, so this small change is not a firm trend.'
    : `Over 2001-2019 it ${g.refit.meets_threshold ? 'also meets' : 'does not meet'} the test.`;
  return {
    'farm-green': {
      id: 'farm-green', verdict: g.enso_direction, direction: g.enso_direction === 'zero' ? 'none' : g.enso_direction,
      heading: { down: 'The fields were less green', up: 'The fields were greener', zero: 'The fields were as green' }[g.enso_direction],
      text: `NDVI measures how green plants look from space, from 0 for bare ground to about 0.9 for dense, healthy leaves. Across the same ${n} cropland sites, January to April NDVI averaged ${g.mean_ndvi.toFixed(3)}. In El Niño-start years it was ${Math.abs(g.enso_diff_ndvi).toFixed(3)} ${word} than in other years, and ${farm.green_lower_sites} of ${n} sites were lower.`,
    },
    'farm-green-trend': {
      id: 'farm-green-trend', verdict: g.meets_threshold ? 'meets' : 'chance', direction: 'none',
      text: `Over 2001-2025 the site-mean NDVI changed by ${signed(g.sen_ndvi_decade)} (${fmt.pSameSideOfAlpha(g.p, g.meets_threshold, alpha)}), which ${g.meets_threshold ? 'meets' : 'does not meet'} the test. NDVI also comes from Terra. ${ending}`,
    },
    'farm-green-chart': { id: 'farm-green-chart', verdict: 'fixed', direction: 'none',
      text: 'January to April NDVI over cropland pixels, equal-weight site mean, cloudy pixels removed.' },
  };
}

function nightAirClaim(surface: Artifact['farm']['night'], air: Artifact['farm']['night_air'], alpha: number): Claim {
  const signed = (v: number) => `${v > 0 ? '+' : v < 0 ? MINUS : ''}${Math.abs(v).toFixed(2)} °C per decade`;
  const verdict = air.direction !== surface.direction ? 'opposite' : air.meets_threshold ? 'confirms' : 'same-sign';
  const ending = {
    confirms: 'It also meets the test.',
    'same-sign': 'Its slope has the same sign but does not meet the test, so the air record does not confirm the surface result.',
    opposite: 'Its slope has the opposite sign.',
  }[verdict];
  return {
    id: 'farm-night-air', verdict, direction: 'none',
    text: `A check without an orbit: MERRA-2 minimum air temperature over the same 12 sites changed by ${signed(air.sen_c_decade)} from January to April 2001-2025 (${fmt.pSameSideOfAlpha(air.p, air.meets_threshold, alpha)}), and by ${signed(air.refit.sen_c_decade)} over 2001-2019. ${ending} Air is not ground surface, and each model cell is coarser than a farm window.`,
  };
}

function giovanniClaim(a: Artifact): Claim {
  const g = a.provenance.giovanni;
  const ours = a.national.jan_apr;
  const sameGap = g.enso.direction === ours.enso.direction;
  const sameTest = g.meets_threshold === ours.meets_threshold;
  const tests = sameTest
    ? (ours.meets_threshold ? 'Both January to April trends meet the test.' : 'Neither January to April trend meets the test.')
    : `The trend tests disagree: ours ${ours.meets_threshold ? 'meets' : 'does not meet'} the test, Giovanni's ${g.meets_threshold ? 'meets' : 'does not meet'} it.`;
  return {
    id: 'giovanni', verdict: sameGap && sameTest ? 'agree' : 'differ', direction: 'none',
    text: `Giovanni averages a box around the islands, sea included, so its totals run lower than our land-weighted ones. The year-to-year pattern matches, r = ${g.r.toFixed(3)}. It puts the El Niño-start January to April gap at ${fmt.signedPct(g.enso.diff_pct)}, against our ${fmt.signedPct(ours.enso.diff_pct)}. ${tests}`,
  };
}

const LEXICON: Record<'up' | 'down', RegExp> = {
  up: /\b(wetter|warmer|warming|hotter|rose|rises?|rising|more rain|increas(e|es|ed|ing)|above)\b/i,
  down: /\b(drier|cooler|cooling|fell|falls?|falling|less rain|decreas(e|es|ed|ing)|below)\b/i,
};
const FORBIDDEN: Record<ClaimDirection, readonly ('up' | 'down')[]> = {
  up: ['down'], down: ['up'], none: ['up', 'down'], mixed: [],
};
const MAX_HEADING = 44;

export function assertClaims(claims: Claims): void {
  for (const id of CLAIM_IDS) {
    const claim = claims[id];
    if (claim.id !== id || claim.text.trim() === '') throw new Error(`Claim ${id} has no registered sentence`);
    const text = `${claim.heading ?? ''} ${claim.text}`;
    for (const side of FORBIDDEN[claim.direction]) {
      const match = LEXICON[side].exec(text);
      if (match) throw new Error(`Claim ${id} (${claim.direction}) contains '${match[0]}'`);
    }
    if (claim.heading !== undefined && claim.heading.length > MAX_HEADING) {
      throw new Error(`Claim ${id} heading exceeds ${MAX_HEADING} characters: ${claim.heading}`);
    }
    if (/undefined|NaN/.test(text)) throw new Error(`Claim ${id} has an unfilled value: ${text}`);
  }
}
