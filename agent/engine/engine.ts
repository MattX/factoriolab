/* eslint-disable simple-import-sort/imports */
// Must precede every other import: installs the JIT linker and browser globals.
import './shims';

import { EnvironmentInjector } from '@angular/core';

import { datasets, DEFAULT_MOD } from '~/data/datasets';
import { Rational, rational } from '~/rational/rational';
import { ObjectiveState } from '~/state/objectives/objective';
import { ObjectivesStore } from '~/state/objectives/objectives-store';
import { RecipesStore } from '~/state/recipes/recipes-store';
import { AdjustedDataset } from '~/state/settings/dataset';
import { SettingsState } from '~/state/settings/settings-state';
import { SettingsStore } from '~/state/settings/settings-store';
import { Translate } from '~/translate/translate';

import { createInjector, EngineContext } from './bootstrap';
import {
  DISPLAY_RATES,
  DisplayRateName,
  displayRateName,
  ObjectiveRow,
  objectiveRow,
  OBJECTIVE_TYPES,
  OBJECTIVE_UNITS,
  ObjectiveTypeName,
  ObjectiveUnitName,
  Quantity,
  quantity,
  StepRow,
  stepRow,
} from './serialize';

export const SITE = 'https://factoriolab.github.io';

/** Matches the app's route guard for links that predate mod ids in the path. */
const LEGACY_DEFAULT_MOD = '1.1';

export interface ObjectiveSpec {
  /** Item id, or recipe id when `unit` is `machines`. */
  targetId: string;
  /** Rate, in `unit` per the sheet's display rate. Accepts `"1/3"`. */
  value: number | string;
  unit?: ObjectiveUnitName;
  type?: ObjectiveTypeName;
}

export interface SettingsSpec {
  displayRate?: DisplayRateName;
  /** Machine/fuel/module preference order; earlier entries win. */
  machineRankIds?: string[];
  fuelRankIds?: string[];
  moduleRankIds?: string[];
  beltId?: string;
  pipeId?: string;
  excludedRecipeIds?: string[];
  excludedItemIds?: string[];
  researchedTechnologyIds?: string[];
  netProductionOnly?: boolean;
  miningBonus?: number | string;
  researchBonus?: number | string;
  /** Preset index, e.g. minimum vs. maximum machine tier. */
  preset?: number;
}

export interface SheetSpec {
  modId?: string;
  objectives: ObjectiveSpec[];
  settings?: SettingsSpec;
}

export interface SheetEdits {
  modId?: string;
  /** Replaces every objective. */
  setObjectives?: ObjectiveSpec[];
  addObjectives?: ObjectiveSpec[];
  removeObjectiveIds?: string[];
  /** Merged over the sheet's current settings. */
  settings?: SettingsSpec;
}

export interface SheetResult {
  /** Opens this sheet in the FactorioLab web app. */
  url: string;
  modId: string;
  mod?: string;
  displayRate: DisplayRateName;
  status: string;
  objectives: ObjectiveRow[];
  steps: StepRow[];
  totals: {
    machines: { id: string; name?: string; count: Quantity }[];
    belts: { id: string; name?: string; count: Quantity }[];
    power?: Quantity;
    pollution?: Quantity;
  };
  /** Solver or migration notes worth reporting back to the user. */
  notes: string[];
}

export interface SearchHit {
  id: string;
  name: string;
  kind: 'item' | 'recipe';
  /** For recipes, what it consumes and produces, per craft. */
  in?: Record<string, number>;
  out?: Record<string, number>;
  producerIds?: string[];
}

/** Thrown for input the caller can correct, e.g. an unknown item id. */
export class EngineInputError extends Error {}

/**
 * Every store accepts `undefined` to reset itself to its initial state, but
 * each types that argument against its own state, so they only line up as a
 * list through this shape.
 */
interface ResettableStore {
  load(state: undefined): void;
}

export class LabEngine {
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly context: EngineContext,
    private readonly settingsStore: SettingsStore,
    private readonly objectivesStore: ObjectivesStore,
    private readonly recipesStore: RecipesStore,
    private readonly translate: Translate,
    private readonly stores: ResettableStore[],
    private readonly router: SheetRouter,
  ) {}

  static async create(): Promise<LabEngine> {
    const context = await createInjector();
    const { injector } = context;

    const { ItemsStore } = await import('~/state/items/items-store');
    const { MachinesStore } = await import('~/state/machines/machines-store');
    const { TableStore } = await import('~/state/table/table-store');
    const settingsStore = injector.get(SettingsStore);
    const objectivesStore = injector.get(ObjectivesStore);
    const recipesStore = injector.get(RecipesStore);
    const translate = injector.get(Translate);

    const stores = [
      objectivesStore,
      injector.get(ItemsStore),
      recipesStore,
      injector.get(MachinesStore),
      settingsStore,
      injector.get(TableStore),
    ] as unknown as ResettableStore[];

    /**
     * Solver messages arrive as translation keys, so wait for the UI language
     * file. It is a small local read, but bound the wait and carry on either
     * way: untranslated keys degrade a message, they do not break a solve.
     */
    for (let attempt = 0; attempt < 5; attempt++) {
      await context.settle();
      if (Object.keys(translate.data()).length > 0) break;
    }

    const router = await createSheetRouter(injector, context);
    return new LabEngine(
      context,
      settingsStore,
      objectivesStore,
      recipesStore,
      translate,
      stores,
      router,
    );
  }

  /** Serializes calls: the engine drives one shared set of Angular stores. */
  private run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn, fn);
    this.queue = result.catch(() => undefined);
    return result;
  }

  listMods(): { id: string; name: string; game: string }[] {
    return datasets.mods.map((mod) => ({
      id: mod.id,
      name: mod.name,
      game: mod.game,
    }));
  }

  search(
    modId: string,
    query: string,
    kind: 'item' | 'recipe' | 'any' = 'any',
    limit = 25,
  ): Promise<SearchHit[]> {
    return this.run(async () => {
      const data = await this.loadDataset(modId);
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean);

      const collect = (requireAll: boolean): SearchHit[] => {
        const hits: { hit: SearchHit; score: number }[] = [];

        const consider = (
          id: string,
          name: string,
          build: () => SearchHit,
        ): void => {
          const score = scoreMatch(id, name, terms, requireAll);
          if (score != null) hits.push({ hit: build(), score });
        };

        if (kind !== 'recipe')
          for (const id of data.itemIds) {
            const item = data.itemRecord[id];
            consider(id, item.name, () => ({
              id,
              name: item.name,
              kind: 'item',
            }));
          }

        if (kind !== 'item')
          for (const id of data.recipeIds) {
            const recipe = data.recipeRecord[id];
            consider(id, recipe.name, () => ({
              id,
              name: recipe.name,
              kind: 'recipe',
              in: ratios(recipe.in),
              out: ratios(recipe.out),
              producerIds: recipe.producers,
            }));
          }

        hits.sort(
          (a, b) => a.score - b.score || a.hit.id.localeCompare(b.hit.id),
        );
        return hits.slice(0, limit).map((h) => h.hit);
      };

      /**
       * Players use names the game does not, "green circuit" for an electronic
       * circuit being the standard example. When every term has to match there
       * is nothing to show them, so fall back to the best partial matches
       * rather than reporting that the item does not exist.
       */
      const exact = collect(true);
      return exact.length || terms.length < 2 ? exact : collect(false);
    });
  }

  /** Solves a sheet described from scratch. */
  solve(spec: SheetSpec): Promise<SheetResult> {
    return this.run(async () => {
      await this.reset(spec.modId ?? DEFAULT_MOD);
      this.applySettings(spec.settings);
      this.replaceObjectives(spec.objectives);
      return await this.read();
    });
  }

  /** Parses a FactorioLab URL and solves it unchanged. */
  describeSheet(url: string): Promise<SheetResult> {
    return this.run(async () => {
      await this.load(url);
      return await this.read();
    });
  }

  /** Parses a FactorioLab URL, applies edits, and returns the new sheet. */
  editSheet(url: string, edits: SheetEdits): Promise<SheetResult> {
    return this.run(async () => {
      await this.load(url);

      if (edits.modId != null && edits.modId !== this.settingsStore.modId()) {
        const objectives = this.currentObjectives();
        await this.reset(edits.modId);
        this.replaceObjectives(objectives);
      }

      this.applySettings(edits.settings);

      if (edits.setObjectives) this.replaceObjectives(edits.setObjectives);
      for (const id of edits.removeObjectiveIds ?? []) {
        if (this.objectivesStore.state()[id] == null)
          throw new EngineInputError(
            `This sheet has no objective '${id}'. Present: ${
              Object.keys(this.objectivesStore.state()).join(', ') || 'none'
            }.`,
          );
        this.objectivesStore.remove(id);
      }
      for (const objective of edits.addObjectives ?? [])
        this.objectivesStore.add(this.toObjective(objective));

      return await this.read();
    });
  }

  private currentObjectives(): ObjectiveSpec[] {
    const state = this.objectivesStore.state();
    return Object.keys(state).map((id) => {
      const objective = state[id];
      const row = objectiveRow(objective, this.dataset());
      return {
        targetId: row.targetId,
        value: row.value.exact ?? row.value.value,
        unit: row.unit,
        type: row.type,
      };
    });
  }

  private async reset(modId: string): Promise<void> {
    if (!datasets.mods.some((mod) => mod.id === modId))
      throw new EngineInputError(
        `Unknown mod set '${modId}'. Use list_mods for the available ids.`,
      );

    for (const store of this.stores) store.load(undefined);
    this.settingsStore.apply({ modId });
    await this.settleData();
    this.assertDataLoaded(modId);
  }

  private async load(url: string): Promise<void> {
    for (const store of this.stores) store.load(undefined);
    await this.router.load(url);
  }

  private async loadDataset(modId: string): Promise<AdjustedDataset> {
    if (this.settingsStore.modId() !== modId) await this.reset(modId);
    return this.dataset();
  }

  /** Waits for mod data requests as well as queued effects. */
  private settleData(): Promise<void> {
    return this.context.settle(() => this.settingsStore.loading());
  }

  private dataset(): AdjustedDataset {
    return this.recipesStore.adjustedDataset();
  }

  private assertDataLoaded(modId: string): void {
    if (this.settingsStore.modData() == null)
      throw new EngineInputError(
        `Failed to load data for mod set '${modId}'. Expected public/data/${modId}/data.json.`,
      );
  }

  private applySettings(settings: SettingsSpec | undefined): void {
    if (settings == null) return;

    const partial: Partial<SettingsState> = {};
    const data = this.dataset();

    if (settings.displayRate != null) {
      const displayRate = DISPLAY_RATES[settings.displayRate];
      if (displayRate == null)
        throw new EngineInputError(
          `Unknown display rate '${settings.displayRate}'. Use one of: ${Object.keys(DISPLAY_RATES).join(', ')}.`,
        );
      partial.displayRate = displayRate;
    }

    if (settings.machineRankIds)
      partial.machineRankIds = this.checkIds(
        settings.machineRankIds,
        data.itemRecord,
        'machine',
      );
    if (settings.fuelRankIds)
      partial.fuelRankIds = this.checkIds(
        settings.fuelRankIds,
        data.itemRecord,
        'fuel',
      );
    if (settings.moduleRankIds)
      partial.moduleRankIds = this.checkIds(
        settings.moduleRankIds,
        data.itemRecord,
        'module',
      );
    if (settings.beltId != null)
      partial.beltId = this.checkIds(
        [settings.beltId],
        data.itemRecord,
        'belt',
      )[0];
    if (settings.pipeId != null)
      partial.pipeId = this.checkIds(
        [settings.pipeId],
        data.itemRecord,
        'pipe',
      )[0];
    if (settings.excludedRecipeIds)
      partial.excludedRecipeIds = new Set(
        this.checkIds(settings.excludedRecipeIds, data.recipeRecord, 'recipe'),
      );
    if (settings.excludedItemIds)
      partial.excludedItemIds = new Set(
        this.checkIds(settings.excludedItemIds, data.itemRecord, 'item'),
      );
    if (settings.researchedTechnologyIds)
      partial.researchedTechnologyIds = new Set(
        settings.researchedTechnologyIds,
      );
    if (settings.netProductionOnly != null)
      partial.netProductionOnly = settings.netProductionOnly;
    if (settings.miningBonus != null)
      partial.miningBonus = toRational(settings.miningBonus, 'miningBonus');
    if (settings.researchBonus != null)
      partial.researchBonus = toRational(
        settings.researchBonus,
        'researchBonus',
      );
    if (settings.preset != null) partial.preset = settings.preset;

    this.settingsStore.apply(partial);
  }

  private checkIds(
    ids: string[],
    known: Record<string, unknown>,
    label: string,
  ): string[] {
    const missing = ids.filter((id) => known[id] == null);
    if (missing.length)
      throw new EngineInputError(
        `Unknown ${label} id${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}. Use search_ids to find the right id.`,
      );
    return ids;
  }

  private replaceObjectives(objectives: ObjectiveSpec[]): void {
    this.objectivesStore.set({});
    for (const objective of objectives)
      this.objectivesStore.add(this.toObjective(objective));
  }

  private toObjective(spec: ObjectiveSpec): Omit<ObjectiveState, 'id'> {
    const unitName = spec.unit ?? 'items';
    const unit = OBJECTIVE_UNITS[unitName];
    if (unit == null)
      throw new EngineInputError(
        `Unknown objective unit '${unitName}'. Use one of: ${Object.keys(OBJECTIVE_UNITS).join(', ')}.`,
      );
    const typeName = spec.type ?? 'output';
    const type = OBJECTIVE_TYPES[typeName];
    if (type == null)
      throw new EngineInputError(
        `Unknown objective type '${typeName}'. Use one of: ${Object.keys(OBJECTIVE_TYPES).join(', ')}.`,
      );

    const data = this.dataset();
    const known =
      unit === OBJECTIVE_UNITS.machines
        ? data.recipeRecord[spec.targetId]
        : data.itemRecord[spec.targetId];
    if (known == null)
      throw new EngineInputError(
        `Unknown ${unit === OBJECTIVE_UNITS.machines ? 'recipe' : 'item'} id '${spec.targetId}' in mod set '${this.settingsStore.modId() ?? ''}'. Use search_ids to find the right id.`,
      );

    return {
      targetId: spec.targetId,
      value: toRational(spec.value, 'objective value'),
      unit,
      type,
    };
  }

  private async read(): Promise<SheetResult> {
    await this.settleData();

    const data = this.dataset();
    const result = this.objectivesStore.matrixResult();
    const notes = this.context.warnings.take();

    const message = this.objectivesStore.message();
    if (message != null) {
      const params = message.params;
      for (const key of [message.summary, message.detail]) {
        if (key == null) continue;
        const text = plainText(this.translate.get(key, params));
        if (text && !notes.includes(text)) notes.push(text);
      }
    }
    if (result.resultType !== 'solved' && result.resultType !== 'skipped')
      notes.push(
        `Solver returned '${result.resultType}'${result.simplexStatus ? ` (${result.simplexStatus})` : ''}. ` +
          (result.unboundedRecipeId
            ? `Recipe '${result.unboundedRecipeId}' is unbounded.`
            : 'No solution was produced.'),
      );

    const totals = this.objectivesStore.totals();
    const objectives = this.objectivesStore.state();

    return {
      url: await this.router.url(),
      modId: this.settingsStore.modId() ?? DEFAULT_MOD,
      mod: datasets.mods.find((m) => m.id === this.settingsStore.modId())?.name,
      displayRate: displayRateName(
        this.settingsStore.displayRate(),
      ) as DisplayRateName,
      status: result.resultType,
      objectives: Object.keys(objectives).map((id) =>
        objectiveRow(objectives[id], data),
      ),
      steps: this.objectivesStore.steps().map((step) => stepRow(step, data)),
      totals: {
        machines: Object.keys(totals.machines).map((id) => ({
          id,
          name: data.itemRecord[id]?.name,
          count: quantity(totals.machines[id].total) ?? { value: 0 },
        })),
        belts: Object.keys(totals.belts).map((id) => ({
          id,
          name: data.itemRecord[id]?.name,
          count: quantity(totals.belts[id].total) ?? { value: 0 },
        })),
        power: quantity(totals.power),
        pollution: quantity(totals.pollution),
      },
      notes,
    };
  }
}

/** Solver messages are authored as HTML for the web UI. */
function plainText(value: string): string {
  return value
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function ratios(
  values: Partial<Record<string, Rational>>,
): Record<string, number> | undefined {
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(values))
    if (value != null) result[key] = value.toNumber();
  return Object.keys(result).length ? result : undefined;
}

function scoreMatch(
  id: string,
  name: string,
  terms: string[],
  requireAll: boolean,
): number | undefined {
  const haystack = `${id} ${name}`.toLowerCase();
  const matched = terms.filter((term) => haystack.includes(term)).length;
  if (requireAll ? matched < terms.length : matched === 0) return undefined;

  const lowerId = id.toLowerCase();
  const lowerName = name.toLowerCase();
  const joined = terms.join(' ');
  /**
   * Quality variants share their base item's name and would otherwise fill the
   * results, so they sort behind it. An agent asking for quality can still find
   * them by the `name(n)` id.
   */
  const quality = /\(\d+\)$/.test(id) ? 0.5 : 0;
  // Rank whole-query hits first, then by how much of the query matched.
  const missed = terms.length - matched;
  if (lowerId === joined) return 0;
  if (lowerName === joined) return 1 + quality;
  if (lowerId.startsWith(joined) || lowerName.startsWith(joined))
    return 2 + quality;
  return 3 + quality + missed * 10 + id.length / 1000;
}

function toRational(value: number | string, label: string): Rational {
  try {
    return rational(typeof value === 'number' ? value : value.trim());
  } catch {
    throw new EngineInputError(
      `Could not read ${label} '${String(value)}'. Use a number or a fraction such as "1/3".`,
    );
  }
}

/** Parses and serializes sheet URLs using the app's own router logic. */
interface SheetRouter {
  load(url: string): Promise<void>;
  url(): Promise<string>;
}

async function createSheetRouter(
  injector: EnvironmentInjector,
  context: EngineContext,
): Promise<SheetRouter> {
  const { RouterSync } = await import('~/state/router/router-sync');
  const { Migration } = await import('~/state/router/migration');
  const { SettingsStore: Settings } =
    await import('~/state/settings/settings-store');
  const { ObjectivesStore: Objectives } =
    await import('~/state/objectives/objectives-store');
  const { ItemsStore } = await import('~/state/items/items-store');
  const { RecipesStore } = await import('~/state/recipes/recipes-store');
  const { MachinesStore } = await import('~/state/machines/machines-store');
  const { TableStore } = await import('~/state/table/table-store');

  const routerSync = injector.get(RouterSync);
  const migration = injector.get(Migration);
  const settingsStore = injector.get(Settings);
  const objectivesStore = injector.get(Objectives);
  const itemsStore = injector.get(ItemsStore);
  const recipesStore = injector.get(RecipesStore);
  const machinesStore = injector.get(MachinesStore);
  const tableStore = injector.get(TableStore);

  return {
    async load(url: string): Promise<void> {
      const { modId, search } = splitUrl(url);
      const params = await routerSync.unzipQueryParams(
        routerSync.toParams(search),
      );
      const migrated = migration.migrate(modId, params);
      /**
       * Legacy links carry no mod set in the path and older migrations cannot
       * always infer one. The app's route guard settles those on Factorio 1.1,
       * so do the same rather than silently reading them as Space Age.
       */
      const resolvedModId = migrated.modId ?? LEGACY_DEFAULT_MOD;

      settingsStore.apply({ modId: resolvedModId });
      await context.settle(() => settingsStore.loading());

      const modData = settingsStore.modData();
      const modHash = settingsStore.modHash();
      if (modData == null || modHash == null)
        throw new EngineInputError(
          `Failed to load data for mod set '${resolvedModId}' referenced by the sheet URL.`,
        );

      routerSync.updateState(
        resolvedModId,
        migrated.params,
        migrated.isBare,
        modData,
        modHash,
      );
      await context.settle(() => settingsStore.loading());
    },

    async url(): Promise<string> {
      const modHash = settingsStore.modHash();
      const modId = settingsStore.modId() ?? DEFAULT_MOD;
      if (modHash == null) return `${SITE}/${modId}/list`;

      const zipState = routerSync.zipState({
        objectives: objectivesStore.state(),
        items: itemsStore.state(),
        recipes: recipesStore.state(),
        machines: machinesStore.state(),
        settings: settingsStore.state(),
        table: tableStore.state(),
        data: settingsStore.dataset(),
        hash: modHash,
      });
      const params = await routerSync.getHash(zipState);
      const search = routerSync.toString(params as Record<string, string>);
      return `${SITE}/${modId}/list${search ? `?${search}` : ''}`;
    },
  };
}

/** Accepts a full FactorioLab URL, a path, or a bare query string. */
function splitUrl(url: string): { modId?: string; search: string } {
  const trimmed = url.trim();
  let path = trimmed;
  let search = '';

  const queryIndex = trimmed.indexOf('?');
  if (queryIndex >= 0) {
    path = trimmed.slice(0, queryIndex);
    search = trimmed.slice(queryIndex + 1);
  } else if (/^[a-z0-9]+=/i.test(trimmed)) {
    path = '';
    search = trimmed;
  }

  search = search.replace(/#.*$/, '');

  const segments = path
    .replace(/^https?:\/\/[^/]+/i, '')
    .split('/')
    .filter(Boolean);
  // Drop the trailing view segment, e.g. `/2x1/list`.
  const views = new Set(['list', 'flow', 'data', 'matrix']);
  const modId = segments.filter((s) => !views.has(s)).pop();

  return { modId, search };
}
