import { dirname, relative, resolve } from 'node:path';
import type { ScipDatabase } from '../../storage/db.js';
import { resolveSymbol } from '../../symbols/symbol-lookup.js';
import { isFunctionLikeSymbol, leafName, shortenSymbol } from '../../symbols/symbol-parser.js';
import { scipFunctionLikeKindNumbers, scipKindName } from '../../symbols/symbol-kind.js';
import { cleanSignature, extractSignature } from '../../storage/scip-rows.js';
import { isExportedDefinition } from './passthrough-candidates.js';

/**
 * twin-ab (Q4): mechanical support for scip-integrity-audit drill 5
 * ("cross-examine same-concept twins" — feed both the same input and
 * require the same answer). v1 is a scaffold generator, not an executor:
 * generating realistic inputs for arbitrary types is a rabbit hole, so this
 * resolves both referents, verifies they are callable and importable, and
 * emits a ready-to-fill vitest file — the agent fills the input table and
 * runs it.
 */

export interface TwinAbSymbol {
  ref: string;
  symbol: string;
  shortName: string;
  file: string;
  startLine: number;
  /** Cleaned SCIP signature text (e.g. `(value: string): string`); null when the index has none. */
  signature: string | null;
  /** Top-level parameter count parsed from `signature`; null when unparseable. */
  paramCount: number | null;
}

export interface TwinAbSuccess {
  ok: true;
  a: TwinAbSymbol;
  b: TwinAbSymbol;
  /** Null when either side's param count is unknown — compatibility cannot be judged. */
  signatureCompatible: boolean | null;
  testSource: string;
}

export interface TwinAbRefusal {
  ok: false;
  reason: string;
}

export type TwinAbOutcome = TwinAbSuccess | TwinAbRefusal;

const FUNCTION_LIKE_KINDS = new Set(scipFunctionLikeKindNumbers());

/**
 * Project-root-relative default `--out` path when the caller doesn't pass
 * one — a deterministic, ref-derived path under a dedicated generated-
 * artifacts directory, mirroring `tla scaffold`'s convention of a fixed
 * project-relative directory (`specs/<moduleName>`) rather than an OS tmp
 * dir. Derived from the raw ref strings (not the resolved symbols) so the
 * caller can compute it before resolution — `twinAb` needs the output path
 * up front to compute import specifiers.
 */
export function defaultTwinAbOutPath(refA: string, refB: string): string {
  return `tests/generated/twin-ab/${slugifyRef(refA)}-vs-${slugifyRef(refB)}.test.ts`;
}

function slugifyRef(ref: string): string {
  const leaf = ref.split(/[/#]/).pop() || ref;
  const slug = leaf.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'symbol';
}

/**
 * `outFile` is the absolute path the caller intends to write the generated
 * vitest file to — needed up front so the generated `import` specifiers are
 * correct relative paths, not just the twin's own file paths.
 */
export function twinAb(db: ScipDatabase, refA: string, refB: string, outFile: string): TwinAbOutcome {
  const a = resolveTwinAbSymbol(db, refA);
  if (!a.ok) return a;
  const b = resolveTwinAbSymbol(db, refB);
  if (!b.ok) return b;

  const signatureCompatible =
    a.symbol.paramCount === null || b.symbol.paramCount === null ? null : a.symbol.paramCount === b.symbol.paramCount;

  const testSource = renderTwinAbTest(a.symbol, b.symbol, db.config.projectRoot, outFile, signatureCompatible);
  return { ok: true, a: a.symbol, b: b.symbol, signatureCompatible, testSource };
}

function resolveTwinAbSymbol(db: ScipDatabase, ref: string): { ok: true; symbol: TwinAbSymbol } | TwinAbRefusal {
  const resolution = resolveSymbol(db, ref);
  const match = resolution.match;
  if (!match) {
    return { ok: false, reason: `${ref} does not resolve to an indexed symbol.` };
  }

  const kindRow = db.get<{ kind: number | null }>('SELECT kind FROM global_symbols WHERE id = ?', match.symbolId);
  const kind = kindRow?.kind ?? null;
  // `kind` is authoritative when the indexer populates it, but several
  // indexers don't — scip-typescript leaves it null on every row of this
  // project's own real index (verified directly: 16,370/16,370 rows null).
  // Matching every other kind-gated check in this codebase (e.g.
  // conformance.ts's validateActionReferentKind, which returns "can't
  // judge" rather than "refuse" on a null kind), fall back to the
  // symbol-string-shape heuristic instead of refusing everything.
  const isCallable = kind !== null ? FUNCTION_LIKE_KINDS.has(kind) : isFunctionLikeSymbol(match.symbol);
  if (!isCallable) {
    return {
      ok: false,
      reason: `${ref} resolves to ${shortenSymbol(match.symbol)}${kind !== null ? ` with SCIP kind ${scipKindName(kind)}` : ''} — twin-ab compares call outputs, so both referents must be functions or methods.`,
    };
  }

  if (!isExportedDefinition(db, match)) {
    return {
      ok: false,
      reason: `${ref} (${shortenSymbol(match.symbol)} at ${match.relativePath}:${match.startLine + 1}) is not exported — twin-ab needs an importable named binding for both twins.`,
    };
  }

  const docRow = db.get<{ documentation: string | null }>(
    'SELECT documentation FROM global_symbols WHERE id = ?',
    match.symbolId,
  );
  const signature = cleanSignature(extractSignature(docRow?.documentation ?? null));

  return {
    ok: true,
    symbol: {
      ref,
      symbol: match.symbol,
      shortName: leafName(match.symbol) || shortenSymbol(match.symbol),
      file: match.relativePath,
      startLine: match.startLine,
      signature,
      paramCount: signature ? parseTopLevelParamCount(signature) : null,
    },
  };
}

/**
 * Counts top-level comma-separated entries inside the first balanced `(...)`
 * group in a signature string, tracking `(`/`[`/`{` depth so nested default
 * values, destructured params, and object/array types don't split a single
 * parameter into several. Mirrors the balanced-scan style already used by
 * `twin-drift.ts`'s `splitTopLevelStatements`.
 */
function parseTopLevelParamCount(signature: string): number | null {
  const openIndex = signature.indexOf('(');
  if (openIndex === -1) return null;
  let depth = 0;
  let closeIndex = -1;
  for (let i = openIndex; i < signature.length; i += 1) {
    const char = signature[i];
    if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) {
        closeIndex = i;
        break;
      }
    }
  }
  if (closeIndex === -1) return null;
  const inner = signature.slice(openIndex + 1, closeIndex).trim();
  if (!inner) return 0;

  let count = 1;
  let bracketDepth = 0;
  for (const char of inner) {
    if (char === '(' || char === '[' || char === '{') bracketDepth += 1;
    else if (char === ')' || char === ']' || char === '}') bracketDepth = Math.max(0, bracketDepth - 1);
    else if (char === ',' && bracketDepth === 0) count += 1;
  }
  return count;
}

/**
 * `outFile` and `projectRoot` are both absolute; `targetFile` is
 * project-relative (as stored on `SymbolMatch.relativePath`). Resolves
 * `targetFile` against `projectRoot` before computing the relative import
 * specifier from `outFile`'s own directory — `path.relative` requires two
 * comparable paths, and a file's own directory, not the file itself, is
 * what an `import` specifier is resolved against.
 */
function importSpecifierFor(projectRoot: string, outFile: string, targetFile: string): string {
  const outDir = dirname(outFile);
  const absoluteTarget = resolve(projectRoot, targetFile);
  const rel = relative(outDir, absoluteTarget).replace(/\\/g, '/');
  const withJsExtension = rel.replace(/\.tsx?$/, '.js');
  return withJsExtension.startsWith('.') ? withJsExtension : `./${withJsExtension}`;
}

function renderTwinAbTest(
  a: TwinAbSymbol,
  b: TwinAbSymbol,
  projectRoot: string,
  outFile: string,
  signatureCompatible: boolean | null,
): string {
  const importA = importSpecifierFor(projectRoot, outFile, a.file);
  const importB = importSpecifierFor(projectRoot, outFile, b.file);
  const signatureNote =
    signatureCompatible === null
      ? 'Signature comparison: unknown (one or both signatures unavailable in the index) — check by hand.'
      : signatureCompatible
        ? 'Signature comparison: param counts match.'
        : 'Signature comparison: param counts DIFFER — twins may not be directly comparable; check by hand.';

  return `/**
 * Generated by 'scip-query twin-ab'. scip-integrity-audit drill 5
 * ("cross-examine same-concept twins"): where one concept is computed in
 * more than one place, feed both the same input and require the same
 * answer. Disagreement between twins means at least one is wrong —
 * determine which before consolidating.
 *
 * Twin A: ${a.shortName}  (${a.file}:${a.startLine + 1})
 *   ${a.signature ?? '(signature unavailable)'}
 * Twin B: ${b.shortName}  (${b.file}:${b.startLine + 1})
 *   ${b.signature ?? '(signature unavailable)'}
 * ${signatureNote}
 *
 * Fill in the TODO input table below with inputs both twins should agree
 * on, then run this file with vitest.
 */
import { describe, expect, it } from 'vitest';
import { ${a.shortName} as twinA } from '${importA}';
import { ${b.shortName} as twinB } from '${importB}';

// TODO: fill in shared inputs both twins should agree on — one arg array per call.
const inputs: any[][] = [
  // [/* arg1, arg2, ... */],
];

// Cast to a variadic signature so the input table can hold any arg shape —
// the real twins have fixed, non-rest parameter lists, and TS rejects
// spreading a generic args array into those (TS2556) even when the array
// itself is 'any'; casting the callee's signature, not the args, satisfies
// the checker without weakening the twins' real exported types elsewhere.
const callA = twinA as (...callArgs: any[]) => any;
const callB = twinB as (...callArgs: any[]) => any;

describe.skipIf(inputs.length === 0)('twin-ab: ${a.shortName} vs ${b.shortName}', () => {
  it.each(inputs)('agrees on input %#', (...args) => {
    expect(callA(...args)).toEqual(callB(...args));
  });
});
`;
}
