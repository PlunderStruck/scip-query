import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import fc from 'fast-check';

export type PropertyArea =
  | 'indexing'
  | 'graphs'
  | 'pagination'
  | 'scanner'
  | 'cache'
  | 'suppressions'
  | 'boundaries'
  | 'lifecycle';
export type PropertyTier = 'component' | 'integration' | 'compiler';
export const PROPERTY_TIMEOUT = 1_800_000;

function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer.`);
  return value;
}

function parameters(tier: PropertyTier): fc.Parameters<unknown> {
  const thorough = process.env['SCIP_PROPERTY_PROFILE'] === 'thorough';
  const defaults = {
    component: thorough ? 200_000 : 200,
    integration: thorough ? 200 : 5,
    compiler: thorough ? 30 : 2,
  };
  const seedText = process.env['SCIP_PROPERTY_SEED'];
  const seed = seedText === undefined ? undefined : Number(seedText);
  if (seed !== undefined && (!Number.isSafeInteger(seed) || seed < -2_147_483_648 || seed > 2_147_483_647)) {
    throw new Error('SCIP_PROPERTY_SEED must be a signed 32-bit integer.');
  }
  return {
    numRuns: positiveInteger(`SCIP_PROPERTY_${tier.toUpperCase()}_RUNS`, defaults[tier]),
    includeErrorInReport: true,
    ...(seed === undefined ? {} : { seed }),
    ...(process.env['SCIP_PROPERTY_PATH'] === undefined ? {} : { path: process.env['SCIP_PROPERTY_PATH'] }),
  };
}

/** One receipt counts completed predicate runs, never assertions or sequence steps. */
export async function checkProperty<T>(
  area: PropertyArea,
  name: string,
  property: fc.IProperty<T> | fc.IAsyncProperty<T>,
  tier: PropertyTier = 'component',
): Promise<void> {
  const started = performance.now();
  const result = await fc.check(property, parameters(tier));
  const message = fc.defaultReportMessage(result);
  const receipt = {
    area,
    name,
    tier,
    fastCheckVersion: fc.__version,
    numRuns: result.numRuns,
    numSkips: result.numSkips,
    numShrinks: result.numShrinks,
    failed: result.failed,
    interrupted: result.interrupted,
    seed: result.seed,
    counterexamplePath: result.counterexamplePath,
    counterexample: result.counterexample === null ? null : fc.stringify(result.counterexample),
    failure: message,
    durationMs: performance.now() - started,
  };
  const directory = process.env['SCIP_PROPERTY_RESULTS'];
  if (directory) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `${area}-${randomUUID()}.json`), JSON.stringify(receipt, null, 2) + '\n');
  }
  if (result.failed || result.interrupted)
    throw new Error(message ?? 'Property run interrupted.', { cause: result.errorInstance });
}

// Construct valid text while retaining combining marks, astral characters, control characters and empty inputs.
export const textArbitrary = fc
  .array(
    fc.oneof(
      fc.constantFrom('é', 'e\u0301', '😀', '\n', '\r', '\t', '\0', '中', '\\', '"', "'"),
      fc.integer({ min: 32, max: 126 }).map(String.fromCharCode),
    ),
    { maxLength: 40 },
  )
  .map((parts) => parts.join(''));

export const graphArbitrary = fc.integer({ min: 0, max: 10 }).chain((size) =>
  fc.record({
    size: fc.constant(size),
    edges: fc.array(fc.tuple(fc.nat({ max: Math.max(size - 1, 0) }), fc.nat({ max: Math.max(size - 1, 0) })), {
      maxLength: size * size,
    }),
  }),
);

/** Exhaustive path closure for small test graphs, independent of the production stack/queue algorithms. */
export function reachability(size: number, edges: readonly (readonly [number, number])[]): boolean[][] {
  const paths = Array.from({ length: size }, (_, a) => Array.from({ length: size }, (_, b) => a === b));
  for (const [from, to] of edges) paths[from]![to] = true;
  for (let via = 0; via < size; via += 1) {
    for (let from = 0; from < size; from += 1) {
      for (let to = 0; to < size; to += 1) paths[from]![to] ||= paths[from]![via]! && paths[via]![to]!;
    }
  }
  return paths;
}
