import { basename, extname } from 'node:path';
import type { IndexedDefinition, SymbolMatch, SymbolResolution } from '../../domain/types.js';
import { isExportedDefinition } from '../internal/exported-definition.js';
import { isMissingProjectFileError, readProjectFileText } from '../../source/primitives/project-file-boundary.js';
import type { ScipDatabase } from '../../storage/db.js';
import { getDefinitionsForFile } from '../../symbols/definition-catalog.js';
import { buildCalleeMap } from '../../symbols/graph/call-graph-evidence.js';
import { findFirstSymbolMatch, nearestSymbolNames, resolveSymbol } from '../../symbols/symbol-lookup.js';
import { resolveIndexedFile } from '../internal/file-resolution.js';
import { leafName, shortenSymbol } from '../../symbols/symbol-parser.js';
import { SOURCE_INSPECTION_MAX_SELECTORS } from '../internal/inspection-limits.js';
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
  bindingClosure?: BindingClosure;
}

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
  reason?: 'definition-source-unreadable' | 'definition-not-found';
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

  const match = findFirstSymbolMatch(db, symbolPattern);
  if (!match) return null;
  return readSymbolRange(db, match, context);
}

/** Read up to 24 selectors with complete, per-selector resolution accounting. */
export function codeBatch(
  db: ScipDatabase,
  selectors: readonly string[],
  opts: { context?: number; members?: CodeFileMemberMode } = {},
): CodeBatchResult {
  if (selectors.length === 0) throw new RangeError('code requires at least one selector.');
  if (selectors.length > SOURCE_INSPECTION_MAX_SELECTORS) {
    throw new RangeError(
      `code accepts at most ${SOURCE_INSPECTION_MAX_SELECTORS} selectors per complete packet; received ${selectors.length}.`,
    );
  }
  const context = opts.context ?? 0;
  const members = opts.members ?? 'exported';
  const entries = selectors.map((selector) => codeBatchEntry(db, selector, context, members));
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
): CodeBatchEntry {
  const directRange = parseFileLineRange(selector);
  if (directRange) {
    const result = readFileRange(db, directRange.filePath, directRange.startLine, directRange.endLine, context);
    return result
      ? rangeSourceEntry(db, selector, result, context)
      : missingSourceEntry(db, selector, 'definition-source-unreadable');
  }

  const exactFile = exactIndexedFile(db, selector);
  if (exactFile) return fileSourceEntry(db, selector, exactFile, context, members);

  const resolution = resolveSymbol(db, selector);
  if (!resolution.match) return missingSourceEntry(db, selector, 'definition-not-found');
  const candidates = resolvedCandidateMatches(db, resolution);
  const candidateEvidence = candidates.map(codeResolutionCandidate);
  if (resolution.total > 1) {
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

  const result = readSymbolRange(db, resolution.match, context);
  return result
    ? matchedSourceEntry(selector, result)
    : missingSourceEntry(db, selector, 'definition-source-unreadable');
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
        callee.source === 'ast-callsite' &&
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
  relativePath: string,
  context: number,
  members: CodeFileMemberMode,
): CodeBatchEntry {
  const definitionTree = fileDefinitionTree(db, relativePath);
  const allDefinitions = getDefinitionsForFile(db, relativePath).filter(
    (definition) => !isFileModuleDefinition(definition, relativePath),
  );
  const explicitExports = allDefinitions.filter((definition) => isExportedDefinition(db, definition));
  const surfaceDefinitions =
    explicitExports.length > 0 ? explicitExports : topLevelDefinitions(definitionTree, allDefinitions);
  const selectedDefinitions =
    members === 'all' ? [] : sameFileDefinitionClosure(db, surfaceDefinitions, allDefinitions);
  const results =
    members === 'all'
      ? [readWholeFile(db, relativePath)].filter((result): result is CodeResult => result !== null)
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

function readWholeFile(db: ScipDatabase, relativePath: string): CodeResult | null {
  const result = readFileRange(db, relativePath, 1, Number.MAX_SAFE_INTEGER, 0);
  return result ? { ...result, symbol: relativePath, shortName: relativePath } : null;
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

function exactIndexedFile(db: ScipDatabase, selector: string): string | null {
  const normalized = selector.replace(/\\/gu, '/').replace(/^\.\//u, '');
  return (
    db.get<{ relative_path: string }>('SELECT relative_path FROM documents WHERE relative_path = ? LIMIT 1', normalized)
      ?.relative_path ?? null
  );
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
  const fileLineMatch = symbolPattern.match(/^(.+\.\w+):(\d+)-(\d+)$/);
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

function readSymbolRange(
  db: ScipDatabase,
  match: NonNullable<ReturnType<typeof findFirstSymbolMatch>>,
  context: number,
): CodeResult | null {
  // Get the language from the documents table
  const doc = db.get<{ language: string | null }>(
    `SELECT language FROM documents WHERE relative_path = ?`,
    match.relativePath,
  );

  // Read the file
  let fileContent: string;
  try {
    fileContent = readProjectFileText(db.config.projectRoot, match.relativePath, {
      inputKind: 'indexed source file',
    });
  } catch (error) {
    if (!isMissingProjectFileError(error)) throw error;
    return null;
  }

  const lines = fileContent.split('\n');
  const recoveredUnit =
    match.endLine <= match.startLine
      ? enclosingSourceUnitSnippet(db, match.relativePath, match.startLine, Number.MAX_SAFE_INTEGER)
      : null;
  const definitionStart = recoveredUnit?.unitType ? recoveredUnit.unitStartLine : match.startLine;
  const definitionEnd = recoveredUnit?.unitType ? recoveredUnit.unitEndLine : match.endLine;
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
    bindingClosure: bindingClosureForRange(db, match.relativePath, startLine, endLine),
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
  // Find the file in the index
  const resolvedPath = resolveIndexedFile(db, filePath);
  if (!resolvedPath) return null;

  const doc = db.get<{ relative_path: string; language: string | null }>(
    `SELECT relative_path, language FROM documents WHERE relative_path = ?`,
    resolvedPath,
  );
  if (!doc) return null;

  let fileContent: string;
  try {
    fileContent = readProjectFileText(db.config.projectRoot, doc.relative_path, {
      inputKind: 'indexed source file',
    });
  } catch (error) {
    if (!isMissingProjectFileError(error)) throw error;
    return null;
  }

  const lines = fileContent.split('\n');
  const start = Math.max(0, startLine - 1 - context); // convert to 0-indexed
  const end = Math.min(lines.length - 1, endLine - 1 + context);
  const source = lines.slice(start, end + 1).join('\n');
  return {
    symbol: `${doc.relative_path}:${startLine}-${endLine}`,
    shortName: `${doc.relative_path}:${startLine}-${endLine}`,
    relativePath: doc.relative_path,
    startLine: start,
    endLine: end,
    language: doc.language ?? supportedLanguageFromPath(doc.relative_path),
    source,
    bindingClosure: bindingClosureForRange(db, doc.relative_path, start, end),
  };
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
