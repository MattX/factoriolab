# FactorioLab for LLM agents

An MCP server that lets an agent build, read, and edit FactorioLab worksheets
without a browser. It runs the app's own solver, settings, and URL format, so
results match what the web app shows and every sheet is a link a person can
open.

## Why this shape

A worksheet is fully described by its URL. The app encodes objectives and every
setting into the query string and decodes them back, so the engine needs no
database and no session: each tool call takes a URL in and hands a URL back.
That covers both uses of this server. Ask a throwaway question and ignore the
link; build a reference sheet and share it.

Nothing is reimplemented. The engine constructs the app's real Angular services
outside the browser and calls them:

| Concern                  | Owner in the app                                        |
| ------------------------ | ------------------------------------------------------- |
| Recipe and machine math  | `Adjustment` (`src/state/adjustment.ts`)                |
| Solving                  | `Solver` (`src/solver/solver.ts`), GLPK via WebAssembly |
| Reading and writing URLs | `RouterSync`, `Migration` (`src/state/router/`)         |
| Mod data                 | `public/data/<mod>/data.json`, read from disk           |

## Setup

```sh
npm install
npm run agent:build
```

Then point an MCP client at the server. For Claude Code:

```sh
claude mcp add factoriolab -- bun /absolute/path/to/factoriolab/agent/.build/agent/mcp/server.js
```

Or in a client that reads JSON config:

```json
{
  "mcpServers": {
    "factoriolab": {
      "command": "bun",
      "args": ["/absolute/path/to/factoriolab/agent/.build/agent/mcp/server.js"]
    }
  }
}
```

Rerun `npm run agent:build` after changing anything under `src/` or `agent/`.

## Tools

| Tool             | Purpose                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------- |
| `list_mods`      | The game and mod-set ids. `2x1` is Factorio with Space Age, and the default.                |
| `search_ids`     | Find item and recipe ids by name. Ids differ per mod set, so call this before guessing one. |
| `solve_sheet`    | Build a sheet from objectives and settings, and solve it.                                   |
| `describe_sheet` | Read an existing sheet URL, including links from older versions.                            |
| `edit_sheet`     | Change objectives, settings, or overrides on a sheet URL and re-solve.                      |

Every solve returns the required machines, item rates, power, pollution, and a
`url` that reopens the sheet at factoriolab.github.io.

Objectives take a `type`: `output` produces a rate, `limit` caps one, `input`
supplies one, and `maximize` produces as much as possible, which needs at least
one `limit` to bound it. Rates are per the sheet's display rate, and exact
fractions such as `"1/3"` are accepted and preserved.

## Settings and overrides

`settings` covers the whole sheet: the display rate, the machine, fuel and
module preference order, excluded recipes, and so on. `recipeOverrides` and
`itemOverrides` pin one recipe or one item against those preferences, which is
what the web app's per-step controls do:

| Override                                                       | Applies to |
| -------------------------------------------------------------- | ---------- |
| `machineId`, `fuelId`, `modules`, `beacons`, `overclock`       | one recipe |
| `cost` (how hard the solver avoids the recipe), `productivity` | one recipe |
| `beltId` (a pipe, for a fluid), `stack`, `wagonId`             | one item   |
| `excludeRockets`                                               | one item   |

```json
{
  "modId": "2x1",
  "objectives": [{ "targetId": "electronic-circuit", "value": 600 }],
  "recipeOverrides": {
    "copper-cable": {
      "machineId": "assembling-machine-3",
      "modules": [{ "id": "speed-module-3", "count": 4 }],
      "beacons": [{ "id": "beacon", "count": 8, "modules": [{ "id": "speed-module-3" }] }]
    }
  },
  "itemOverrides": { "copper-cable": { "beltId": "express-transport-belt" } }
}
```

Overrides are stored as the difference from the sheet's own defaults, the way
the app stores them, so pinning a value that already is the default changes
nothing, and a later change to `settings` still moves everything that was not
pinned. Every solve reports the overrides in effect under `recipeOverrides` and
`itemOverrides`, and an id or a module a machine cannot take is rejected along
with the list of ids that would have worked.

On `edit_sheet`, overrides are merged over the sheet's own. Passing `null` for a
field drops that one override; `resetRecipeIds` and `resetItemIds` drop every
override on the ids they name.

## Tests

```sh
npm run agent:build
npm run agent:test      # engine: ratios, urls, migrations, errors
npm run agent:test:mcp  # the server over stdio, as a client sees it
```

The engine tests assert the game's own ratios, so a failure means the data or
the solver changed, not just this code.

## How it runs outside the browser

Four things stand between the app and Node, and each is handled in
`agent/engine/`:

- **Browser globals.** `shims.ts` installs the little that the state layer
  touches: `localStorage`, and enough of `document` for the theming effect. It
  also loads Angular's JIT linker, which is why every entry point imports it
  first.
- **Dependency injection.** `providers.ts` builds a root injector with the app's
  real services, swapping in a filesystem-backed `HttpClient` for mod data, a
  warning collector for the CDK confirm dialog, and inert stubs for the router,
  title, and change-detection scheduler.
- **Change detection.** Nothing calls `ApplicationRef.tick`, so `bootstrap.ts`
  drives Angular's effect scheduler directly and waits for resource loads to
  finish rather than guessing at a number of passes.
- **Transpilation.** The app's `Store` base class reads a constructor parameter
  property from a field initializer, and esbuild-family transpilers (Bun, tsx)
  emit those two assignments in the opposite order to `tsc`, which silently
  yields an undefined state signal. So `agent/tsconfig.json` compiles with `tsc`
  and the output is what runs. Bun is used only to execute the compiled
  JavaScript, because it resolves the app's `~/` import alias.

## Limits

- Mod data comes from this repository, so a sheet can only use mod sets present
  in `public/data`.
- Custom mod sets uploaded through the web app's editor are stored in browser
  storage and are not reachable from here.
- Overrides on an objective's own recipe row, which the web app allows for
  `machines` objectives, are not exposed; `recipeOverrides` covers the recipe
  wherever else it appears.
- Machine-wide defaults, which the web app sets on its settings page, are not
  exposed either, so a module loadout meant for every assembler has to be set
  per recipe or approached through `moduleRankIds`.
- Links with no mod set in the path resolve to Factorio 1.1, matching the app's
  own route guard.
