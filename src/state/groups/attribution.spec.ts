import { Rational, rational } from '~/rational/rational';
import { Step } from '~/solver/step';

import {
  attributeGroups,
  GroupAttribution,
  MAIN_GROUP_ID,
  sumShares,
} from './attribution';
import { GroupState } from './group-state';

interface StepOptions {
  itemId?: string;
  /** Fraction of the item taken by each step, `''` for the sheet objectives */
  parents?: Record<string, number>;
  recipeId?: string;
  /** Fraction of each item which this recipe produces */
  outputs?: Record<string, number>;
  recipeObjectiveId?: string;
}

function toRationals(value: Record<string, number>): Record<string, Rational> {
  const result: Record<string, Rational> = {};
  for (const key of Object.keys(value)) result[key] = rational(value[key]);
  return result;
}

function step(id: string, options: StepOptions): Step {
  const result: Step = { id };
  if (options.itemId != null) {
    result.itemId = options.itemId;
    result.items = rational.one;
  }
  if (options.parents != null) result.parents = toRationals(options.parents);
  if (options.recipeId != null) {
    result.recipeId = options.recipeId;
    result.machines = rational.one;
  }
  if (options.outputs != null) result.outputs = toRationals(options.outputs);
  if (options.recipeObjectiveId != null)
    result.recipeObjectiveId = options.recipeObjectiveId;
  return result;
}

function group(id: string, ...rootItemIds: string[]): GroupState {
  return { id, rootItemIds };
}

function byId(
  groups: GroupAttribution[],
  id: string,
): GroupAttribution | undefined {
  return groups.find((g) => g.id === id);
}

/** A sheet which makes science from belts and inserters, which share gears */
const sharedSteps: Step[] = [
  step('sci', {
    itemId: 'science',
    parents: { '': 1 },
    recipeId: 'science',
    outputs: { science: 1 },
  }),
  step('belt', {
    itemId: 'belt',
    parents: { sci: 1 },
    recipeId: 'belt',
    outputs: { belt: 1 },
  }),
  step('ins', {
    itemId: 'inserter',
    parents: { sci: 1 },
    recipeId: 'inserter',
    outputs: { inserter: 1 },
  }),
  step('gear', {
    itemId: 'gear',
    parents: { belt: 0.5, ins: 0.5 },
    recipeId: 'gear',
    outputs: { gear: 1 },
  }),
  step('plate', {
    itemId: 'plate',
    parents: { gear: 1 },
    recipeId: 'plate',
    outputs: { plate: 1 },
  }),
];

/** A sheet which cracks one recipe into petroleum and heavy oil */
const oilSteps: Step[] = [
  step('sci', {
    itemId: 'science',
    parents: { '': 1 },
    recipeId: 'science',
    outputs: { science: 1 },
  }),
  step('plas', {
    itemId: 'plastic',
    parents: { sci: 1 },
    recipeId: 'plastic',
    outputs: { plastic: 1 },
  }),
  step('lube', {
    itemId: 'lubricant',
    parents: { sci: 1 },
    recipeId: 'lubricant',
    outputs: { lubricant: 1 },
  }),
  step('petro', { itemId: 'petroleum', parents: { plas: 1 } }),
  step('heavy', { itemId: 'heavy-oil', parents: { lube: 1 } }),
  step('oil', { recipeId: 'oil', outputs: { petroleum: 1, 'heavy-oil': 1 } }),
  step('crude', {
    itemId: 'crude',
    parents: { oil: 1 },
    recipeId: 'pump',
    outputs: { crude: 1 },
  }),
];

describe('attributeGroups', () => {
  it('should put every step in the main group when no groups are set', () => {
    const result = attributeGroups(sharedSteps, []);

    expect(result.groups.length).toEqual(1);
    const main = result.groups[0];
    expect(main.id).toEqual(MAIN_GROUP_ID);
    expect(main.auto).toBeFalse();
    expect(main.recipeShares).toEqual({
      sci: rational.one,
      belt: rational.one,
      ins: rational.one,
      gear: rational.one,
      plate: rational.one,
    });
    expect(main.itemShares['gear']).toEqual(rational.one);
    expect(main.imports).toEqual({});
    expect(main.exports).toEqual({});
    expect(result.autoGroups).toEqual([]);
    expect(result.itemOwners).toEqual({});
  });

  it('should split a shared step between groups by demand', () => {
    const result = attributeGroups(sharedSteps, [
      group('1', 'belt'),
      group('2', 'inserter'),
    ]);

    expect(result.groups.map((g) => g.id)).toEqual([MAIN_GROUP_ID, '1', '2']);

    const belts = byId(result.groups, '1')!;
    expect(belts.rootItemIds).toEqual(['belt']);
    expect(belts.recipeShares).toEqual({
      belt: rational.one,
      gear: rational(1, 2),
      plate: rational(1, 2),
    });
    expect(belts.itemShares['gear']).toEqual(rational(1, 2));
    expect(belts.exports).toEqual({ belt: { [MAIN_GROUP_ID]: rational.one } });
    expect(belts.imports).toEqual({});

    const inserters = byId(result.groups, '2')!;
    expect(inserters.recipeShares['gear']).toEqual(rational(1, 2));

    const main = byId(result.groups, MAIN_GROUP_ID)!;
    expect(main.recipeShares).toEqual({ sci: rational.one });
    expect(main.imports).toEqual({
      belt: rational.one,
      inserter: rational.one,
    });
  });

  it('should leave the shares of every step adding up to one', () => {
    const result = attributeGroups(sharedSteps, [
      group('1', 'belt'),
      group('2', 'inserter'),
    ]);

    for (const id of ['sci', 'belt', 'ins', 'gear', 'plate']) {
      expect(sumShares(result.groups, 'recipeShares', id)).toEqual(
        rational.one,
      );
      expect(sumShares(result.groups, 'itemShares', id)).toEqual(rational.one);
    }
  });

  it('should settle a feedback loop on its fixed point', () => {
    const steps = [
      ...sharedSteps.slice(0, 3),
      step('plate', {
        itemId: 'plate',
        // Half of the plates are consumed by the recipe which makes them
        parents: { belt: 0.25, ins: 0.25, plate: 0.5 },
        recipeId: 'plate',
        outputs: { plate: 1 },
      }),
    ];

    const result = attributeGroups(steps, [
      group('1', 'belt'),
      group('2', 'inserter'),
    ]);

    expect(byId(result.groups, '1')!.recipeShares['plate']).toEqual(
      rational(1, 2),
    );
    expect(byId(result.groups, '2')!.recipeShares['plate']).toEqual(
      rational(1, 2),
    );
    expect(sumShares(result.groups, 'recipeShares', 'plate')).toEqual(
      rational.one,
    );
  });

  it('should leave production which nothing takes unattributed', () => {
    const steps = [
      step('sci', {
        itemId: 'science',
        parents: { '': 1 },
        recipeId: 'science',
        outputs: { science: 1 },
      }),
      // Only half of the petroleum produced is used, the rest is a surplus
      step('petro', {
        itemId: 'petroleum',
        parents: { sci: 0.5 },
        recipeId: 'oil',
        outputs: { petroleum: 1 },
      }),
      // Nothing takes this item and nothing records making it
      step('waste', { itemId: 'waste' }),
      // Every output of this recipe fell out of the solve
      step('void', { recipeId: 'void' }),
    ];

    const result = attributeGroups(steps, []);

    expect(sumShares(result.groups, 'recipeShares', 'petro')).toEqual(
      rational(1, 2),
    );
    expect(sumShares(result.groups, 'itemShares', 'waste')).toEqual(
      rational.zero,
    );
    // A recipe nothing can be attributed to falls back to the main group
    expect(result.groups[0].recipeShares['void']).toEqual(rational.one);
  });

  it('should not derive a group when one group runs a joint recipe alone', () => {
    const result = attributeGroups(oilSteps, [group('1', 'science')]);

    expect(result.autoGroups).toEqual([]);
    expect(byId(result.groups, '1')!.recipeShares['oil']).toEqual(rational.one);
  });

  it('should derive a group for a recipe two groups would both run', () => {
    const result = attributeGroups(oilSteps, [
      group('1', 'plastic'),
      group('2', 'lubricant'),
    ]);

    expect(result.autoGroups).toEqual([
      { id: 'auto|heavy-oil', rootItemIds: ['heavy-oil', 'petroleum'] },
    ]);
    expect(result.groups.map((g) => g.id)).toEqual([
      MAIN_GROUP_ID,
      '1',
      '2',
      'auto|heavy-oil',
    ]);

    const oil = byId(result.groups, 'auto|heavy-oil')!;
    expect(oil.auto).toBeTrue();
    expect(oil.recipeShares).toEqual({
      oil: rational.one,
      crude: rational.one,
    });
    expect(oil.exports).toEqual({
      'heavy-oil': { '2': rational.one },
      petroleum: { '1': rational.one },
    });

    const plastics = byId(result.groups, '1')!;
    expect(plastics.recipeShares).toEqual({ plas: rational.one });
    expect(plastics.imports).toEqual({ petroleum: rational.one });

    expect(sumShares(result.groups, 'recipeShares', 'oil')).toEqual(
      rational.one,
    );
  });

  it('should pull a recipe which shares an output into the derived group', () => {
    const steps = [
      step('sci', {
        itemId: 'science',
        parents: { '': 1 },
        recipeId: 'science',
        outputs: { science: 1 },
      }),
      step('plas', {
        itemId: 'plastic',
        parents: { sci: 1 },
        recipeId: 'plastic',
        outputs: { plastic: 1 },
      }),
      step('solid', {
        itemId: 'solid-fuel',
        parents: { sci: 1 },
        recipeId: 'solid-fuel',
        outputs: { 'solid-fuel': 1 },
      }),
      step('lube', {
        itemId: 'lubricant',
        parents: { sci: 1 },
        recipeId: 'lubricant',
        outputs: { lubricant: 1 },
      }),
      step('petro', { itemId: 'petroleum', parents: { plas: 1 } }),
      step('light', { itemId: 'light-oil', parents: { solid: 1 } }),
      step('heavy', { itemId: 'heavy-oil', parents: { lube: 1 } }),
      step('oil', {
        recipeId: 'oil',
        outputs: { petroleum: 1, 'light-oil': 0.5 },
      }),
      // Shares light oil with the recipe which makes the petroleum
      step('crack', {
        recipeId: 'crack',
        outputs: { 'heavy-oil': 1, 'light-oil': 0.5 },
      }),
    ];

    const result = attributeGroups(steps, [
      group('1', 'plastic'),
      group('2', 'solid-fuel'),
      group('3', 'lubricant'),
    ]);

    expect(result.autoGroups).toEqual([
      {
        id: 'auto|heavy-oil',
        rootItemIds: ['heavy-oil', 'light-oil', 'petroleum'],
      },
    ]);

    const oil = byId(result.groups, 'auto|heavy-oil')!;
    expect(oil.recipeShares['oil']).toEqual(rational.one);
    expect(oil.recipeShares['crack']).toEqual(rational.one);
    expect(sumShares(result.groups, 'recipeShares', 'crack')).toEqual(
      rational.one,
    );
    expect(byId(result.groups, '3')!.imports).toEqual({
      'heavy-oil': rational.one,
    });
  });

  it('should keep a joint recipe with the group which claims an output', () => {
    const result = attributeGroups(oilSteps, [
      group('1', 'plastic'),
      group('2', 'heavy-oil'),
    ]);

    expect(result.autoGroups).toEqual([]);

    // Claiming the heavy oil claims the recipe, and so the petroleum too
    const heavy = byId(result.groups, '2')!;
    expect(heavy.rootItemIds).toEqual(['heavy-oil', 'petroleum']);
    expect(heavy.recipeShares['oil']).toEqual(rational.one);
    expect(heavy.exports['petroleum']).toEqual({ '1': rational.one });

    const plastics = byId(result.groups, '1')!;
    expect(plastics.recipeShares['oil']).toBeUndefined();
    expect(plastics.imports).toEqual({ petroleum: rational.one });
  });

  it('should keep a recipe objective in the main group', () => {
    const steps = [
      step('sci', {
        itemId: 'science',
        parents: { '': 1 },
        recipeId: 'science',
        outputs: { science: 1 },
      }),
      step('belt', {
        itemId: 'belt',
        parents: { sci: 1 },
        recipeId: 'belt',
        outputs: { belt: 1 },
      }),
      step('gear', {
        itemId: 'gear',
        parents: { belt: 1 },
        recipeId: 'gear',
        outputs: { gear: 0.5 },
      }),
      step('gobj', {
        recipeId: 'gear',
        recipeObjectiveId: 'o1',
        outputs: { gear: 0.5 },
      }),
    ];

    const result = attributeGroups(steps, [group('1', 'gear')]);

    const main = byId(result.groups, MAIN_GROUP_ID)!;
    expect(main.recipeShares['gobj']).toEqual(rational.one);
    // The group cannot claim the half of the gears the objective asked for
    expect(main.itemShares['gear']).toEqual(rational(1, 2));
    expect(main.imports).toEqual({ gear: rational.one });

    const gears = byId(result.groups, '1')!;
    expect(gears.recipeShares['gobj']).toBeUndefined();
    expect(gears.recipeShares['gear']).toEqual(rational.one);
    expect(gears.itemShares['gear']).toEqual(rational(1, 2));
    expect(gears.exports).toEqual({ gear: { [MAIN_GROUP_ID]: rational.one } });
  });

  it('should ignore roots which are not part of the solve', () => {
    const result = attributeGroups(sharedSteps, [
      group('1', 'belt', 'not-a-real-item'),
      group('2', 'not-a-real-item-either'),
    ]);

    expect(result.groups.map((g) => g.id)).toEqual([MAIN_GROUP_ID, '1']);
    expect(byId(result.groups, '1')!.rootItemIds).toEqual(['belt']);
  });

  it('should give a root item to the first group which claims it', () => {
    const result = attributeGroups(sharedSteps, [
      group('1', 'belt'),
      group('2', 'belt'),
    ]);

    expect(result.itemOwners).toEqual({ belt: '1' });
    expect(result.groups.map((g) => g.id)).toEqual([MAIN_GROUP_ID, '1']);
  });

  it('should keep a name set on a group', () => {
    const result = attributeGroups(sharedSteps, [
      { id: '1', name: 'Belts', rootItemIds: ['belt'] },
    ]);

    expect(byId(result.groups, '1')!.name).toEqual('Belts');
  });
});
