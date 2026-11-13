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
    'enso-land': { id: 'enso-land', verdict: f.enso_less_area_share >= 0.5 ? 'majority' : 'minority', direction: 'down',
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
    trend: { id: 'trend', verdict: trend.verdict, direction: TREND_DIRECTION[trend.verdict], heading: TREND_HEADING[trend.verdict], text: trend.text },
    'trend-where': trendWhere,
    'trend-where-other': trendWhereOther,
    'trend-region': { id: 'trend-region', verdict: trendSentences.map((s) => s.verdict).join('+'),
      direction: trendDirections.length === 1 ? trendDirections[0] ?? 'mixed' : 'mixed',
      heading: `Largest fitted change of the ${regionCount} regions`,
      text: `${trendTie}${trendSentences.map((s) => s.text).join(' ')} ${meetingText}` },
    'next-year': { id: 'next-year', verdict: nextYear.direction, direction: nextYear.direction,
      heading: 'PAGASA expects El Niño into 2027',
      text: `PAGASA's El Niño Advisory No. 5 says the current El Niño may last into the first half of 2027, which includes January to April. ${nextYear.text} This is history, not a forecast for 2027.` },
    'season-window': { id: 'season-window', verdict: 'fixed', direction: 'none',
      text: "January to April covers much of the country's dry cropping season. It is not a dry season everywhere. Eastern Type II areas, including Eastern Visayas and Caraga, are wet then." },
    'pantabangan-context': { id: 'pantabangan-context', verdict: 'fixed', direction: 'none',
      text: 'In April 2024, during a drought, low water in Pantabangan Lake in Nueva Ecija exposed more of the old town, submerged when the reservoir was built. Drag the line to compare 29 April 2023 with 15 April 2024.' },
    'pantabangan-limit': { id: 'pantabangan-limit', verdict: 'fixed', direction: 'none',
      text: 'Rainfall over this square is not reservoir storage. It does not measure inflows across the catchment, releases or evaporation. The January to April total also includes days after the 15 April photograph.' },
    'comparison-limit': { id: 'comparison-limit', verdict: 'fixed', direction: 'none',
      text: 'These are averages of what happened. They do not show what caused the difference, and they are not a forecast.' },
    'method-totals': { id: 'method-totals', verdict: 'fixed', direction: 'none',
      text: 'NASA POWER serves IMERG as daily totals in UTC days. We add them into months, then sum all twelve for each annual total and months one through four for each January to April total. Both windows stay within the same calendar year.' },
    'method-weights': { id: 'method-weights', verdict: 'fixed', direction: 'none',
      text: `Regional and national series use the same land-area weights for annual and January to April totals. Each square counts by its land area inside the boundary, times the cosine of its latitude. Border squares count toward every region they touch. We fit the trend and test only to the annual series. The ${regionCount} regions come from geoBoundaries ADM1, which still names the Bangsamoro region ARMM.` },
    'method-enso': { id: 'method-enso', verdict: 'fixed', direction: 'none',
      text: "A year began in El Niño when NOAA's December-to-February Oceanic Niño Index is +0.5 °C or more. This is this page's start-of-year rule, not NOAA's full episode definition. The map compares January to April totals in those years with the same months in other years. Annual comparisons remain as context. The comparison has no significance test and does not separate El Niño from other causes." },
    'method-limits': { id: 'method-limits', verdict: 'fixed', direction: 'none',
      text: 'Annual and January to April totals cannot show daily extremes, rain timing within either window or typhoon intensity. Coastal squares include sea. The Mann-Kendall test uses 25 annual values, with no correction for autocorrelation or multiple testing. Neighbouring squares are not independent. Nothing here is a forecast. The boundary files mark data coverage, not a position on territorial claims.' },
    audit: { id: 'audit', verdict: 'fixed', direction: 'none',
      text: `In ${audit.max_ratio_year}, MERRA-2 gave ${fmt.mm(audit.merra2_mm[peak] ?? Number.NaN)} at ${fmt.lon(audit.point[0])}, ${fmt.lat(audit.point[1])}, ${(audit.ratio[peak] ?? Number.NaN).toFixed(2)} times the ${fmt.mm(audit.imerg_mm[peak] ?? Number.NaN)} IMERG measured there. In the other ${audit.years.length - 1} years the ratio stayed between ${lowRatio.toFixed(2)} and ${highRatio.toFixed(2)}.` },
  };
  assertClaims(claims);
  return claims;
}

const LEXICON: Record<'up' | 'down', RegExp> = {
  up: /\b(wetter|rose|rises?|rising|more rain|increas(e|es|ed|ing)|above)\b/i,
  down: /\b(drier|fell|falls?|falling|less rain|decreas(e|es|ed|ing)|below)\b/i,
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
