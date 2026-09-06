import { basename, extname } from 'node:path';
import type { IndexedDefinition, SymbolMatch, SymbolResolution } from '../../domain/types.js';
import { isExportedDefinition } from '../internal/exported-definition.js';
import {
  readRepositoryTextFile,
  type RepositoryTextFile,
  type SourceObservationFreshness,
} from '../../source/primitives/repository-text.js';
import { UnsafeProjectPathError } from '../../source/primitives/project-file-boundary.js';
import type { ScipDatabase } from '../../storage/db.js';
import { getDefinitionsForFile } from '../../symbols/definition-catalog.js';
import { buildCalleeMap } from '../../symbols/graph/call-graph-evidence.js';
import { nearestSymbolNames, resolveSymbol } from '../../symbols/symbol-lookup.js';
import { leafName, shortenSymbol } from '../../symbols/symbol-parser.js';
import { SOURCE_INSPECTION_MAX_SELECTORS } from '../../domain/source-inspection-limits.js';
import {
  bindingClosureForRange,
  mergeBindingClosures,
  type BindingClosure,
  type CoveredSourceRange,
} from './binding-closure.js';
import { outline, type OutlineNode } from './outline.js';
import { enclosingSourceUnitSnippet } from './source-snippet.js';

export interface CodeResult {
  symbol: string;
  shortName: string;
  relativePath: string;
  startLine: number;
  endLine: number;
  language: string | null;
  source: string;
  freshness?: SourceObservationFreshness;
  bindingClosure?: BindingClosure;
}

export type {
  SourceObservationFreshness,
  SourceSemanticFreshnessState,
} from '../../source/primitives/repository-text.js';

export type CodeSelectorStatus = 'matched' | 'ambiguous' | 'missing';
export type CodeSelectorKind = 'source' | 'file-source';
export type CodeFileMemberMode = 'exported' | 'all';

export interface CodeResolutionCandidate {
  symbol: string;
  shortName: string;
  relativePath: string;
  startLine: number;
  endLine: number;
}

export interface CodeFileDefinitionLedgerEntry extends CodeResolutionCandidate {
  signature: string | null;
  depth: number;
  nestedDefinitions: number;
}

export interface CodeFileCoverage {
  members: CodeFileMemberMode;
  basis:
    | 'explicit-exports-and-same-file-reference-closure'
    | 'top-level-and-same-file-reference-closure'
    | 'complete-file-source';
  totalDefinitions: number;
  returnedDefinitions: number;
  returnedBodies: number;
  omittedDefinitions: number;
  omittedLedger: CodeFileDefinitionLedgerEntry[];
}

/** Semantic coverage added to an exact line-range selector. */
export interface CodeRangeCoverage {
  basis: 'requested-range-and-same-file-call-closure';
  referencedDefinitions: number;
  returnedDefinitions: number;
  returnedBodies: number;
  omittedDefinitions: number;
  omittedLedger: CodeResolutionCandidate[];
}

/** One selector's exact outcome inside a complete multi-selector code packet. */
export interface CodeBatchEntry {
  selector: string;
  status: CodeSelectorStatus;
  kind: CodeSelectorKind;
  totalCandidates: number;
  results: CodeResult[];
  definitions: OutlineNode[];
  candidates: CodeResolutionCandidate[];
  omittedCandidates: number;
  suggestions: string[];
  fileCoverage?: CodeFileCoverage;
  rangeCoverage?: CodeRangeCoverage;
  reason?: 'definition-source-unreadable' | 'definition-not-found' | 'definition-index-stale';
}

/**
 * A complete accounting of several exact source or file-surface selectors.
 *
 * The packet never ranks selectors against each other or drops one for a byte
 * budget. Ambiguity is an explicit result, never a silent first-match choice.
 */
export interface CodeBatchResult {
  requested: number;
  matched: number;
  ambiguous: number;
  missing: number;
  entries: CodeBatchEntry[];
  bindingClosure: BindingClosure;
}

/**
 * Read the source code for a symbol, bounded to its definition range.
 * Language-agnostic: just reads the file and extracts the relevant lines.
 *
 * Accepts:
 *   - Symbol name pattern: "processVegaMention"
 *   - Full short name: "src:modules:chat:processVegaMention"
 *   - File:line-line syntax: "src/chat/service.ts:100-200"
 */
export function code(db: ScipDatabase, symbolPattern: string, opts: { context?: number } = {}): CodeResult | null {
  const { context = 0 } = opts;

  // Handle direct file:line-line syntax (bypass symbol lookup)
  const directRange = parseFileLineRange(symbolPattern);
  if (directRange) return readFileRange(db, directRange.filePath, directRange.startLine, directRange.endLine, context);

  const exactFile = exactRepositoryTextFile(db, symbolPattern);
  if (exactFile) return readWholeFile(db, exactFile);
  if (explicitFileSelector(symbolPattern)) return null;

  const resolution = resolveSymbol(db, symbolPattern);
  if (resolution.candidates.length > 0)
    throw new Error(`Ambiguous symbol: ${symbolPattern}. Use an exact selector or codeBatch.`);
  if (!resolution.match) return null;
  return readSymbolRange(db, resolution.match, context);
}

/** Read up to 24 selectors with complete, per-selector resolution accounting. */
export function codeBatch(
  db: ScipDatabase,
  selectors: readonly string[],
  opts: { context?: number; members?: CodeFileMemberMode; localCalls?: boolean } = {},
): CodeBatchResult {
  if (selectors.length === 0) throw new RangeError('code requires at least one selector.');
  if (selectors.length > SOURCE_INSPECTION_MAX_SELECTORS) {
    throw new RangeError(
      `code accepts at most ${SOURCE_INSPECTION_MAX_SELECTORS} selectors per complete packet; received ${selectors.length}.`,
    );
  }
  const context = opts.context ?? 0;
  const members = opts.members ?? 'exported';
  const entries = selectors.map((selector) => codeBatchEntry(db, selector, context, members, opts.localCalls ?? false));
  const results = entries.flatMap((entry) => entry.results);
  const coveredRanges: CoveredSourceRange[] = results.map((result) => ({
    relativePath: result.relativePath,
    startLine: result.startLine,
    endLine: result.endLine,
  }));
  return {
    requested: selectors.length,
    matched: entries.filter((entry) => entry.status === 'matched').length,
    ambiguous: entries.filter((entry) => entry.status === 'ambiguous').length,
    missing: entries.filter((entry) => entry.status === 'missing').length,
    entries,
    bindingClosure: mergeBindingClosures(
      results.map((result) => result.bindingClosure),
      coveredRanges,
    ),
  };
}

function codeBatchEntry(
  db: ScipDatabase,
  selector: string,
  context: number,
  members: CodeFileMemberMode,
  localCalls: boolean,
): CodeBatchEntry {
  const directRange = parseFileLineRange(selector);
  if (directRange) {
    const result = readFileRange(db, directRange.filePath, directRange.startLine, directRange.endLine, context);
    if (!result) return missingSourceEntry(db, selector, 'definition-source-unreadable');
    return localCalls ? rangeSourceEntry(db, selector, result, context) : matchedSourceEntry(selector, result);
  }

  const exactFile = exactRepositoryTextFile(db, selector);
  if (exactFile) return fileSourceEntry(db, selector, exactFile, context, members);
  if (explicitFileSelector(selector)) return missingSourceEntry(db, selector, 'definition-not-found');

  const resolution = resolveSymbol(db, selector);
  if (!resolution.match) return missingSourceEntry(db, selector, 'definition-not-found');
  if (resolution.total > 1) return ambiguousSourceEntry(db, selector, resolution, context);

  const result = readSymbolRange(db, resolution.match, context);
  return result
    ? matchedSourceEntry(selector, result)
    : missingSourceEntry(
        db,
        selector,
        readRepositoryTextFile(db, resolution.match.relativePath)?.freshness.semantic.state === 'stale'
          ? 'definition-index-stale'
          : 'definition-source-unreadable',
      );
}

function ambiguousSourceEntry(
  db: ScipDatabase,
  selector: string,
  resolution: ReturnType<typeof resolveSymbol>,
  context: number,
): CodeBatchEntry {
  const candidates = resolvedCandidateMatches(db, resolution);
  const candidateEvidence = candidates.map(codeResolutionCandidate);
  const returnAllSources = resolution.total <= 4 && candidates.length === resolution.total;
  return {
    selector,
    status: 'ambiguous',
    kind: 'source',
    totalCandidates: resolution.total,
    results: returnAllSources
      ? candidates.flatMap((candidate) => {
          const result = readSymbolRange(db, candidate, context);
          return result ? [result] : [];
        })
      : [],
    definitions: [],
    candidates: candidateEvidence,
    omittedCandidates: Math.max(0, resolution.total - candidateEvidence.length),
    suggestions: [],
  };
}

function rangeSourceEntry(
  db: ScipDatabase,
  selector: string,
  requestedRange: CodeResult,
  context: number,
): CodeBatchEntry {
  const allDefinitions = getDefinitionsForFile(db, requestedRange.relativePath).filter(
    (definition) => !isFileModuleDefinition(definition, requestedRange.relativePath),
  );
  const referencedDefinitions = sameFileCallClosureForRange(db, requestedRange, allDefinitions);
  const referencedResults = removeCoveredResults(
    referencedDefinitions
      .map((definition) => readSymbolRange(db, definition, context))
      .filter((result): result is CodeResult => result !== null),
  ).filter((result) => !sourceRangeCovers(requestedRange, result));
  const returnedSymbols = new Set(referencedResults.map((result) => result.symbol));
  const omittedLedger = referencedDefinitions
    .filter(
      (definition) =>
        !returnedSymbols.has(definition.symbol) &&
        !(requestedRange.startLine <= definition.startLine && requestedRange.endLine >= definition.endLine),
    )
    .map(codeResolutionCandidate);

  return {
    selector,
    status: 'matched',
    kind: 'source',
    totalCandidates: 1,
    results: [requestedRange, ...referencedResults],
    definitions: [],
    candidates: [],
    omittedCandidates: 0,
    suggestions: [],
    rangeCoverage: {
      basis: 'requested-range-and-same-file-call-closure',
      referencedDefinitions: referencedDefinitions.length,
      returnedDefinitions: referencedDefinitions.length - omittedLedger.length,
      returnedBodies: referencedResults.length,
      omittedDefinitions: omittedLedger.length,
      omittedLedger,
    },
  };
}

function sameFileCallClosureForRange(
  db: ScipDatabase,
  requestedRange: CodeResult,
  allDefinitions: readonly IndexedDefinition[],
): IndexedDefinition[] {
  if (!semanticFactsUsable(requestedRange.freshness)) return [];
  if (allDefinitions.length === 0) return [];
  const callees = buildCalleeMap(db, allDefinitions, { additive: false, semantic: false });
  const definitionsBySymbol = new Map<string, IndexedDefinition[]>();
  for (const definition of allDefinitions) {
    const bucket = definitionsBySymbol.get(definition.symbol) ?? [];
    bucket.push(definition);
    definitionsBySymbol.set(definition.symbol, bucket);
  }
  const directReferences = new Map<number, IndexedDefinition>();
  for (const caller of allDefinitions) {
    if (caller.endLine < requestedRange.startLine || caller.startLine > requestedRange.endLine) continue;
    for (const callee of callees.get(caller.symbolId) ?? []) {
      if (callee.file !== requestedRange.relativePath) continue;
      if (
        (callee.source === 'ast-callsite' || callee.source === 'scip-occurrence') &&
        (callee.chunkId < requestedRange.startLine || callee.chunkId > requestedRange.endLine)
      ) {
        continue;
      }
      for (const definition of definitionsBySymbol.get(callee.symbol) ?? []) {
        directReferences.set(definition.symbolId, definition);
      }
    }
  }
  return sameFileDefinitionClosure(db, [...directReferences.values()], allDefinitions);
}

function fileSourceEntry(
  db: ScipDatabase,
  selector: string,
  file: RepositoryTextFile,
  context: number,
  members: CodeFileMemberMode,
): CodeBatchEntry {
  const relativePath = file.relativePath;
  const definitionTree = semanticFactsUsable(file.freshness) ? fileDefinitionTree(db, relativePath) : [];
  const allDefinitions = semanticFactsUsable(file.freshness)
    ? getDefinitionsForFile(db, relativePath).filter((definition) => !isFileModuleDefinition(definition, relativePath))
    : [];
  const explicitExports = allDefinitions.filter((definition) => isExportedDefinition(db, definition));
  const surfaceDefinitions =
    explicitExports.length > 0 ? explicitExports : topLevelDefinitions(definitionTree, allDefinitions);
  const selectedDefinitions =
    members === 'all' ? [] : sameFileDefinitionClosure(db, surfaceDefinitions, allDefinitions);
  const results =
    members === 'all' || allDefinitions.length === 0
      ? [readWholeFile(db, file)]
      : removeCoveredResults(
          selectedDefinitions
            .map((definition) => readSymbolRange(db, definition, context))
            .filter((result): result is CodeResult => result !== null),
        );
  const returnedDefinitions = countCoveredOutlineDefinitions(definitionTree, results);
  const omittedLedger = omittedFileDefinitionLedger(relativePath, definitionTree, results);
  const totalDefinitions = countOutlineNodes(definitionTree);

  return {
    selector,
    status: 'matched',
    kind: 'file-source',
    totalCandidates: 1,
    results,
    definitions: [],
    candidates: [],
    omittedCandidates: 0,
    suggestions: [],
    fileCoverage: {
      members,
      basis:
        members === 'all'
          ? 'complete-file-source'
          : allDefinitions.length === 0
            ? 'complete-file-source'
            : explicitExports.length > 0
              ? 'explicit-exports-and-same-file-reference-closure'
              : 'top-level-and-same-file-reference-closure',
      totalDefinitions,
      returnedDefinitions,
      returnedBodies: results.length,
      omittedDefinitions: Math.max(0, totalDefinitions - returnedDefinitions),
      omittedLedger,
    },
  };
}

function topLevelDefinitions(
  definitionTree: readonly OutlineNode[],
  allDefinitions: readonly IndexedDefinition[],
): IndexedDefinition[] {
  const rootSymbols = new Set(definitionTree.map((node) => node.symbol));
  return allDefinitions.filter((definition) => rootSymbols.has(definition.symbol));
}

function fileDefinitionTree(db: ScipDatabase, relativePath: string): OutlineNode[] {
  return outline(db, relativePath).flatMap((node) =>
    isFileModuleOutlineNode(node, relativePath) ? node.children : [node],
  );
}

function isFileModuleDefinition(definition: IndexedDefinition, relativePath: string): boolean {
  return fileModuleLeafNames(relativePath).has(definition.leaf);
}

function isFileModuleOutlineNode(node: OutlineNode, relativePath: string): boolean {
  return fileModuleLeafNames(relativePath).has(leafName(node.symbol));
}

function fileModuleLeafNames(relativePath: string): Set<string> {
  const fileName = basename(relativePath);
  return new Set([fileName, fileName.slice(0, Math.max(0, fileName.length - extname(fileName).length))]);
}

function sameFileDefinitionClosure(
  db: ScipDatabase,
  seeds: readonly IndexedDefinition[],
  allDefinitions: readonly IndexedDefinition[],
): IndexedDefinition[] {
  if (seeds.length === 0) return [];
  const callees = buildCalleeMap(db, allDefinitions, { additive: true, semantic: false });
  const definitionsBySymbol = new Map<string, IndexedDefinition[]>();
  for (const definition of allDefinitions) {
    const bucket = definitionsBySymbol.get(definition.symbol) ?? [];
    bucket.push(definition);
    definitionsBySymbol.set(definition.symbol, bucket);
  }
  const selected = new Map<number, IndexedDefinition>();
  const pending = [...seeds];
  while (pending.length > 0) {
    const definition = pending.shift()!;
    if (selected.has(definition.symbolId)) continue;
    selected.set(definition.symbolId, definition);
    for (const callee of callees.get(definition.symbolId) ?? []) {
      for (const related of definitionsBySymbol.get(callee.symbol) ?? []) {
        if (!selected.has(related.symbolId)) pending.push(related);
      }
    }
  }
  return [...selected.values()].sort(compareDefinitions);
}

function removeCoveredResults(results: readonly CodeResult[]): CodeResult[] {
  const ordered = [...results].sort(
    (left, right) =>
      left.relativePath.localeCompare(right.relativePath) ||
      left.startLine - right.startLine ||
      right.endLine - left.endLine,
  );
  const selected: CodeResult[] = [];
  for (const result of ordered) {
    if (selected.some((existing) => sourceRangeCovers(existing, result))) continue;
    selected.push(result);
  }
  return selected;
}

function readWholeFile(db: ScipDatabase, file: RepositoryTextFile): CodeResult {
  const lines = file.text.split('\n');
  return {
    symbol: file.relativePath,
    shortName: file.relativePath,
    relativePath: file.relativePath,
    startLine: 0,
    endLine: Math.max(0, lines.length - 1),
    language:
      db.get<{ language: string | null }>('SELECT language FROM documents WHERE relative_path = ?', file.relativePath)
        ?.language ?? supportedLanguageFromPath(file.relativePath),
    source: file.text,
    freshness: file.freshness,
    ...(semanticFactsUsable(file.freshness)
      ? { bindingClosure: bindingClosureForRange(db, file.relativePath, 0, Math.max(0, lines.length - 1)) }
      : {}),
  };
}

function countCoveredOutlineDefinitions(nodes: readonly OutlineNode[], results: readonly CodeResult[]): number {
  return flattenOutlineNodes(nodes).filter((node) => results.some((result) => outlineNodeCoveredBy(node, result)))
    .length;
}

function omittedFileDefinitionLedger(
  relativePath: string,
  nodes: readonly OutlineNode[],
  results: readonly CodeResult[],
): CodeFileDefinitionLedgerEntry[] {
  const ledger: CodeFileDefinitionLedgerEntry[] = [];
  appendOmittedDefinitionLedger(ledger, relativePath, nodes, results, 0);
  return ledger;
}

function appendOmittedDefinitionLedger(
  ledger: CodeFileDefinitionLedgerEntry[],
  relativePath: string,
  nodes: readonly OutlineNode[],
  results: readonly CodeResult[],
  depth: number,
): void {
  for (const node of nodes) {
    if (results.some((result) => outlineNodeCoveredBy(node, result))) continue;
    const omittedDescendants = flattenOutlineNodes(node.children).filter(
      (child) => !results.some((result) => outlineNodeCoveredBy(child, result)),
    ).length;
    ledger.push({
      symbol: node.symbol,
      shortName: node.shortName,
      relativePath,
      startLine: node.startLine,
      endLine: node.endLine,
      signature: node.signature,
      depth,
      nestedDefinitions: omittedDescendants,
    });
    appendOmittedDefinitionLedger(ledger, relativePath, node.children, results, depth + 1);
  }
}

function flattenOutlineNodes(nodes: readonly OutlineNode[]): OutlineNode[] {
  return nodes.flatMap((node) => [node, ...flattenOutlineNodes(node.children)]);
}

function countOutlineNodes(nodes: readonly OutlineNode[]): number {
  return flattenOutlineNodes(nodes).length;
}

function outlineNodeCoveredBy(node: OutlineNode, result: CodeResult): boolean {
  return result.startLine <= node.startLine && result.endLine >= node.endLine;
}

function sourceRangeCovers(outer: CodeResult, inner: CodeResult): boolean {
  return (
    outer.relativePath === inner.relativePath && outer.startLine <= inner.startLine && outer.endLine >= inner.endLine
  );
}

function compareDefinitions(left: IndexedDefinition, right: IndexedDefinition): number {
  return left.startLine - right.startLine || right.endLine - left.endLine || left.symbol.localeCompare(right.symbol);
}

function matchedSourceEntry(selector: string, result: CodeResult): CodeBatchEntry {
  return {
    selector,
    status: 'matched',
    kind: 'source',
    totalCandidates: 1,
    results: [result],
    definitions: [],
    candidates: [],
    omittedCandidates: 0,
    suggestions: [],
  };
}

function missingSourceEntry(
  db: ScipDatabase,
  selector: string,
  reason: NonNullable<CodeBatchEntry['reason']>,
): CodeBatchEntry {
  return {
    selector,
    status: 'missing',
    kind: 'source',
    totalCandidates: 0,
    results: [],
    definitions: [],
    candidates: [],
    omittedCandidates: 0,
    suggestions: nearestSymbolNames(db, selector, 5),
    reason,
  };
}

function explicitFileSelector(selector: string): boolean {
  // Full SCIP identities have scheme, manager, package, version and descriptor fields.
  if (/^\S+ \S+ \S+ \S+ /.test(selector)) return false;
  if (/^(?:\.{1,2}[/\\]|[/\\]|[A-Za-z]:[/\\])/.test(selector)) return true;
  // Preserve path-qualified symbol selectors such as src/file.ts:method.
  if (selector.includes(':')) return false;
  if (/[/\\]/.test(selector)) return true;
  return /\.(?:[cm]?[jt]sx?|jsonc?|mdx?|ya?ml|toml|xml|html|css|scss|sql|py|rs|go|java|kt|clj[cs]?|txt|sh)$/i.test(
    selector,
  );
}

function exactRepositoryTextFile(db: ScipDatabase, selector: string): RepositoryTextFile | null {
  try {
    return readRepositoryTextFile(db, selector);
  } catch (error) {
    if (error instanceof UnsafeProjectPathError) return null;
    throw error;
  }
}

function resolvedCandidateMatches(db: ScipDatabase, resolution: SymbolResolution): SymbolMatch[] {
  if (!resolution.match) return [];
  const matches: SymbolMatch[] = [resolution.match];
  for (const candidate of resolution.candidates) {
    const definition = getDefinitionsForFile(db, candidate.relativePath).find(
      (item) => item.symbol === candidate.symbol && item.startLine === candidate.startLine,
    );
    if (definition) matches.push(definition);
  }
  const seen = new Set<string>();
  return matches.filter((match) => {
    const key = `${match.relativePath}:${match.startLine}:${match.endLine}:${match.symbol}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function codeResolutionCandidate(match: SymbolMatch): CodeResolutionCandidate {
  return {
    symbol: match.symbol,
    shortName: shortenSymbol(match.symbol),
    relativePath: match.relativePath,
    startLine: match.startLine,
    endLine: match.endLine,
  };
}

function parseFileLineRange(symbolPattern: string): {
  filePath: string;
  startLine: number;
  endLine: number;
} | null {
  const fileLineMatch = symbolPattern.match(/^(.+):(\d+)-(\d+)$/);
  if (!fileLineMatch) return null;
  const startLine = Number(fileLineMatch[2]);
  const endLine = Number(fileLineMatch[3]);
  if (!Number.isSafeInteger(startLine) || startLine < 1) {
    throw new RangeError(`Source range start line must be a positive integer, got "${fileLineMatch[2]}".`);
  }
  if (!Number.isSafeInteger(endLine) || endLine < startLine) {
    throw new RangeError(
      `Source range end line must be an integer at or after ${startLine}, got "${fileLineMatch[3]}".`,
    );
  }
  return {
    filePath: fileLineMatch[1]!,
    startLine,
    endLine,
  };
}

function readSymbolRange(db: ScipDatabase, match: SymbolMatch, context: number): CodeResult | null {
  // Get the language from the documents table
  const doc = db.get<{ language: string | null }>(
    `SELECT language FROM documents WHERE relative_path = ?`,
    match.relativePath,
  );

  // Read the file
  const file = readRepositoryTextFile(db, match.relativePath);
  if (!file || file.freshness.semantic.state === 'stale') return null;
  const fileContent = file.text;

  const lines = fileContent.split('\n');
  const recoveredUnit =
    match.endLine <= match.startLine
      ? enclosingSourceUnitSnippet(db, match.relativePath, match.startLine, Number.MAX_SAFE_INTEGER)
      : null;
  const [definitionStart, definitionEnd] = recoveredUnit?.unitType
    ? ([recoveredUnit.unitStartLine, recoveredUnit.unitEndLine] as const)
    : ([match.startLine, match.endLine] as const);
  if (definitionStart < 0 || definitionStart >= lines.length || definitionEnd < definitionStart) return null;
  const startLine = Math.max(0, definitionStart - context);
  const endLine = Math.min(lines.length - 1, definitionEnd + context);
  const source = lines.slice(startLine, endLine + 1).join('\n');
  return {
    symbol: match.symbol,
    shortName: shortenSymbol(match.symbol),
    relativePath: match.relativePath,
    // 0-indexed, like every other query result. The CLI's displayLine()
    // converts once at render time. Returning 1-indexed here caused a
    // double-conversion in the CLI and printed labels off by +1.
    startLine,
    endLine,
    language: doc?.language ?? supportedLanguageFromPath(match.relativePath),
    source,
    freshness: file.freshness,
    ...(semanticFactsUsable(file.freshness)
      ? { bindingClosure: bindingClosureForRange(db, match.relativePath, startLine, endLine) }
      : {}),
  };
}

/** Read source by file path and line range directly (no symbol lookup) */
function readFileRange(
  db: ScipDatabase,
  filePath: string,
  startLine: number,
  endLine: number,
  context: number,
): CodeResult | null {
  const file = readRepositoryTextFile(db, filePath);
  if (!file) return null;
  const doc = db.get<{ language: string | null }>(
    `SELECT language FROM documents WHERE relative_path = ?`,
    file.relativePath,
  );
  const fileContent = file.text;

  const lines = fileContent.split('\n');
  if (startLine > lines.length) return null;
  const start = Math.max(0, startLine - 1 - context); // convert to 0-indexed
  const end = Math.min(lines.length - 1, endLine - 1 + context);
  const source = lines.slice(start, end + 1).join('\n');
  return {
    symbol: `${file.relativePath}:${startLine}-${endLine}`,
    shortName: `${file.relativePath}:${startLine}-${endLine}`,
    relativePath: file.relativePath,
    startLine: start,
    endLine: end,
    language: doc?.language ?? supportedLanguageFromPath(file.relativePath),
    source,
    freshness: file.freshness,
    ...(semanticFactsUsable(file.freshness)
      ? { bindingClosure: bindingClosureForRange(db, file.relativePath, start, end) }
      : {}),
  };
}

function semanticFactsUsable(freshness: SourceObservationFreshness | undefined): boolean {
  return Boolean(
    freshness && freshness.semantic.state !== 'stale' && freshness.semantic.basis !== 'no-compiler-document',
  );
}

// Maps a file extension to the project's canonical SupportedLanguage name
// (used for display/reporting). Distinct from reindex/augment.ts's
// auxiliaryDocumentLanguageTag (a best-effort tag for otherwise-unindexed
// files, not a canonical language) and augment-vue-runtime.ts's
// volarLanguageIdForPath (LSP languageId vocabulary for a TS language
// service, e.g. 'typescriptreact') -- three different jobs that happened
// to share a name.
function supportedLanguageFromPath(relativePath: string): string | null {
  switch (extname(relativePath).toLowerCase()) {
    case '.ts':
    case '.tsx':
    case '.mts':
    case '.cts':
      return 'typescript';
    case '.js':
    case '.jsx':
    case '.mjs':
    case '.cjs':
      return 'javascript';
    case '.py':
    case '.pyi':
      return 'python';
    case '.rs':
      return 'rust';
    case '.go':
      return 'go';
    case '.java':
      return 'java';
    case '.kt':
    case '.kts':
      return 'kotlin';
    case '.scala':
      return 'scala';
    case '.rb':
      return 'ruby';
    case '.php':
      return 'php';
    case '.cs':
      return 'csharp';
    case '.vb':
      return 'vb';
    case '.dart':
      return 'dart';
    case '.c':
    case '.h':
      return 'c';
    case '.cc':
    case '.cpp':
    case '.cxx':
    case '.hpp':
    case '.hh':
    case '.hxx':
      return 'cpp';
    case '.vue':
      return 'vue';
    default:
      return null;
  }
}
