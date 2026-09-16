import { Rational, rational } from '~/rational/rational';
import { Step } from '~/solver/step';
import { coalesce } from '~/utils/nullish';
import { toRecordEntries } from '~/utils/record';

import { GroupState } from './group-state';

/** Id of the implicit group which holds the objectives of the sheet */
export const MAIN_GROUP_ID = 'main';

/** Prefix for the ids of groups derived from joint product recipes */
export const AUTO_GROUP_PREFIX = 'auto|';

/** Key used by `Step.parents` for the portion of an item which is an output */
const OUTPUT_KEY = '';

/**
 * Shares within this distance of zero or one are snapped, both to cut off the
 * geometric tail of a feedback loop and to keep the resulting rationals simple.
 */
const EPSILON = 1e-9;

/** Cap on fixed point iterations, a feedback loop never terminates exactly */
const MAX_ITERATIONS = 1000;

/** Cap on rounds of deriving groups for joint product recipes */
const MAX_ROUNDS = 100;

export interface GroupAttribution {
  id: string;
  name?: string;
  /** True if this group was derived from a joint product recipe */
  auto: boolean;
  /**
   * Items whose production belongs to this group. May be wider than the roots
   * the user picked: claiming one output of a recipe claims the others too.
   */
  rootItemIds: string[];
  /** Fraction of an item step's production in this group, keyed by step id */
  itemShares: Record<string, Rational>;
  /** Fraction of a recipe step's machines in this group, keyed by step id */
  recipeShares: Record<string, Rational>;
  /** Fraction of an item's production which this group takes from its owner */
  imports: Record<string, Rational>;
  /** Fraction of a root item's production taken by each other group */
  exports: Record<string, Record<string, Rational>>;
}

export interface AttributionResult {
  /** Main group first, then user defined groups, then derived groups */
  groups: GroupAttribution[];
  /** Id of the group which claims each root item */
  itemOwners: Record<string, string>;
  /** Derived groups, in a form which can be stored as user defined groups */
  autoGroups: GroupState[];
}

interface Consumer {
  stepId: string;
  fraction: number;
}

/** What a step contributes to the graph: an item's production, a recipe, or both */
interface GraphNode {
  stepId: string;
  /** Set when this step accounts for the production of an item */
  itemId?: string;
  isRecipe: boolean;
}

interface Graph {
  /**
   * Steps in the order the solve left them, which runs from the objectives back
   * towards the inputs. Walking demand in this order carries it across the whole
   * sheet in a single pass.
   */
  nodes: GraphNode[];
  stepIdByItemId: Record<string, string>;
  /** Recipe steps which take each item, with the fraction of production taken */
  consumers: Record<string, Consumer[]>;
  /** Fraction of each item which goes to the objectives of the sheet */
  objectiveFractions: Record<string, number>;
  /** Items produced by each recipe step, sorted, keyed by step id */
  recipeOutputs: Record<string, string[]>;
  /** Recipe steps which are fixed to the main group, keyed by step id */
  pinned: Record<string, boolean>;
  /** Fraction of each item produced by steps fixed to the main group */
  pinnedFractions: Record<string, number>;
}

interface Assignment {
  /** Group ids, main first */
  ids: string[];
  /** Id of the group which claims each root item */
  owners: Record<string, string>;
  /** Root items of each group, keyed by group id */
  roots: Record<string, string[]>;
}

interface Shares {
  /** Group id, then item id */
  item: Record<string, Record<string, number>>;
  /** Group id, then recipe step id */
  recipe: Record<string, Record<string, number>>;
}

/**
 * Splits a solved set of steps between the passed groups.
 *
 * A group claims the whole production of its root items, and a share of every
 * step which feeds them, in proportion to how much of that step's output the
 * group takes. Items claimed by another group stop the walk and are reported as
 * imports instead.
 *
 * A recipe with several outputs cannot be split this way, since running it for
 * one output produces the others too. Where two groups would both claim such a
 * recipe, all of its outputs are moved into a derived group of their own, and
 * both groups import from it.
 *
 * Production which nothing consumes belongs to no group, so the shares of a
 * step which leaves a surplus add up to less than one.
 *
 * Shares are solved as floating point numbers, since a feedback loop only
 * converges on its fixed point rather than reaching it, and are converted back
 * to rationals once they settle.
 */
export function attributeGroups(
  steps: Step[],
  groups: GroupState[],
): AttributionResult {
  const graph = buildGraph(steps);
  const assignment = buildAssignment(graph, groups);
  let shares = solveShares(graph, assignment);

  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (!deriveAutoGroup(graph, assignment, shares)) break;
    closeRoots(graph, assignment);
    shares = solveShares(graph, assignment);
  }

  normalizeAutoIds(assignment, shares);
  return buildResult(graph, assignment, shares, groups);
}

function buildGraph(steps: Step[]): Graph {
  const pinned: Step[] = [];
  const graph: Graph = {
    nodes: [],
    stepIdByItemId: {},
    consumers: {},
    objectiveFractions: {},
    recipeOutputs: {},
    pinned: {},
    pinnedFractions: {},
  };

  for (const step of steps) {
    const node: GraphNode = {
      stepId: step.id,
      isRecipe: step.recipeId != null,
    };
    graph.nodes.push(node);

    if (step.itemId != null && graph.stepIdByItemId[step.itemId] == null) {
      const itemId = step.itemId;
      node.itemId = itemId;
      graph.stepIdByItemId[itemId] = step.id;
      graph.consumers[itemId] = [];
      graph.objectiveFractions[itemId] = 0;

      for (const [key, value] of toRecordEntries(coalesce(step.parents, {}))) {
        if (key === OUTPUT_KEY)
          graph.objectiveFractions[itemId] = value.toNumber();
        else
          graph.consumers[itemId].push({
            stepId: key,
            fraction: value.toNumber(),
          });
      }
    }

    if (step.recipeId == null) continue;

    graph.recipeOutputs[step.id] = toRecordEntries(coalesce(step.outputs, {}))
      .filter(([, value]) => value.nonzero())
      .map(([itemId]) => itemId)
      .sort();

    // A recipe objective is a fixed request of the sheet, not a consequence of
    // any group's demand, so it stays in the main group. So does a recipe whose
    // outputs all fell out of the solve, which nothing can attribute.
    if (
      step.recipeObjectiveId != null ||
      graph.recipeOutputs[step.id].length === 0
    ) {
      graph.pinned[step.id] = true;
      pinned.push(step);
    }
  }

  for (const step of pinned)
    for (const [itemId, value] of toRecordEntries(coalesce(step.outputs, {})))
      graph.pinnedFractions[itemId] =
        pinnedFraction(graph, itemId) + value.toNumber();

  return graph;
}

/** Fraction of an item produced by steps which are fixed to the main group */
function pinnedFraction(graph: Graph, itemId: string): number {
  return coalesce(graph.pinnedFractions[itemId], 0);
}

/** Sets up the main group and the user defined groups which still have roots */
function buildAssignment(graph: Graph, groups: GroupState[]): Assignment {
  const assignment: Assignment = {
    ids: [MAIN_GROUP_ID],
    owners: {},
    roots: { [MAIN_GROUP_ID]: [] },
  };

  for (const group of groups) {
    const rootItemIds = group.rootItemIds.filter(
      (i) => graph.stepIdByItemId[i] != null && assignment.owners[i] == null,
    );
    if (rootItemIds.length === 0) continue;

    assignment.ids.push(group.id);
    assignment.roots[group.id] = rootItemIds;
    for (const itemId of rootItemIds) assignment.owners[itemId] = group.id;
  }

  closeRoots(graph, assignment);
  return assignment;
}

/**
 * Claiming one output of a recipe claims the machines which make it, and so the
 * rest of its outputs as well. Spreads each claim over those outputs until no
 * recipe is left with both claimed and unclaimed outputs.
 */
function closeRoots(graph: Graph, assignment: Assignment): void {
  for (let round = 0; round < MAX_ROUNDS; round++) {
    let changed = false;

    for (const node of graph.nodes) {
      if (!node.isRecipe || graph.pinned[node.stepId]) continue;

      const stepId = node.stepId;
      const outputs = graph.recipeOutputs[stepId];
      const owner = recipeOwner(graph, assignment, stepId);
      if (owner == null) continue;

      for (const itemId of outputs) {
        if (assignment.owners[itemId] != null) continue;
        assignment.owners[itemId] = owner;
        assignment.roots[owner].push(itemId);
        changed = true;
      }
    }

    if (!changed) return;
  }
}

/** The group which claims a recipe step, through any of its output items */
function recipeOwner(
  graph: Graph,
  assignment: Assignment,
  stepId: string,
): string | undefined {
  for (const itemId of graph.recipeOutputs[stepId]) {
    const owner = assignment.owners[itemId];
    if (owner != null) return owner;
  }

  return undefined;
}

/**
 * Walks demand back from the roots of each group until the shares settle.
 *
 * Each pass takes the steps in the order the solve left them, and updates the
 * item a step produces before the recipe which produces it. A step's consumers
 * come earlier in that order, so their demand has already been updated this
 * pass, and an acyclic sheet settles in one pass rather than one per level.
 */
function solveShares(graph: Graph, assignment: Assignment): Shares {
  const shares: Shares = { item: {}, recipe: {} };
  const owners: Record<string, string | undefined> = {};
  for (const node of graph.nodes) {
    if (!node.isRecipe) continue;
    owners[node.stepId] = recipeOwner(graph, assignment, node.stepId);
  }

  for (const groupId of assignment.ids) {
    shares.item[groupId] = {};
    shares.recipe[groupId] = {};
    for (const node of graph.nodes) {
      if (node.itemId != null) shares.item[groupId][node.itemId] = 0;
      if (node.isRecipe) shares.recipe[groupId][node.stepId] = 0;
    }
  }

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    let delta = 0;

    for (const groupId of assignment.ids) {
      const isMain = groupId === MAIN_GROUP_ID;
      const itemShares = shares.item[groupId];
      const recipeShares = shares.recipe[groupId];

      for (const node of graph.nodes) {
        const itemId = node.itemId;
        if (itemId != null) {
          const owner = assignment.owners[itemId];
          let value: number;
          if (owner === groupId) {
            // The group claims every unit of its root which it can reach
            value = Math.max(0, 1 - pinnedFraction(graph, itemId));
          } else if (owner != null) {
            // Claimed elsewhere, anything this group takes is an import
            value = isMain ? pinnedFraction(graph, itemId) : 0;
          } else {
            value = demand(graph, recipeShares, itemId, isMain);
          }

          delta = Math.max(delta, Math.abs(value - itemShares[itemId]));
          itemShares[itemId] = value;
        }

        if (!node.isRecipe) continue;

        const stepId = node.stepId;
        let value: number;
        if (graph.pinned[stepId]) value = isMain ? 1 : 0;
        else if (owners[stepId] != null)
          value = owners[stepId] === groupId ? 1 : 0;
        else {
          value = 0;
          for (const outputId of graph.recipeOutputs[stepId])
            value = Math.max(value, itemShares[outputId]);
        }

        delta = Math.max(delta, Math.abs(value - recipeShares[stepId]));
        recipeShares[stepId] = value;
      }
    }

    if (delta < EPSILON) break;
  }

  return shares;
}

/** Fraction of an item's production which a group takes */
function demand(
  graph: Graph,
  recipeShares: Record<string, number>,
  itemId: string,
  isMain: boolean,
): number {
  let value = isMain ? graph.objectiveFractions[itemId] : 0;
  for (const consumer of graph.consumers[itemId])
    value += recipeShares[consumer.stepId] * consumer.fraction;

  return Math.min(1, value);
}

/**
 * Finds the first recipe which two groups would both have to run for its own
 * output, and moves all of its outputs into a group of their own. Returns
 * whether such a recipe was found.
 */
function deriveAutoGroup(
  graph: Graph,
  assignment: Assignment,
  shares: Shares,
): boolean {
  for (const node of graph.nodes) {
    if (!node.isRecipe || graph.pinned[node.stepId]) continue;

    const stepId = node.stepId;
    const outputs = graph.recipeOutputs[stepId];
    // A recipe with a single output is split by demand, and one whose output is
    // already claimed belongs to whoever claims it
    if (outputs.length < 2) continue;
    if (outputs.some((i) => assignment.owners[i] != null)) continue;

    const claiming = assignment.ids.filter(
      (id) => shares.recipe[id][stepId] > EPSILON,
    );
    if (claiming.length < 2) continue;

    addAutoGroup(assignment, outputs);
    return true;
  }

  return false;
}

/**
 * Adds a derived group for the outputs of a joint product recipe. Its roots may
 * grow afterwards, as claiming these outputs claims any recipe which shares one.
 */
function addAutoGroup(assignment: Assignment, itemIds: string[]): void {
  const rootItemIds = [...itemIds].sort();
  const id = AUTO_GROUP_PREFIX + rootItemIds[0];
  assignment.ids.push(id);
  assignment.roots[id] = rootItemIds;
  for (const itemId of rootItemIds) assignment.owners[itemId] = id;
}

/**
 * Names each derived group after the first of its final roots, so that the same
 * set of items always ends up with the same id. Root sets never overlap, so
 * these ids are unique.
 */
function normalizeAutoIds(assignment: Assignment, shares: Shares): void {
  for (const id of [...assignment.ids]) {
    if (!id.startsWith(AUTO_GROUP_PREFIX)) continue;

    const rootItemIds = [...assignment.roots[id]].sort();
    assignment.roots[id] = rootItemIds;
    const next = AUTO_GROUP_PREFIX + rootItemIds[0];
    if (next === id) continue;

    assignment.ids = assignment.ids.map((i) => (i === id ? next : i));
    assignment.roots[next] = rootItemIds;
    delete assignment.roots[id];
    for (const itemId of rootItemIds) assignment.owners[itemId] = next;
    shares.item[next] = shares.item[id];
    shares.recipe[next] = shares.recipe[id];
    delete shares.item[id];
    delete shares.recipe[id];
  }
}

function buildResult(
  graph: Graph,
  assignment: Assignment,
  shares: Shares,
  groups: GroupState[],
): AttributionResult {
  const stateById: Record<string, GroupState> = {};
  for (const group of groups) stateById[group.id] = group;

  const autoIds = assignment.ids
    .filter((id) => id.startsWith(AUTO_GROUP_PREFIX))
    .sort();
  const ids = [
    ...assignment.ids.filter((id) => !id.startsWith(AUTO_GROUP_PREFIX)),
    ...autoIds,
  ];

  const result: AttributionResult = {
    groups: [],
    itemOwners: assignment.owners,
    autoGroups: autoIds.map((id) => ({
      id,
      rootItemIds: assignment.roots[id],
    })),
  };

  for (const groupId of ids) {
    const auto = groupId.startsWith(AUTO_GROUP_PREFIX);
    const attribution: GroupAttribution = {
      id: groupId,
      auto,
      rootItemIds: assignment.roots[groupId],
      itemShares: {},
      recipeShares: {},
      imports: {},
      exports: {},
    };

    const name = stateById[groupId]?.name;
    if (name != null) attribution.name = name;

    for (const node of graph.nodes) {
      const itemId = node.itemId;
      if (itemId == null) continue;

      const value = toRational(shares.item[groupId][itemId]);
      if (value.nonzero())
        attribution.itemShares[graph.stepIdByItemId[itemId]] = value;

      const owner = assignment.owners[itemId];
      if (owner == null) continue;

      if (owner === groupId) {
        // Anything another group takes from a root is an export
        for (const otherId of ids) {
          if (otherId === groupId) continue;
          const taken = toRational(
            demand(
              graph,
              shares.recipe[otherId],
              itemId,
              otherId === MAIN_GROUP_ID,
            ),
          );
          if (!taken.nonzero()) continue;
          attribution.exports[itemId] ??= {};
          attribution.exports[itemId][otherId] = taken;
        }
      } else {
        const taken = toRational(
          demand(
            graph,
            shares.recipe[groupId],
            itemId,
            groupId === MAIN_GROUP_ID,
          ),
        );
        if (taken.nonzero()) attribution.imports[itemId] = taken;
      }
    }

    for (const node of graph.nodes) {
      if (!node.isRecipe) continue;

      const value = toRational(shares.recipe[groupId][node.stepId]);
      if (value.nonzero()) attribution.recipeShares[node.stepId] = value;
    }

    result.groups.push(attribution);
  }

  return result;
}

function toRational(value: number): Rational {
  if (value <= EPSILON) return rational.zero;
  if (value >= 1 - EPSILON) return rational.one;
  return rational(value);
}

/** Total share of a step across all groups, to check against a solved step */
export function sumShares(
  groups: GroupAttribution[],
  key: 'itemShares' | 'recipeShares',
  stepId: string,
): Rational {
  return groups.reduce(
    (total, g) => total.add(g[key][stepId] ?? rational.zero),
    rational.zero,
  );
}
