/**
 * Emits a tsconfig next to the compiled output so the runtime resolves the
 * app's `~/*` imports against the compiled sources rather than the TypeScript
 * ones. Without it the runtime would re-transpile `src` itself, which is what
 * the engine's tsconfig comment warns about.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const buildDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '.build',
);

if (!fs.existsSync(buildDir))
  throw new Error(`Expected compiled output at ${buildDir}. Run tsc first.`);

fs.writeFileSync(
  path.join(buildDir, 'tsconfig.json'),
  JSON.stringify(
    { compilerOptions: { baseUrl: '.', paths: { '~/*': ['./src/*'] } } },
    null,
    2,
  ) + '\n',
);

console.log(`Wrote ${path.join(buildDir, 'tsconfig.json')}`);
