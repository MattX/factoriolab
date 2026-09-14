import './shims';

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EnvironmentInjector,
  Injector,
  ɵEffectScheduler as EffectScheduler,
  ɵINJECTOR_SCOPE as INJECTOR_SCOPE,
} from '@angular/core';
import { loadModule } from 'glpk-ts';

import { CollectedWarnings, engineProviders } from './providers';

/**
 * Walks up from this module to the repository root. This module runs both from
 * source and from `agent/.build`, so the depth is not fixed; the root is the
 * first ancestor holding both the mod data and the installed dependencies.
 */
function findRepoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    if (
      existsSync(path.join(dir, 'public', 'data')) &&
      existsSync(path.join(dir, 'node_modules'))
    )
      return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    'Could not locate the FactorioLab repository root from ' +
      fileURLToPath(import.meta.url),
  );
}

export const REPO_ROOT = findRepoRoot();
export const PUBLIC_DIR = path.join(REPO_ROOT, 'public');

let glpkLoaded: Promise<unknown> | undefined;

/** GLPK's wasm module is global to the process, so load it at most once. */
export function loadGlpk(): Promise<unknown> {
  glpkLoaded ??= loadModule(
    path.join(REPO_ROOT, 'node_modules', 'glpk-wasm', 'dist', 'glpk.all.wasm'),
  );
  return glpkLoaded;
}

export interface EngineContext {
  injector: EnvironmentInjector;
  warnings: CollectedWarnings;
  /**
   * Runs pending effects and lets resource loaders resolve. Pass a predicate
   * reporting whether a load is still in flight; without one this only drains
   * the work already queued.
   */
  settle: (isBusy?: () => boolean) => Promise<void>;
}

/** Mod data files reach several megabytes, so allow a generous ceiling. */
const SETTLE_TIMEOUT_MS = 60_000;
/** Effect passes to run before trusting a quiet `isBusy`, and after it goes quiet. */
const SETTLE_MIN_PASSES = 8;
const SETTLE_QUIET_PASSES = 3;

export async function createInjector(
  publicDir = PUBLIC_DIR,
): Promise<EngineContext> {
  await loadGlpk();

  // Imported lazily so that `./shims` is installed before any app module runs.
  const { Title } = await import('@angular/platform-browser');
  const { SIMPLEX_CONFIG } = await import('~/solver/simplex-config');

  const warnings = new CollectedWarnings();

  /**
   * A root environment injector normally provides itself. `Injector.create`
   * does not, so hand it a lazy self-reference through a holder; the factory
   * only runs once something is injected, necessarily after the assignment
   * below.
   */
  const holder: { injector?: EnvironmentInjector } = {};
  const injector = Injector.create({
    providers: [
      { provide: INJECTOR_SCOPE, useValue: 'root' },
      { provide: SIMPLEX_CONFIG, useValue: { msgLevel: 'off' } },
      {
        provide: EnvironmentInjector,
        useFactory: (): EnvironmentInjector | undefined => holder.injector,
        deps: [],
      },
      ...engineProviders(publicDir, warnings, Title),
    ],
  }) as EnvironmentInjector;
  holder.injector = injector;

  const scheduler = injector.get(EffectScheduler);

  /**
   * The browser flushes effects from `ApplicationRef.tick`. With no application
   * here, drive the scheduler directly and yield to the macrotask queue in
   * between so that resource loaders, which resolve promises, can settle.
   *
   * A fixed number of passes is not enough: a request only starts once the
   * first flush re-evaluates the resource's params, and reading a multi-megabyte
   * mod file takes as long as it takes. So keep going until the caller reports
   * no work in flight and the queue has stayed quiet.
   */
  const settle = async (isBusy?: () => boolean): Promise<void> => {
    const deadline = Date.now() + SETTLE_TIMEOUT_MS;
    let quiet = 0;

    for (let pass = 0; Date.now() < deadline; pass++) {
      scheduler.flush();
      quiet = isBusy?.() ? 0 : quiet + 1;
      if (pass >= SETTLE_MIN_PASSES && quiet >= SETTLE_QUIET_PASSES) return;
      await new Promise((resolve) => setImmediate(resolve));
    }

    throw new Error(
      `Timed out after ${SETTLE_TIMEOUT_MS}ms waiting for FactorioLab data to load.`,
    );
  };

  return { injector, warnings, settle };
}
