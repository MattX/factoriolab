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
| `edit_sheet`     | Change objectives or settings on a sheet URL and re-solve.                                  |

Every solve returns the required machines, item rates, power, pollution, and a
`url` that reopens the sheet at factoriolab.github.io.

Objectives take a `type`: `output` produces a rate, `limit` caps one, `input`
supplies one, and `maximize` produces as much as possible, which needs at least
one `limit` to bound it. Rates are per the sheet's display rate, and exact
fractions such as `"1/3"` are accepted and preserved.

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
- Per-recipe and per-item overrides round-trip through URLs correctly but are
  not yet exposed as tool arguments; `settings` covers the sheet-wide levers.
- Links with no mod set in the path resolve to Factorio 1.1, matching the app's
  own route guard.
