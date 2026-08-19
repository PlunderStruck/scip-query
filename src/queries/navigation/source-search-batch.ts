import { compileBoundedRegExp } from '../../domain/bounded-regexp.js';
import { getSourceFacts } from '../../source/facts/source-facts.js';
import { smallestSourceCallableAtLine } from '../../source/facts/source-callables.js';
import { focusedSourceConstructRange } from '../../source/facts/source-construct.js';
import { classifyFile, fileKindRank } from '../../source/primitives/file-kind.js';
import {
  scanRepositoryText,
  type RepositoryTextFile,
  type RepositoryTextScanResult,
} from '../../source/primitives/repository-text.js';
import { splitSearchableSourceLines } from '../../source/primitives/source-text.js';
import type { ScipDatabase } from '../../storage/db.js';
import { findEnclosingDefinition, getDefinitionsForFile } from '../../symbols/definition-catalog.js';
import { isModuleLikeSymbol, shortenSymbol } from '../../symbols/symbol-parser.js';
import { selectInspectionCandidates } from './source-inspection-selection.js';
import type {
  SourceSearchFileCoverage,
  SourceSearchIdentity,
  SourceSearchOptions,
  SourceSearchResult,
  SourceSearchScopeHint,
} from './source-search.js';
import type { SourceSnippet } from './source-snippet.js';

const SOURCE_SEARCH_IDENTITY_RENDER_LIMIT = 64;
const SOURCE_SEARCH_SCOPE_HINT_LIMIT = 12;

interface PreparedSourceSearch {
  pattern: string;
  regexp: RegExp | null;
  literal: string;
  identities: SourceSearchIdentity[];
  fileCoverage: SourceSearchFileCoverage[];
  textByPath: Map<string, string>;
}

export function searchSourceBatch(
  db: ScipDatabase,
  patterns: readonly string[],
  opts: SourceSearchOptions = {},
): SourceSearchResult[] {
  if (patterns.length === 0) return [];
  const context = opts.context ?? 6;
  if (!Number.isSafeInteger(context) || context < 0) {
    throw new RangeError(`context must be a non-negative safe integer; received ${context}`);
  }
  const limit = opts.limit ?? 12;
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new RangeError(`limit must be a positive safe integer; received ${limit}`);
  }
  const searches = patterns.map((pattern): PreparedSourceSearch => {
    if (pattern.length === 0) throw new Error('The source search pattern must not be empty.');
    return {
      pattern,
      regexp: opts.regexp ? compileBoundedRegExp(pattern, 'source search pattern', opts.ignoreCase ? 'iu' : 'u') : null,
      literal: opts.ignoreCase ? pattern.toLocaleLowerCase() : pattern,
      identities: [],
      fileCoverage: [],
      textByPath: new Map(),
    };
  });

  if (!opts.regexp && !opts.ignoreCase) {
    const literalBytes = searches.map((search) => Buffer.from(search.pattern, 'utf8'));
    const inventory = scanRepositoryText(
      db,
      {
        scope: opts.scope,
        literalBytes: literalBytes.length === 1 ? literalBytes[0] : literalBytes,
      },
      (file, matchedLiteralIndexes) => {
        const lines = splitSearchableSourceLines(file.text);
        if (lines.length === 0) return;
        for (const index of matchedLiteralIndexes) {
          const search = searches[index];
          if (search) collectFileMatches(db, search, file, lines, opts);
        }
      },
    );
    return searches.map((search) => finalizeSourceSearch(search, inventory, context, limit, opts));
  }

  return searches.map((search) => {
    const inventory = scanRepositoryText(db, { scope: opts.scope }, (file) => {
      const lines = splitSearchableSourceLines(file.text);
      if (lines.length > 0) collectFileMatches(db, search, file, lines, opts);
    });
    return finalizeSourceSearch(search, inventory, context, limit, opts);
  });
}

function collectFileMatches(
  db: ScipDatabase,
  search: PreparedSourceSearch,
  file: RepositoryTextFile,
  lines: readonly string[],
  opts: SourceSearchOptions,
): void {
  const matchingLineNumbers: number[] = [];
  for (let line = 0; line < lines.length; line += 1) {
    const rawText = lines[line] ?? '';
    const text = rawText.endsWith('\r') ? rawText.slice(0, -1) : rawText;
    const matched = search.regexp
      ? search.regexp.test(text)
      : (opts.ignoreCase ? text.toLocaleLowerCase() : text).includes(search.literal);
    if (matched) matchingLineNumbers.push(line);
  }
  if (matchingLineNumbers.length === 0) return;

  const relativePath = file.relativePath;
  search.textByPath.set(relativePath, file.text);
  const definitions =
    file.freshness.semantic.state !== 'stale' && file.freshness.semantic.basis !== 'no-compiler-document'
      ? getDefinitionsForFile(db, relativePath)
      : [];
  const sourceCallables = getSourceFacts(db, relativePath)?.callables ?? [];
  for (const line of matchingLineNumbers) {
    const owner = findEnclosingDefinition(definitions, line);
    const callableOwner = smallestSourceCallableAtLine(sourceCallables, line);
    const preciseCompilerOwner = owner && !isModuleLikeSymbol(owner.symbol) ? owner : null;
    const enclosingStartLine = preciseCompilerOwner?.startLine ?? callableOwner?.startLine ?? owner?.startLine ?? line;
    const enclosingEndLine = preciseCompilerOwner?.endLine ?? callableOwner?.endLine ?? owner?.endLine ?? line;
    const focusedOwner = focusedSourceConstructRange(db, relativePath, line, enclosingStartLine, enclosingEndLine);
    search.identities.push({
      relativePath,
      focusLine: line,
      ownerSymbol: preciseCompilerOwner?.symbol ?? null,
      ownerShort: preciseCompilerOwner
        ? shortenSymbol(preciseCompilerOwner.symbol)
        : (callableOwner?.name ?? (owner ? shortenSymbol(owner.symbol) : null)),
      ownerStartLine: focusedOwner.startLine,
      ownerEndLine: focusedOwner.endLine,
      fileKind: classifyFile(relativePath),
      freshness: file.freshness,
    });
  }
  search.fileCoverage.push({
    relativePath,
    matchingLines: matchingLineNumbers.length,
    returnedMatches: 0,
    freshness: file.freshness,
  });
}

function finalizeSourceSearch(
  search: PreparedSourceSearch,
  inventory: RepositoryTextScanResult,
  context: number,
  limit: number,
  opts: SourceSearchOptions,
): SourceSearchResult {
  search.identities.sort(compareSearchIdentities);
  const reportedIdentities =
    search.identities.length > SOURCE_SEARCH_IDENTITY_RENDER_LIMIT
      ? selectRepresentativeIdentities(search.identities, SOURCE_SEARCH_IDENTITY_RENDER_LIMIT)
      : search.identities;
  const materializedIdentities =
    limit === Number.MAX_SAFE_INTEGER
      ? search.identities
      : opts.ranking
        ? selectRepresentativeIdentities(search.identities, limit)
        : search.identities.slice(0, limit);
  const matches = materializedIdentities.flatMap((identity) => {
    const source = search.textByPath.get(identity.relativePath);
    const snippet =
      source === undefined ? null : sourceSnippetFromText(identity.relativePath, source, identity.focusLine, context);
    return snippet ? [{ ...snippet, ...identity }] : [];
  });

  const returnedByFile = new Map<string, number>();
  for (const match of matches) {
    returnedByFile.set(match.relativePath, (returnedByFile.get(match.relativePath) ?? 0) + 1);
  }
  for (const file of search.fileCoverage) file.returnedMatches = returnedByFile.get(file.relativePath) ?? 0;
  const allScopeHints = sourceSearchScopeHints(search.fileCoverage);

  return {
    pattern: search.pattern,
    mode: opts.regexp ? 'regexp' : 'literal',
    identities: search.identities,
    ...(reportedIdentities.length < search.identities.length ? { identityManifest: reportedIdentities } : {}),
    identityCoverage: {
      mode: reportedIdentities.length === search.identities.length ? 'complete' : 'bounded',
      returned: reportedIdentities.length,
      total: search.identities.length,
      omitted: search.identities.length - reportedIdentities.length,
    },
    matches,
    matchingLines: search.identities.length,
    matchingFiles: search.fileCoverage.length,
    omittedMatches: Math.max(0, search.identities.length - matches.length),
    fileCoverage: search.fileCoverage,
    scopeHints: allScopeHints.slice(0, SOURCE_SEARCH_SCOPE_HINT_LIMIT),
    omittedScopeHints: Math.max(0, allScopeHints.length - SOURCE_SEARCH_SCOPE_HINT_LIMIT),
    scannedFiles: inventory.scannedTextFiles,
    textCoverage: {
      basis: 'current-project-text-files',
      candidateFiles: inventory.candidateFiles,
      scannedTextFiles: inventory.scannedTextFiles,
      scannedBytes: inventory.scannedBytes,
      skippedBinaryPaths: inventory.skippedBinaryPaths,
      skippedUnreadablePaths: inventory.skippedUnreadablePaths,
      skippedOversizedPaths: inventory.skippedOversizedPaths,
      semanticFiles: inventory.semanticFiles,
    },
  };
}

function sourceSnippetFromText(
  relativePath: string,
  text: string,
  focusLine: number,
  contextLines: number,
): SourceSnippet | null {
  const lines = text.split('\n');
  const searchableLineCount = text.endsWith('\n') ? lines.length - 1 : lines.length;
  if (focusLine < 0 || focusLine >= searchableLineCount) return null;
  const startLine = Math.max(0, focusLine - contextLines);
  const endLine = Math.min(searchableLineCount - 1, focusLine + contextLines);
  return {
    relativePath,
    startLine,
    endLine,
    focusLine,
    source: lines.slice(startLine, endLine + 1).join('\n'),
  };
}

function sourceSearchScopeHints(files: readonly SourceSearchFileCoverage[]): SourceSearchScopeHint[] {
  const scopes = new Map<string, { matchingLines: number; matchingFiles: number }>();
  for (const file of files) {
    const scope = parentPath(file.relativePath);
    const coverage = scopes.get(scope) ?? { matchingLines: 0, matchingFiles: 0 };
    coverage.matchingLines += file.matchingLines;
    coverage.matchingFiles += 1;
    scopes.set(scope, coverage);
  }
  return [...scopes.entries()]
    .map(([scope, coverage]) => ({ scope, ...coverage }))
    .sort(
      (left, right) =>
        right.matchingLines - left.matchingLines ||
        right.matchingFiles - left.matchingFiles ||
        left.scope.localeCompare(right.scope),
    );
}

function parentPath(relativePath: string): string {
  const separator = relativePath.lastIndexOf('/');
  return separator < 0 ? relativePath : relativePath.slice(0, separator);
}

function selectRepresentativeIdentities(
  identities: readonly SourceSearchIdentity[],
  limit: number,
): SourceSearchIdentity[] {
  const candidates = identities.map((identity, sequence) => ({
    ...identity,
    priority: fileKindRank(identity.fileKind),
    sequence,
    evidenceCharacters: 1,
    roles: ['search'],
    reasons: ['search'],
    symbols: identity.ownerSymbol ? [identity.ownerSymbol] : [],
    behaviorSignals: [],
  }));
  const selected: typeof candidates = [];
  for (const rank of [0, 1, 2]) {
    const remaining = limit - selected.length;
    if (remaining === 0) break;
    const tier = candidates.filter((candidate) => fileKindRank(candidate.fileKind) === rank);
    selected.push(
      ...selectInspectionCandidates(tier, remaining, Number.MAX_SAFE_INTEGER, compareSearchIdentities).selected,
    );
  }
  return selected.map(
    ({
      priority: _priority,
      sequence: _sequence,
      evidenceCharacters: _characters,
      roles: _roles,
      reasons: _reasons,
      symbols: _symbols,
      behaviorSignals: _signals,
      ...identity
    }) => identity,
  );
}

function compareSearchIdentities(left: SourceSearchIdentity, right: SourceSearchIdentity): number {
  return (
    fileKindRank(left.fileKind) - fileKindRank(right.fileKind) ||
    Number(right.ownerSymbol !== null) - Number(left.ownerSymbol !== null) ||
    left.relativePath.localeCompare(right.relativePath) ||
    left.focusLine - right.focusLine
  );
}
