/**
 * Identifier-attribution module — one owner of "given a textual identifier
 * hit in file F, which SCIP symbol(s) does it refer to?"
 *
 * Pre-this-module the same logic lived in four places (sourceCandidateLines,
 * importAttributedCandidateLines, findCallerFiles inner loop,
 * dead.ts:resolveLeaf) with subtle drift. Bug fixes in one site silently
 * coexisted with the bug in the others. The Vue support and interface-
 * dispatch fixes from earlier had to touch all four sites separately.
 *
 * The forward call (`attributeIdentifier`) is the core. The inverse views
 * (`findReferences`, `findCallerFiles`) build on it.
 *
 * The disambiguation policy — same-file > direct import > interface-dispatch
 * (all candidates in same imported file) > empty — is owned here. Callers
 * receive the answer, not raw candidates.
 */
import type { ScipDatabase } from '../storage/db.js';
import { findEnclosingDefinition, getDefinitionsForFile } from './definition-catalog.js';
import { getFullSymbolMatch } from './symbol-lookup.js';
import { getGlobalLeafIndex } from './leaf-symbol-index.js';
import type { IndexedDefinition, ReferenceSite, SymbolLocation } from '../domain/types.js';
import { findIdentifierLines, getFileIdentifiers } from './identifier-index.js';
import { createCandidateNameMatcher, sourceMayContainCandidateName } from '../source/source-identifier-prefilter.js';
import { getSourceText } from '../source/source-text.js';
import { getSourceFiles } from '../source/source-fileset.js';
import { leafName } from './symbol-parser.js';
import { pathsResolveSame } from '../domain/path-normalization.js';
import { sourceImportPathsByLocalName } from '../language-parsers/import-index.js';
import type { SymbolSemanticEvidencePort } from './semantic-evidence-port.js';

// ── Public types ─────────────────────────────────────────────────

interface SymbolRef {
  symbolId: number;
  symbol: string;
  /** Defining file of the symbol. */
  relativePath: string;
}

// ── Forward: per-occurrence attribution ──────────────────────────

/**
 * What symbol(s) does identifier `name` in file `file` refer to?
 *
 * Returns the symbols this textual hit reasonably resolves to. May
 * return >1 entry when an interface and one or more impls all live
 * in the same imported file (runtime dispatch could land on any).
 * Returns [] when the leaf is ambiguous and no disambiguation
 * signal applies.
 */
// scip-query: ignore-extract — this is an ordered resolution strategy stack:
// unique leaf, same-file, direct import, then indirect factory/method access.
// Splitting the strategy order would make attribution rules harder to audit.
export function attributeIdentifier(db: ScipDatabase, file: string, identifier: string): SymbolRef[] {
  const bucket = getGlobalLeafIndex(db).get(identifier);
  if (!bucket || bucket.length === 0) return [];

  if (bucket.length === 1) return [toSymbolRef(bucket[0]!)];

  // 1. Same-file resolution wins outright. Credit every same-file
  // candidate — a Rust struct's field and a method on that struct can
  // share a name (e.g. `pub line_ending: T` + `fn line_ending(self, ...)`)
  // and a textual hit could resolve to either at runtime, so both must
  // count for dead-code purposes. `find` previously dropped one of them.
  const sameFile = bucket.filter((e) => e.file === file);
  if (sameFile.length > 0) return sameFile.map(toSymbolRef);

  // 2. Direct import: refFile imports `identifier` by name from a path
  // that matches a candidate's defining file. Credit ALL candidates in
  // that file (interface dispatch could land on any impl at runtime).
  const importsByName = sourceImportPathsByLocalName(db, file);
  const directlyImportedFrom = importsByName.get(identifier);
  if (directlyImportedFrom) {
    for (const sourcePath of directlyImportedFrom) {
      const matches = bucket.filter((e) => pathsResolveSame(sourcePath, e.file));
      if (matches.length > 0) return matches.map(toSymbolRef);
    }
  }

  // 3. Indirect access (factory / method-on-instance). The leaf isn't
  // imported by name, but the consumer imports SOMETHING from a file
  // where ALL the leaf's candidates live — a textual hit on the leaf in
  // this consumer is most likely a method call on an instance whose
  // type comes from that file. Example: tests import getPaymentProcessor
  // from provider.ts, then call processor.createIntent(...). Credit all
  // candidates in the imported file.
  const allImportedSourcePaths = new Set<string>();
  for (const set of importsByName.values()) for (const p of set) allImportedSourcePaths.add(p);
  for (const sourcePath of allImportedSourcePaths) {
    const matches = bucket.filter((e) => pathsResolveSame(sourcePath, e.file));
    if (matches.length > 0 && matches.length === bucket.length) {
      return matches.map(toSymbolRef);
    }
  }

  return [];
}

/**
 * Permissive variant of `attributeIdentifier` for dead-code analysis.
 *
 * The strict version returns `[]` when an identifier could resolve to
 * multiple candidates and no scope signal disambiguates. That's the right
 * call for refs/dataflow (precision), but the wrong call for dead-code:
 * a textual hit on a method leaf almost always lands on *one* of the
 * candidates at runtime — we just can't tell which. Returning `[]`
 * wrongly leaves every candidate without a reference and they all look
 * dead.
 *
 * Bias: prefer false negatives (live code stays live) over false
 * positives (deleting referenced code).
 */
export function attributeIdentifierPermissive(db: ScipDatabase, file: string, identifier: string): SymbolRef[] {
  const strict = attributeIdentifier(db, file, identifier);
  if (strict.length > 0) return strict;
  // Strict returned empty → ambiguous textual hit. Credit every candidate:
  // each one *could* be the runtime target. The dead-code pass then sees
  // "at least one cross-file reference" for whichever candidates a textual
  // hit appears against, which is the safer bias for deletion decisions.
  const bucket = getGlobalLeafIndex(db).get(identifier);
  if (!bucket || bucket.length === 0) return [];
  return bucket.map(toSymbolRef);
}

// ── Inverse: per-symbol reference list ───────────────────────────

/**
 * Where is `symbol` referenced (via source-text scan)?
 *
 * Iterates every project source file and asks `attributeIdentifier`
 * whether each textual hit of `symbol`'s leaf attributes back to `symbol`.
 * Pairs `findIdentifierLines` (line-level positions) with
 * `attributeIdentifier` (which-symbol resolution).
 *
 * Used by `referenceSitesForSymbol` as the source-backed reference evidence
 * before falling back to SCIP mention chunks.
 */
export function findReferences(
  db: ScipDatabase,
  symbol: SymbolLocation,
  opts: { semantic?: boolean; semanticEvidence?: SymbolSemanticEvidencePort } = {},
): ReferenceSite[] {
  const match = getFullSymbolMatch(db, symbol);
  if (!match) return [];
  const identifier = leafName(match.symbol);
  if (!identifier) return [];

  if (opts.semantic !== false && opts.semanticEvidence) {
    const semanticSites = opts.semanticEvidence.references(db, {
      ...match,
      leaf: identifier,
      parentTypeName: null,
      isFunctionLike: false,
      isTypeLike: false,
      kind: null,
      documentation: null,
      enclosingSymbol: null,
    });
    if (semanticSites.length > 0) {
      const semanticLines = new Map<string, number[]>();
      for (const site of semanticSites) {
        const bucket = semanticLines.get(site.file) ?? [];
        bucket.push(site.line);
        semanticLines.set(site.file, bucket);
      }
      return materializeReferenceSites(db, semanticLines);
    }
  }

  const fileLines = new Map<string, number[]>();
  for (const file of getSourceFiles(db)) {
    // Cheap gate: if the identifier doesn't appear textually, skip.
    const source = getSourceText(db, file);
    if (!source || source.indexOf(identifier) === -1) continue;

    // Does this file's textual hit attribute back to our target?
    if (file !== match.relativePath) {
      const refs = attributeIdentifier(db, file, identifier);
      if (!refs.some((r) => r.symbolId === match.symbolId)) continue;
    }

    const lines = findIdentifierLines(
      db,
      file,
      identifier,
      file === match.relativePath ? { excludeStartLine: match.startLine, excludeEndLine: match.endLine } : {},
    );
    if (lines.length > 0) fileLines.set(file, lines);
  }

  return materializeReferenceSites(db, fileLines);
}

// ── Inverse: bulk caller-file map ────────────────────────────────

/**
 * For each symbol in `candidates`, which files reference it?
 *
 * Bulk variant of `findReferences` — one file walk credits every
 * candidate-leaf hit in the file at once, instead of N walks per
 * candidate. Used by the dead-code source-fallback path.
 */
// scip-query: ignore-wrapper — inverse source-attribution view used by
// caller-evidence; callers should not rebuild this cache shape.
export function findCallerFiles(
  db: ScipDatabase,
  candidates: ReadonlyArray<IndexedDefinition>,
  opts: { skipPath?: (relativePath: string) => boolean } = {},
): Map<number, Set<string>> {
  const candidateLeaves = new Map<string, IndexedDefinition[]>();
  for (const def of candidates) {
    if (!def.leaf) continue;
    const bucket = candidateLeaves.get(def.leaf) ?? [];
    bucket.push(def);
    candidateLeaves.set(def.leaf, bucket);
  }
  if (candidateLeaves.size === 0) return new Map();

  const candidateIds = new Set(candidates.map((c) => c.symbolId));
  const candidateLeafNames = new Set(candidateLeaves.keys());
  const candidateNameMatcher = createCandidateNameMatcher(candidateLeafNames);
  const result = new Map<number, Set<string>>();

  for (const file of getSourceFiles(db)) {
    if (opts.skipPath?.(file)) continue;
    if (!sourceMayContainCandidateName(getSourceText(db, file), candidateNameMatcher)) continue;
    const fileIdents = getFileIdentifiers(db, file);
    if (fileIdents.size === 0) continue;

    for (const name of fileIdents) {
      if (!candidateLeaves.has(name)) continue;
      for (const ref of attributeIdentifier(db, file, name)) {
        if (!candidateIds.has(ref.symbolId)) continue;
        if (file === ref.relativePath) continue; // self-reference, not a caller
        let bucket = result.get(ref.symbolId);
        if (!bucket) {
          bucket = new Set();
          result.set(ref.symbolId, bucket);
        }
        bucket.add(file);
      }
    }
  }

  return result;
}

// ── Internals ────────────────────────────────────────────────────

function toSymbolRef(entry: { symbol: string; symbolId: number; file: string }): SymbolRef {
  return { symbolId: entry.symbolId, symbol: entry.symbol, relativePath: entry.file };
}

// scip-query: ignore-wrapper — named attribution stage shared by findReferences
// (this file) and getResolvedReferenceSites (references/reference-sites.ts);
// callers should not repeat line-dedup plus enclosing-symbol lookup.
export function materializeReferenceSites(db: ScipDatabase, perFileLines: Map<string, number[]>): ReferenceSite[] {
  const sites: ReferenceSite[] = [];
  const seen = new Set<string>();
  for (const [file, lines] of perFileLines) {
    const definitions = getDefinitionsForFile(db, file);
    for (const line of lines) {
      const enclosing = findEnclosingDefinition(definitions, line);
      const key = `${file}|${line}|${enclosing?.symbol ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      sites.push({ file, line, enclosingSymbol: enclosing?.symbol ?? null });
    }
  }
  return sites;
}
