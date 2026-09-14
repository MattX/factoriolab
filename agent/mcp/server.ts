// Must precede every other import: installs the JIT linker and browser globals.
import '../engine/shims';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { EngineInputError, LabEngine, SheetResult } from '../engine/engine';

const objectiveSchema = z.object({
  targetId: z
    .string()
    .describe(
      'Item id, or recipe id when unit is "machines". Ids are mod-set specific; find them with search_ids.',
    ),
  value: z
    .union([z.number(), z.string()])
    .describe(
      'Rate in `unit` per the sheet display rate. Exact fractions such as "1/3" are accepted.',
    ),
  unit: z
    .enum(['items', 'belts', 'wagons', 'machines'])
    .optional()
    .describe('Defaults to "items".'),
  type: z
    .enum(['output', 'input', 'maximize', 'limit'])
    .optional()
    .describe(
      'output: produce this rate. input: treat as an available input. maximize: produce as much as possible, which needs at least one "limit" objective to bound it. limit: cap this rate.',
    ),
});

const settingsSchema = z.object({
  displayRate: z.enum(['per-second', 'per-minute', 'per-hour']).optional(),
  machineRankIds: z
    .array(z.string())
    .optional()
    .describe('Preferred machines, best first, e.g. ["electric-furnace"].'),
  fuelRankIds: z.array(z.string()).optional(),
  moduleRankIds: z
    .array(z.string())
    .optional()
    .describe('Preferred modules, best first, e.g. ["productivity-module-3"].'),
  beltId: z.string().optional(),
  pipeId: z.string().optional(),
  excludedRecipeIds: z
    .array(z.string())
    .optional()
    .describe('Recipes the solver may not use.'),
  excludedItemIds: z.array(z.string()).optional(),
  researchedTechnologyIds: z.array(z.string()).optional(),
  netProductionOnly: z.boolean().optional(),
  miningBonus: z.union([z.number(), z.string()]).optional(),
  researchBonus: z.union([z.number(), z.string()]).optional(),
  preset: z
    .number()
    .optional()
    .describe('Machine tier preset index; 0 is the minimum tier.'),
});

const urlSchema = z
  .string()
  .describe(
    'A FactorioLab sheet URL, as returned by any of these tools. A path or bare query string is also accepted.',
  );

function text(value: unknown): {
  content: { type: 'text'; text: string }[];
} {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 1) }],
  };
}

function failure(err: unknown): {
  content: { type: 'text'; text: string }[];
  isError: true;
} {
  const message =
    err instanceof EngineInputError
      ? err.message
      : `Unexpected engine failure: ${err instanceof Error ? err.message : String(err)}`;
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * Trims a solved sheet for transport. The full step list of a deep recipe tree
 * is long, and an agent that wants every row can ask for more.
 */
function summarize(result: SheetResult, maxSteps: number): unknown {
  const steps = result.steps.slice(0, maxSteps);
  return {
    url: result.url,
    modId: result.modId,
    mod: result.mod,
    displayRate: result.displayRate,
    status: result.status,
    objectives: result.objectives,
    steps,
    omittedSteps:
      result.steps.length > steps.length
        ? result.steps.length - steps.length
        : undefined,
    totals: result.totals,
    notes: result.notes.length ? result.notes : undefined,
  };
}

const maxStepsSchema = z
  .number()
  .int()
  .min(1)
  .max(500)
  .optional()
  .describe('Maximum step rows to return. Defaults to 100.');

async function main(): Promise<void> {
  const engine = await LabEngine.create();

  const server = new McpServer(
    { name: 'factoriolab', version: '1.0.0' },
    {
      instructions: [
        'Computes Factorio (and Satisfactory, DSP, and other supported games) production',
        'ratios using FactorioLab’s own solver.',
        '',
        'A sheet is fully described by its URL, so there is no saved state: every tool',
        'returns a url that reopens the same sheet at factoriolab.github.io, and',
        'describe_sheet or edit_sheet take that url back. Share the url when the user',
        'wants a reference they can open; ignore it when they only want an answer.',
        '',
        'Item and recipe ids differ per mod set. Call search_ids before guessing an id,',
        'and list_mods to pick a mod set (default 2x1, Factorio Space Age).',
      ].join('\n'),
    },
  );

  server.registerTool(
    'list_mods',
    {
      title: 'List mod sets',
      description:
        'Lists the available game and mod-set ids. Use one as modId elsewhere. The default, 2x1, is Factorio with Space Age.',
      inputSchema: {},
    },
    () => text(engine.listMods()),
  );

  server.registerTool(
    'search_ids',
    {
      title: 'Search item and recipe ids',
      description:
        'Finds item and recipe ids by name or id substring within a mod set. Call this before using an id you are not certain of. Recipe results include their inputs, outputs, and the machines that can run them.',
      inputSchema: {
        modId: z.string().describe('Mod set id, e.g. "2x1".'),
        query: z
          .string()
          .describe('Name or id fragment, e.g. "green circuit".'),
        kind: z.enum(['item', 'recipe', 'any']).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ modId, query, kind, limit }) => {
      try {
        return text(
          await engine.search(modId, query, kind ?? 'any', limit ?? 25),
        );
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    'solve_sheet',
    {
      title: 'Solve a new sheet',
      description:
        'Builds a sheet from scratch and solves it, returning the required machines, item rates, power, and a url that reopens the sheet.',
      inputSchema: {
        modId: z.string().optional().describe('Defaults to "2x1".'),
        objectives: z.array(objectiveSchema).min(1),
        settings: settingsSchema.optional(),
        maxSteps: maxStepsSchema,
      },
    },
    async ({ modId, objectives, settings, maxSteps }) => {
      try {
        const result = await engine.solve({ modId, objectives, settings });
        return text(summarize(result, maxSteps ?? 100));
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    'describe_sheet',
    {
      title: 'Read an existing sheet',
      description:
        'Parses a FactorioLab sheet URL and returns its objectives, settings, and solved results. Old links are migrated to the current format.',
      inputSchema: { url: urlSchema, maxSteps: maxStepsSchema },
    },
    async ({ url, maxSteps }) => {
      try {
        return text(
          summarize(await engine.describeSheet(url), maxSteps ?? 100),
        );
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    'edit_sheet',
    {
      title: 'Edit an existing sheet',
      description:
        'Applies changes to a sheet URL and re-solves it, returning a new url. Use setObjectives to replace every objective, or addObjectives and removeObjectiveIds for incremental edits. Settings are merged over the sheet’s own.',
      inputSchema: {
        url: urlSchema,
        modId: z
          .string()
          .optional()
          .describe('Moves the sheet to another mod set, keeping objectives.'),
        setObjectives: z.array(objectiveSchema).optional(),
        addObjectives: z.array(objectiveSchema).optional(),
        removeObjectiveIds: z
          .array(z.string())
          .optional()
          .describe('Objective ids as reported in the objectives list.'),
        settings: settingsSchema.optional(),
        maxSteps: maxStepsSchema,
      },
    },
    async ({ url, maxSteps, ...edits }) => {
      try {
        const result = await engine.editSheet(url, edits);
        return text(summarize(result, maxSteps ?? 100));
      } catch (err) {
        return failure(err);
      }
    },
  );

  await server.connect(new StdioServerTransport());
}

main().catch((err: unknown) => {
  // stdout carries the protocol, so diagnostics must go to stderr.
  console.error('factoriolab MCP server failed to start:', err);
  process.exit(1);
});
