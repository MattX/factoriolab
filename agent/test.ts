// Must precede every other import: installs the JIT linker and browser globals.
import './engine/shims';

import { EngineInputError, LabEngine, SheetResult } from './engine/engine';

/**
 * End-to-end checks for the headless engine. These run the real solver against
 * the real mod data, so the expected ratios below are the game's, not the
 * engine's: if one of them changes, the data or the solver changed.
 *
 * Run with `npm run agent:build && npm run agent:test`.
 */

let failures = 0;
let checks = 0;

function check(label: string, condition: boolean, detail?: unknown): void {
  checks++;
  if (condition) return;
  failures++;
  console.error(`  FAIL ${label}`);
  if (detail !== undefined) console.error('       got:', detail);
}

function equal(label: string, actual: unknown, expected: unknown): void {
  check(`${label} (expected ${String(expected)})`, actual === expected, actual);
}

async function throws(
  label: string,
  fn: () => Promise<unknown>,
): Promise<void> {
  checks++;
  try {
    await fn();
    failures++;
    console.error(`  FAIL ${label}: expected an error, got a result`);
  } catch (err) {
    if (err instanceof EngineInputError) return;
    failures++;
    console.error(`  FAIL ${label}: expected EngineInputError, got`, err);
  }
}

function itemRate(result: SheetResult, itemId: string): number | undefined {
  return result.steps.find((s) => s.itemId === itemId)?.items?.value;
}

function machineCount(
  result: SheetResult,
  recipeId: string,
): number | undefined {
  return result.steps.find((s) => s.recipeId === recipeId)?.machines?.value;
}

async function main(): Promise<void> {
  const engine = await LabEngine.create();

  console.log('mod sets');
  const mods = engine.listMods();
  check(
    'lists Space Age',
    mods.some((m) => m.id === '2x1'),
  );
  check(
    'lists Factorio 1.1',
    mods.some((m) => m.id === '1.1'),
  );
  check(
    'reports the game',
    mods.every((m) => m.game.length > 0),
  );

  console.log('id search');
  const exact = await engine.search('2x1', 'electronic-circuit', 'item', 5);
  equal('finds an item by exact id', exact[0]?.id, 'electronic-circuit');
  const slang = await engine.search('2x1', 'green circuit', 'item', 5);
  check(
    'falls back to partial matches for slang',
    slang.some((h) => h.id === 'electronic-circuit'),
    slang.map((h) => h.id),
  );
  const recipes = await engine.search('1.1', 'electronic-circuit', 'recipe', 3);
  check(
    'reports recipe inputs',
    recipes[0]?.in?.['iron-plate'] === 1 &&
      recipes[0]?.in?.['copper-cable'] === 3,
    recipes[0]?.in,
  );

  console.log('solving known ratios (Factorio 1.1 electronic circuits)');
  const circuits = await engine.solve({
    modId: '1.1',
    objectives: [{ targetId: 'electronic-circuit', value: 60 }],
  });
  equal('solves', circuits.status, 'solved');
  equal('60 circuits/min', itemRate(circuits, 'electronic-circuit'), 60);
  equal('needs 180 copper cable/min', itemRate(circuits, 'copper-cable'), 180);
  equal('needs 90 copper plate/min', itemRate(circuits, 'copper-plate'), 90);
  equal('needs 60 iron plate/min', itemRate(circuits, 'iron-plate'), 60);
  equal(
    '1 assembler on circuits',
    machineCount(circuits, 'electronic-circuit'),
    1,
  );
  equal('1.5 assemblers on cable', machineCount(circuits, 'copper-cable'), 1.5);

  console.log('display rate scales the objective');
  const perSecond = await engine.solve({
    modId: '1.1',
    objectives: [{ targetId: 'electronic-circuit', value: 1 }],
    settings: { displayRate: 'per-second' },
  });
  equal('per-second rate', perSecond.displayRate, 'per-second');
  equal('1 circuit/s needs 3 cable/s', itemRate(perSecond, 'copper-cable'), 3);
  equal(
    'same machine count as 60/min',
    machineCount(perSecond, 'copper-cable'),
    1.5,
  );

  console.log('exact fractions survive');
  const third = await engine.solve({
    modId: '1.1',
    objectives: [{ targetId: 'iron-gear-wheel', value: '1/3' }],
  });
  equal('keeps the exact objective', third.objectives[0].value.exact, '1/3');

  console.log('Space Age picks the casting route');
  const spaceAge = await engine.solve({
    objectives: [{ targetId: 'iron-plate', value: 60 }],
  });
  equal('defaults to Space Age', spaceAge.modId, '2x1');
  check(
    'casts iron from molten iron',
    spaceAge.steps.some((s) => s.recipeId === 'casting-iron'),
    spaceAge.steps.map((s) => s.recipeId),
  );
  check('reports required machines', spaceAge.totals.machines.length > 0);
  check('reports power draw', (spaceAge.totals.power?.value ?? 0) > 0);

  console.log('url round trips');
  equal(
    'bare url',
    spaceAge.url,
    'https://factoriolab.github.io/2x1/list?o=iron-plate*60&v=11',
  );
  const reread = await engine.describeSheet(spaceAge.url);
  equal('url is stable across a round trip', reread.url, spaceAge.url);
  equal('same step count', reread.steps.length, spaceAge.steps.length);
  equal('same objective', reread.objectives[0].targetId, 'iron-plate');

  console.log('settings round trip through the url');
  const tuned = await engine.solve({
    objectives: [{ targetId: 'electronic-circuit', value: 100 }],
    settings: {
      displayRate: 'per-hour',
      moduleRankIds: ['productivity-module-3'],
      excludedRecipeIds: ['casting-copper'],
    },
  });
  const tunedBack = await engine.describeSheet(tuned.url);
  equal('display rate survives', tunedBack.displayRate, 'per-hour');
  equal('url is stable', tunedBack.url, tuned.url);
  equal('same result', tunedBack.steps.length, tuned.steps.length);

  console.log('large sheets round trip');
  const large = await engine.solve({
    objectives: [
      { targetId: 'electronic-circuit', value: 100 },
      { targetId: 'advanced-circuit', value: 50 },
      { targetId: 'processing-unit', value: 25 },
      { targetId: 'low-density-structure', value: 10 },
      { targetId: 'rocket-fuel', value: 5 },
    ],
    settings: {
      excludedRecipeIds: [
        'casting-copper',
        'casting-iron',
        'casting-steel',
        'coal-liquefaction',
        'simple-coal-liquefaction',
      ],
      moduleRankIds: ['productivity-module-3', 'speed-module-3'],
    },
  });
  const largeBack = await engine.describeSheet(large.url);
  equal('compressed url is stable', largeBack.url, large.url);
  equal('same objectives', largeBack.objectives.length, 5);
  equal('same steps', largeBack.steps.length, large.steps.length);

  console.log('legacy links migrate');
  const legacy = await engine.describeSheet('/list?p=coal*0.5&s=**0&v=10');
  equal('legacy links default to 1.1', legacy.modId, '1.1');
  equal(
    'legacy link migrates to the current format',
    legacy.url,
    'https://factoriolab.github.io/1.1/list?o=coal*0.5&odr=0&v=11',
  );

  const legacyZip = await engine.describeSheet(
    '/list?z=eJxFkctuwjAURP8mi1lUcUiALliQp3FKIRIBqZur0idVKQUKhS749t6RAkjx0dj3NXa-iwqh7y1DzKWtK0AtLV0GU-FXC2ZiIsy8FyO-IBJ0NNhF7M3H3uITRtKVonhW5GvFfUC8KcpfRTZVxNzGMbeMJjkraqpCMeI27rLVrcJVjA6JkhixbMLkd8WA0aTDACuSNgf9MRCygSUcMWCrCMbbFF.MpstyrqgOwAo-fCmfABg9sjfAUYYPlBHrdk2xOPp1bO2OxJ44EBzsaMG1CFpw7OV4a0eDlgHLWtvRQcHJp48lfdCmG1OVlxtvNMc.cV6xvUjbV9k6hZIdG1GchRs1InfnUHQWP9d5u4tMP4BUqoleX.IFsAZPbdw8QpZcMrPsKvOrLK6tHvnifJGMf9XSSg-BVAGYI3YM9MVWwFKqP54Z77WHu1ONUEbSRxstSb2tOkDp7Y3.D1ymp-M_&v=10',
  );
  equal('legacy zipped link finds its mod set', legacyZip.modId, 'sxp');
  check('legacy zipped link solves', legacyZip.objectives.length > 0);
  /**
   * The app only compresses when that actually shortens the link, so this
   * migrated sheet is the natural place to cover the compressed form in both
   * directions: it was read from a zipped link and is long enough to be
   * written back as one.
   */
  check(
    'rewrites it in the compressed form',
    legacyZip.url.includes('z='),
    legacyZip.url,
  );
  const legacyZipBack = await engine.describeSheet(legacyZip.url);
  equal('compressed url is stable', legacyZipBack.url, legacyZip.url);
  equal(
    'compressed url keeps its result',
    legacyZipBack.steps.length,
    legacyZip.steps.length,
  );

  console.log('editing');
  const base = await engine.solve({
    modId: '1.1',
    objectives: [{ targetId: 'iron-plate', value: 60 }],
  });
  const added = await engine.editSheet(base.url, {
    addObjectives: [{ targetId: 'copper-plate', value: 30 }],
  });
  equal('adds an objective', added.objectives.length, 2);
  equal('keeps the original', added.objectives[0].targetId, 'iron-plate');

  const removed = await engine.editSheet(added.url, {
    removeObjectiveIds: [added.objectives[0].id],
  });
  equal('removes an objective', removed.objectives.length, 1);
  equal('keeps the other', removed.objectives[0].targetId, 'copper-plate');

  const replaced = await engine.editSheet(base.url, {
    setObjectives: [{ targetId: 'steel-plate', value: 10 }],
  });
  equal('replaces objectives', replaced.objectives.length, 1);
  equal('uses the new target', replaced.objectives[0].targetId, 'steel-plate');

  const retuned = await engine.editSheet(base.url, {
    settings: { displayRate: 'per-second' },
  });
  equal('changes settings', retuned.displayRate, 'per-second');
  equal('keeps objectives', retuned.objectives.length, 1);

  const moved = await engine.editSheet(base.url, { modId: '2x1' });
  equal('moves to another mod set', moved.modId, '2x1');
  equal(
    'carries objectives across',
    moved.objectives[0].targetId,
    'iron-plate',
  );

  console.log('unsolvable sheets explain themselves');
  const unbounded = await engine.solve({
    objectives: [
      { targetId: 'iron-plate', value: 1, type: 'maximize' },
      { targetId: 'iron-ore', value: 100, type: 'limit' },
    ],
  });
  equal('reports the failure', unbounded.status, 'failed');
  check(
    'explains it in English',
    unbounded.notes.some((n) => n.toLowerCase().includes('unbounded')),
    unbounded.notes,
  );

  console.log('bad input is rejected with a usable message');
  await throws('unknown item id', () =>
    engine.solve({ objectives: [{ targetId: 'not-a-thing', value: 1 }] }),
  );
  await throws('unknown mod set', () =>
    engine.solve({
      modId: 'nope',
      objectives: [{ targetId: 'coal', value: 1 }],
    }),
  );
  await throws('unknown recipe in settings', () =>
    engine.solve({
      objectives: [{ targetId: 'coal', value: 1 }],
      settings: { excludedRecipeIds: ['not-a-recipe'] },
    }),
  );
  await throws('unknown objective id on edit', () =>
    engine.editSheet(base.url, { removeObjectiveIds: ['99'] }),
  );

  console.log('');
  if (failures) {
    console.error(`${failures} of ${checks} checks failed`);
    process.exit(1);
  }
  console.log(`All ${checks} checks passed`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
