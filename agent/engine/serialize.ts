// Must precede every other import: installs the JIT linker and browser globals.
import './shims';

import { Rational } from '~/rational/rational';
import { Step } from '~/solver/step';
import { BeaconSettings } from '~/state/beacon-settings';
import { ItemSettings } from '~/state/items/item-settings';
import { ItemState } from '~/state/items/item-state';
import { ModuleSettings } from '~/state/module-settings';
import { ObjectiveState } from '~/state/objectives/objective';
import { ObjectiveType } from '~/state/objectives/objective-type';
import { ObjectiveUnit } from '~/state/objectives/objective-unit';
import { RecipeSettings } from '~/state/recipes/recipe-settings';
import { RecipeState } from '~/state/recipes/recipe-state';
import { AdjustedDataset } from '~/state/settings/dataset';
import { DisplayRate } from '~/state/settings/display-rate';

/**
 * FactorioLab computes in exact rationals. Agents read numbers, so every value
 * is reported as a rounded decimal, plus the exact form whenever rounding lost
 * information (1/3 of a machine, say).
 */
export interface Quantity {
  value: number;
  exact?: string;
}

export function quantity(value: Rational | undefined): Quantity | undefined {
  if (value == null) return undefined;
  const result: Quantity = { value: round(value.toNumber()) };
  const exact = value.toString();
  if (exact !== String(result.value)) result.exact = exact;
  return result;
}

function round(value: number): number {
  return Number(value.toPrecision(10));
}

function record(
  values: Record<string, Rational> | undefined,
): Record<string, number> | undefined {
  if (values == null) return undefined;
  const entries = Object.entries(values).map(
    ([key, value]) => [key, round(value.toNumber())] as const,
  );
  if (entries.length === 0) return undefined;
  return Object.fromEntries(entries);
}

export const DISPLAY_RATES = {
  'per-second': DisplayRate.PerSecond,
  'per-minute': DisplayRate.PerMinute,
  'per-hour': DisplayRate.PerHour,
} as const;
export type DisplayRateName = keyof typeof DISPLAY_RATES;

export const OBJECTIVE_UNITS = {
  items: ObjectiveUnit.Items,
  belts: ObjectiveUnit.Belts,
  wagons: ObjectiveUnit.Wagons,
  machines: ObjectiveUnit.Machines,
} as const;
export type ObjectiveUnitName = keyof typeof OBJECTIVE_UNITS;

export const OBJECTIVE_TYPES = {
  output: ObjectiveType.Output,
  input: ObjectiveType.Input,
  maximize: ObjectiveType.Maximize,
  limit: ObjectiveType.Limit,
} as const;
export type ObjectiveTypeName = keyof typeof OBJECTIVE_TYPES;

function nameOf<T extends number>(
  map: Record<string, T>,
  value: T,
): string | undefined {
  return Object.keys(map).find((key) => map[key] === value);
}

export function displayRateName(value: DisplayRate): string {
  return nameOf(DISPLAY_RATES, value) ?? 'per-minute';
}

/** One row of the solved worksheet. */
export interface StepRow {
  id: string;
  itemId?: string;
  item?: string;
  /** Produced per display rate. */
  items?: Quantity;
  /** Produced but unused, per display rate. */
  surplus?: Quantity;
  belts?: Quantity;
  wagons?: Quantity;
  recipeId?: string;
  recipe?: string;
  machineId?: string;
  machine?: string;
  /** Machines required, unrounded; build this many to hit the rate. */
  machines?: Quantity;
  /** Kilowatts. */
  power?: Quantity;
  pollution?: Quantity;
  /** Fraction of this item consumed by each downstream step; `''` is output. */
  consumedBy?: Record<string, number>;
}

export function stepRow(step: Step, data: AdjustedDataset): StepRow {
  const recipe = step.recipeId ? data.adjustedRecipe[step.recipeId] : undefined;
  const machineId = step.recipeSettings?.machineId ?? recipe?.producers?.[0];
  return prune({
    id: step.id,
    itemId: step.itemId,
    item: step.itemId ? data.itemRecord[step.itemId]?.name : undefined,
    items: quantity(step.items),
    surplus: quantity(step.surplus),
    belts: quantity(step.belts),
    wagons: quantity(step.wagons),
    recipeId: step.recipeId,
    recipe: step.recipeId ? data.recipeRecord[step.recipeId]?.name : undefined,
    machineId,
    machine: machineId ? data.itemRecord[machineId]?.name : undefined,
    machines: quantity(step.machines),
    power: quantity(step.power),
    pollution: quantity(step.pollution),
    consumedBy: record(step.parents),
  });
}

export interface ObjectiveRow {
  id: string;
  targetId: string;
  target?: string;
  value: Quantity;
  unit: ObjectiveUnitName;
  type: ObjectiveTypeName;
}

export function objectiveRow(
  objective: ObjectiveState,
  data: AdjustedDataset,
): ObjectiveRow {
  const target =
    objective.unit === ObjectiveUnit.Machines
      ? data.recipeRecord[objective.targetId]?.name
      : data.itemRecord[objective.targetId]?.name;
  return {
    id: objective.id,
    targetId: objective.targetId,
    target,
    value: quantity(objective.value) ?? { value: 0 },
    unit: (nameOf(OBJECTIVE_UNITS, objective.unit) ??
      'items') as ObjectiveUnitName,
    type: (nameOf(OBJECTIVE_TYPES, objective.type) ??
      'output') as ObjectiveTypeName,
  };
}

/** Drops undefined entries so the agent-facing JSON stays readable. */
export function prune<T extends object>(value: T): T {
  for (const key of Object.keys(value) as (keyof T)[])
    if (value[key] === undefined) delete value[key];
  return value;
}

export interface ModuleRow {
  /** `''` is an empty module slot. */
  id?: string;
  count?: Quantity;
}

export interface BeaconRow {
  id?: string;
  count?: Quantity;
  /** Beacons shared with other machines, when counted that way. */
  total?: Quantity;
  modules?: ModuleRow[];
}

/** The per-recipe overrides set on one recipe. */
export interface RecipeOverrideRow {
  recipeId: string;
  recipe?: string;
  machineId?: string;
  machine?: string;
  fuelId?: string;
  modules?: ModuleRow[];
  beacons?: BeaconRow[];
  /** Percent; 100 is the machine's rated speed. */
  overclock?: Quantity;
  cost?: Quantity;
  /** Percent added to the recipe's output. */
  productivity?: Quantity;
}

/** The per-item overrides set on one item. */
export interface ItemOverrideRow {
  itemId: string;
  item?: string;
  beltId?: string;
  stack?: Quantity;
  wagonId?: string;
  excludeRockets?: boolean;
}

/**
 * Reports a field only when the sheet actually overrides it. The stored state
 * says which fields are overridden; the computed settings say what each one
 * resolves to, which is the more useful of the two to report because the stored
 * form leaves ids implicit wherever they match a default.
 *
 * Callers fall back to the stored value where the computed settings drop a
 * field, as a machine that supports no fuel or no modules does: an override the
 * solver is ignoring is worth reporting rather than hiding.
 */
function ifSet<T>(stored: unknown, resolved: T | undefined): T | undefined {
  return stored == null ? undefined : resolved;
}

function moduleRow(value: ModuleSettings): ModuleRow {
  return prune({ id: value.id, count: quantity(value.count) });
}

function beaconRow(value: BeaconSettings): BeaconRow {
  return prune({
    id: value.id,
    count: quantity(value.count),
    total: quantity(value.total),
    modules: value.modules?.map(moduleRow),
  });
}

export function recipeOverrideRow(
  recipeId: string,
  stored: RecipeState,
  settings: RecipeSettings | undefined,
  data: AdjustedDataset,
): RecipeOverrideRow {
  const machineId = ifSet(
    stored.machineId,
    settings?.machineId ?? stored.machineId,
  );
  return prune({
    recipeId,
    recipe: data.recipeRecord[recipeId]?.name,
    machineId,
    machine: machineId ? data.itemRecord[machineId]?.name : undefined,
    fuelId: ifSet(stored.fuelId, settings?.fuelId ?? stored.fuelId),
    modules: ifSet(stored.modules, settings?.modules ?? stored.modules)?.map(
      moduleRow,
    ),
    beacons: ifSet(stored.beacons, settings?.beacons ?? stored.beacons)?.map(
      beaconRow,
    ),
    overclock: quantity(
      ifSet(stored.overclock, settings?.overclock ?? stored.overclock),
    ),
    cost: quantity(ifSet(stored.cost, settings?.cost ?? stored.cost)),
    productivity: quantity(
      ifSet(stored.productivity, settings?.productivity ?? stored.productivity),
    ),
  });
}

export function itemOverrideRow(
  itemId: string,
  stored: ItemState,
  settings: ItemSettings | undefined,
  data: AdjustedDataset,
): ItemOverrideRow {
  return prune({
    itemId,
    item: data.itemRecord[itemId]?.name,
    beltId: ifSet(stored.beltId, settings?.beltId ?? stored.beltId),
    stack: quantity(ifSet(stored.stack, settings?.stack ?? stored.stack)),
    wagonId: ifSet(stored.wagonId, settings?.wagonId ?? stored.wagonId),
    excludeRockets: ifSet(
      stored.excludeRockets,
      settings?.excludeRockets ?? stored.excludeRockets,
    ),
  });
}
