import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeCells, parseArtifact, type AirIndex, type SiteIndex } from '../src/lib/rainfall';
import { COUNTRY, demoSteps, initialState, reduce, type Context } from '../src/lib/view';
import { focusAt } from '../src/lib/variable';
import { placeOf, placeChart } from '../src/lib/place';
import { colourExpression } from '../src/lib/colour';

const raw = JSON.parse(readFileSync(new URL('../public/data/philippines-rainfall.json', import.meta.url), 'utf8'));
const artifact = parseArtifact(raw);
const grid = decodeCells(artifact);
const ctx: Context = { artifact, pantabangan: grid.fromId(artifact.facts.focus.pantabangan_cell)! };

function explorer() { return reduce(initialState(ctx), { type: 'enter-explore' }, ctx); }

describe('explorer transitions', () => {
  test('switching datasets clears incompatible focus and pauses without inventing observations', () => {
    let state = reduce(explorer(), { type: 'select', focus: { kind: 'cell', cell: ctx.pantabangan }, cameraReason: 'select' }, ctx);
    state = reduce(state, { type: 'play' }, ctx);
    state = reduce(state, { type: 'set-variable', variable: 'air' }, ctx);
    assert.deepEqual(state.focus, COUNTRY);
    assert.equal(state.playing, false);
    assert.equal(state.variable, 'air');
    state = reduce(state, { type: 'play' }, ctx);
    assert.equal(reduce(state, { type: 'tick' }, ctx).variable, 'air');
  });

  test('farm windows and El Niño comparisons normalize atomically', () => {
    let state = reduce(explorer(), { type: 'restore', selection: { variable: 'farm-day', window: 'annual', mode: 'farm', year: NaN, focus: { kind: 'region', region: artifact.regions[0]!.id } } }, ctx);
    assert.equal(state.window, 'jan_apr');
    assert.equal(state.mode, 'mean');
    assert.deepEqual(state.focus, COUNTRY);
    assert.equal(state.year, 2001);
    state = reduce(state, { type: 'set-variable', variable: 'air' }, ctx);
    state = reduce(state, { type: 'set-window', window: 'annual' }, ctx);
    state = reduce(state, { type: 'set-mode', mode: 'enso' }, ctx);
    assert.equal(state.window, 'jan_apr');
    assert.equal(reduce(state, { type: 'set-window', window: 'annual' }, ctx).window, 'jan_apr');
  });

  test('January to April rain cell trends are never presented as computed', () => {
    const state = reduce(explorer(), { type: 'restore', selection: { variable: 'rain', window: 'jan_apr', mode: 'trend', year: 2001, focus: { kind: 'cell', cell: ctx.pantabangan } } }, ctx);
    assert.deepEqual(state.focus, { kind: 'region', region: artifact.regions[artifact.cells.region[ctx.pantabangan]!]!.id });
    const place = placeOf(artifact, grid, { kind: 'cell', cell: ctx.pantabangan }, 'rain', 'jan_apr');
    assert.equal(placeChart(artifact, place, null, 'mean').trend, null);
  });

  for (const id of ['rain-air', 'farm'] as const) {
    test(`${id} demo back restores exact selection and user input exits`, () => {
      let state = reduce(explorer(), { type: 'start-demo', id }, ctx);
      const first = demoSteps(ctx, id)[0]!;
      state = reduce(state, { type: 'demo-step', delta: 1 }, ctx);
      state = reduce(state, { type: 'demo-step', delta: -1 }, ctx);
      for (const key of ['variable', 'window', 'mode', 'focus', 'year'] as const) assert.deepEqual(state[key], first[key]);
      assert.equal(reduce(state, { type: 'demo-step', delta: -1 }, ctx).demo?.step, 0);
      const last = demoSteps(ctx, id).length - 1;
      for (let i = 0; i < 8; i++) state = reduce(state, { type: 'demo-step', delta: 1 }, ctx);
      assert.equal(state.demo?.step, last);
      assert.equal(reduce(state, { type: 'set-year', year: 2010 }, ctx).demo, null);
      assert.equal(reduce(state, { type: 'exit-demo' }, ctx).demo, null);
      assert.equal(reduce(state, { type: 'manual-camera' }, ctx).demo, null);
    });
  }

  test('real sites and cells select their own series and coverage is not nearest-site fallback', () => {
    const cell = artifact.air.cells[0]!;
    assert.deepEqual(focusAt(artifact, 'air', cell.lon, cell.lat), { kind: 'air-cell', cell: 0 });
    const air = placeOf(artifact, grid, { kind: 'air-cell', cell: 0 as AirIndex }, 'air', 'annual');
    assert.deepEqual(air.annual, cell.annual.c);
    assert.equal(air.ensoDiffPct, cell.jan_apr.enso_diff_c);
    const site = placeOf(artifact, grid, { kind: 'site', site: 0 as SiteIndex }, 'farm-night', 'jan_apr');
    assert.deepEqual(site.janApr, artifact.farm.sites[0]!.night.c);
    assert.deepEqual(site.refit, artifact.farm.sites[0]!.night.refit);
    assert.equal(focusAt(artifact, 'farm-day', 0, 0), null);
  });

  test('farm coverage follows the slanted polygon rather than its bounding rectangle', () => {
    const slanted = structuredClone(artifact);
    slanted.farm.sites[0]!.outline = [[0, 0], [2, 0], [3, 2], [1, 2], [0, 0]];
    assert.equal(focusAt(slanted, 'farm-day', 0.1, 1.9), null);
    assert.deepEqual(focusAt(slanted, 'farm-day', 1.5, 1), { kind: 'site', site: 0 });
    assert.deepEqual(focusAt(slanted, 'farm-day', 1, 2), { kind: 'site', site: 0 });
  });

  test('repeated manual camera events leave an owned investigation unchanged', () => {
    const first = reduce(explorer(), { type: 'manual-camera' }, ctx);
    assert.equal(reduce(first, { type: 'manual-camera' }, ctx), first);
    const demo = reduce(first, { type: 'start-demo', id: 'rain-air' }, ctx);
    assert.equal(reduce(demo, { type: 'manual-camera' }, ctx).demo, null);
  });

  test('seasonal average colours distinguish rainfall within the January to April range', () => {
    const seasonal = reduce(explorer(), { type: 'set-window', window: 'jan_apr' }, ctx);
    const expression = colourExpression(artifact, 'mean', seasonal.window);
    const classify = (value: number) => {
      let colour: unknown = expression[2];
      for (let i = 3; i < expression.length; i += 2) {
        if (value < Number(expression[i])) break;
        colour = expression[i + 1];
      }
      return colour;
    };
    assert.notEqual(classify(Math.min(...artifact.cells.jan_apr_mean_mm)), classify(Math.max(...artifact.cells.jan_apr_mean_mm)));
  });

  test('story resume restores rainfall overlay after a farm demo', () => {
    const demo = reduce(explorer(), { type: 'start-demo', id: 'farm' }, ctx);
    const story = reduce(demo, { type: 'resume-chapter', chapter: 'farm-night' }, ctx);
    assert.equal(story.variable, 'rain');
    assert.equal(story.mode, 'farm');
    assert.equal(story.demo, null);
    assert.equal(story.owner, 'story');
  });
});

test('v4 rejects malformed air arrays and member indices', () => {
  const short = structuredClone(raw);
  short.air.cells[0].annual.c.pop();
  assert.throws(() => parseArtifact(short));
  const badMember = structuredClone(raw);
  badMember.air.regions[0].members[0] = badMember.air.cells.length;
  assert.throws(() => parseArtifact(badMember));
});
