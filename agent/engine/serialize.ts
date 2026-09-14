// Must precede every other import: installs the JIT linker and browser globals.
import './shims';

import { Rational } from '~/rational/rational';
import { Step } from '~/solver/step';
import { ObjectiveState } from '~/state/objectives/objective';
import { ObjectiveType } from '~/state/objectives/objective-type';
import { ObjectiveUnit } from '~/state/objectives/objective-unit';
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
