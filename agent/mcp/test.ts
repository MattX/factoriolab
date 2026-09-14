/* eslint-disable simple-import-sort/imports */
// Must precede every other import: installs the JIT linker and browser globals.
import '../engine/shims';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Drives the MCP server the way a client would: over stdio, through the real
 * protocol. `agent/test.ts` covers the engine itself, so this only checks that
 * the tools are exposed, arguments are validated, and results survive the trip.
 *
 * Run with `npm run agent:build && npm run agent:test:mcp`.
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

/** The subset of a solved sheet this test inspects. */
interface SheetPayload {
  url?: string;
  status?: string;
  displayRate?: string;
  steps?: unknown[];
  omittedSteps?: number;
  objectives?: unknown[];
}

interface ToolOutcome<T> {
  ok: boolean;
  text: string;
  data: T;
}

async function main(): Promise<void> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const transport = new StdioClientTransport({
    command: process.execPath.includes('bun') ? process.execPath : 'bun',
    args: [path.join(here, 'server.js')],
  });

  const client = new Client({ name: 'factoriolab-mcp-test', version: '1.0.0' });
  await client.connect(transport);

  const call = async <T>(
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolOutcome<T>> => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as { text: string }[])[0]?.text ?? '';
    let data = {} as T;
    if (res.isError !== true) {
      try {
        data = JSON.parse(text) as T;
      } catch {
        data = {} as T;
      }
    }
    return { ok: res.isError !== true, text, data };
  };

  console.log('tool discovery');
  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name).sort();
  equal(
    'exposes the expected tools',
    names.join(','),
    'describe_sheet,edit_sheet,list_mods,search_ids,solve_sheet',
  );
  check(
    'every tool is described',
    tools.tools.every((t) => (t.description?.length ?? 0) > 0),
  );

  console.log('list_mods');
  const mods = await call<{ id: string }[]>('list_mods', {});
  check(
    'returns mod sets',
    Array.isArray(mods.data) && mods.data.some((m) => m.id === '2x1'),
    mods.text.slice(0, 120),
  );

  console.log('search_ids');
  const search = await call<{ id: string }[]>('search_ids', {
    modId: '2x1',
    query: 'electronic-circuit',
    kind: 'item',
    limit: 3,
  });
  check(
    'finds the item',
    search.data[0]?.id === 'electronic-circuit',
    search.text.slice(0, 160),
  );

  console.log('solve_sheet');
  const solved = await call<SheetPayload>('solve_sheet', {
    modId: '1.1',
    objectives: [{ targetId: 'electronic-circuit', value: 60 }],
    maxSteps: 3,
  });
  check(
    'solves',
    solved.ok && solved.data.status === 'solved',
    solved.text.slice(0, 200),
  );
  equal('respects maxSteps', solved.data.steps?.length, 3);
  check(
    'reports what it omitted',
    (solved.data.omittedSteps ?? 0) > 0,
    solved.data.omittedSteps,
  );
  check(
    'returns a shareable url',
    typeof solved.data.url === 'string' &&
      solved.data.url.startsWith('https://factoriolab.github.io/1.1/list?'),
    solved.data.url,
  );

  console.log('edit_sheet');
  const edited = await call<SheetPayload>('edit_sheet', {
    url: solved.data.url ?? '',
    addObjectives: [{ targetId: 'copper-plate', value: 30 }],
    settings: { displayRate: 'per-second' },
  });
  equal('adds the objective', edited.data.objectives?.length, 2);
  equal('applies the setting', edited.data.displayRate, 'per-second');

  console.log('describe_sheet');
  const described = await call<SheetPayload>('describe_sheet', {
    url: edited.data.url ?? '',
  });
  equal('round trips the url', described.data.url, edited.data.url);
  equal('round trips objectives', described.data.objectives?.length, 2);

  console.log('error handling');
  const badId = await call<SheetPayload>('solve_sheet', {
    objectives: [{ targetId: 'not-a-thing', value: 1 }],
  });
  check('reports unknown ids as an error', !badId.ok, badId.text);
  check('says how to recover', badId.text.includes('search_ids'), badId.text);

  const malformed = await call<SheetPayload>('solve_sheet', {
    objectives: [{ targetId: 'coal' }],
  });
  check(
    'rejects arguments that do not match the schema',
    !malformed.ok,
    malformed.text,
  );
  check(
    'names the offending field',
    malformed.text.includes('objectives[0].value'),
    malformed.text,
  );

  await client.close();

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
