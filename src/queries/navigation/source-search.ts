import type { ScipDatabase } from '../../storage/db.js';
import { compileBoundedRegExp } from '../../domain/bounded-regexp.js';
import { classifyFile, type FileKind } from '../../source/primitives/file-kind.js';
import { getSourceFacts } from '../../source/facts/source-facts.js';
import { focusedSourceConstructRange } from '../../source/facts/source-construct.js';
import { getDefinitionsForFile, findEnclosingDefinition } from '../../symbols/definition-catalog.js';
import { isModuleLikeSymbol, shortenSymbol } from '../../symbols/symbol-parser.js';
import { repositoryTextInventory, type SourceObservationFreshness } from '../../source/primitives/repository-text.js';
import { selectInspectionCandidates } from './source-inspection-selection.js';
import type { SourceSnippet } from './source-snippet.js';

export type {
  SourceObservationFreshness,
  SourceSemanticFreshnessState,
} from '../../source/primitives/repository-text.js';

export interface SourceSearchIdentity {
  relativePath: string;
  focusLine: number;
  ownerSymbol: string | null;
  ownerShort: string | null;
  ownerStartLine: number | null;
  ownerEndLine: number | null;
  fileKind: FileKind;
  freshness?: SourceObservationFreshness;
}

export interface SourceSearchMatch extends SourceSnippet {
  ownerSymbol: string | null;
  ownerShort: string | null;
  ownerStartLine?: number | null;
  ownerEndLine?: number | null;
  fileKind?: FileKind;
  freshness?: SourceObservationFreshness;
}

export interface SourceSearchFileCoverage {
  relativePath: string;
  matchingLines: number;
  returnedMatches: number;
  freshness?: SourceObservationFreshness;
}

export interface SourceSearchScopeHint {
  scope: string;
  matchingLines: number;
  matchingFiles: number;
}

export interface SourceSearchIdentityCoverage {
  mode: 'complete' | 'bounded';
  returned: number;
  total: number;
  omitted: number;
}

export interface SourceSearchTextCoverage {
  basis: 'current-project-text-files';
  candidateFiles: number;
  scannedTextFiles: number;
  scannedBytes: number;
  skippedBinaryPaths: string[];
  skippedUnreadablePaths: string[];
  skippedOversizedPaths: string[];
  semanticFiles: {
    aligned: number;
    stale: number;
    unavailable: number;
  };
}

export interface SourceSearchResult {
  pattern: string;
  mode: 'literal' | 'regexp';
  identities?: SourceSearchIdentity[];
  identityManifest?: SourceSearchIdentity[];
  identityCoverage?: SourceSearchIdentityCoverage;
  matches: SourceSearchMatch[];
  matchingLines: number;
  matchingFiles?: number;
  omittedMatches: number;
  fileCoverage?: SourceSearchFileCoverage[];
  scopeHints?: SourceSearchScopeHint[];
  omittedScopeHints?: number;
  scannedFiles: number;
  textCoverage?: SourceSearchTextCoverage;
}

export interface SourceSearchOptions {
  scope?: string;
  context?: number;
  limit?: number;
  regexp?: boolean;
  ignoreCase?: boolean;
  ranking?: 'structural';
}

const SOURCE_SEARCH_IDENTITY_RENDER_LIMIT = 64;
const SOURCE_SEARCH_SCOPE_HINT_LIMIT = 12;

/** Search the source of indexed documents and retain line and symbol ownership. */
export function searchSource(db: ScipDatabase, pattern: string, opts: SourceSearchOptions = {}): SourceSearchResult {
  if (pattern.length === 0) throw new Error('The source search pattern must not be empty.');
  const context = opts.context ?? 6;
  if (!Number.isSafeInteger(context) || context < 0) {
    throw new RangeError(`context must be a non-negative safe integer; received ${context}`);
  }
  const limit = opts.limit ?? 12;
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new RangeError(`limit must be a positive safe integer; received ${limit}`);
  }
  const regexp = opts.regexp
    ? compileBoundedRegExp(pattern, 'source search pattern', opts.ignoreCase ? 'iu' : 'u')
    : null;
  const literal = opts.ignoreCase ? pattern.toLocaleLowerCase() : pattern;
  const inventory = repositoryTextInventory(db, { scope: opts.scope });
  const identities: SourceSearchIdentity[] = [];
  const fileCoverage: SourceSearchFileCoverage[] = [];

  for (const file of inventory.files) {
    const relativePath = file.relativePath;
    const lines = searchableSourceLines(file.text);
    if (lines.length === 0) continue;
    const definitions =
      file.freshness.semantic.state !== 'stale' && file.freshness.semantic.basis !== 'no-compiler-document'
        ? getDefinitionsForFile(db, relativePath)
        : [];
    const sourceCallables = getSourceFacts(db, relativePath)?.callables ?? [];
    let fileMatchingLines = 0;
    for (let line = 0; line < lines.length; line += 1) {
      const rawText = lines[line] ?? '';
      const text = rawText.endsWith('\r') ? rawText.slice(0, -1) : rawText;
      const matched = regexp
        ? regexp.test(text)
        : (opts.ignoreCase ? text.toLocaleLowerCase() : text).includes(literal);
      if (!matched) continue;
      fileMatchingLines += 1;
      const owner = findEnclosingDefinition(definitions, line);
      const callableOwner = smallestSourceCallable(sourceCallables, line);
      const preciseCompilerOwner = owner && !isModuleLikeSymbol(owner.symbol) ? owner : null;
      const enclosingStartLine =
        preciseCompilerOwner?.startLine ?? callableOwner?.startLine ?? owner?.startLine ?? line;
      const enclosingEndLine = preciseCompilerOwner?.endLine ?? callableOwner?.endLine ?? owner?.endLine ?? line;
      const focusedOwner = focusedSourceConstructRange(db, relativePath, line, enclosingStartLine, enclosingEndLine);
      identities.push({
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
    if (fileMatchingLines > 0) {
      fileCoverage.push({
        relativePath,
        matchingLines: fileMatchingLines,
        returnedMatches: 0,
        freshness: file.freshness,
      });
    }
  }

  identities.sort(compareSearchIdentities);
  const reportedIdentities =
    identities.length > SOURCE_SEARCH_IDENTITY_RENDER_LIMIT
      ? selectRepresentativeIdentities(identities, SOURCE_SEARCH_IDENTITY_RENDER_LIMIT)
      : identities;
  const materializedIdentities =
    limit === Number.MAX_SAFE_INTEGER
      ? identities
      : opts.ranking
        ? selectRepresentativeIdentities(identities, limit)
        : identities.slice(0, limit);
  const textByPath = new Map(inventory.files.map((file) => [file.relativePath, file.text] as const));
  const matches = materializedIdentities.flatMap((identity) => {
    const source = textByPath.get(identity.relativePath);
    const snippet =
      source === undefined ? null : sourceSnippetFromText(identity.relativePath, source, identity.focusLine, context);
    return snippet ? [{ ...snippet, ...identity }] : [];
  });

  const returnedByFile = new Map<string, number>();
  for (const match of matches)
    returnedByFile.set(match.relativePath, (returnedByFile.get(match.relativePath) ?? 0) + 1);
  for (const file of fileCoverage) file.returnedMatches = returnedByFile.get(file.relativePath) ?? 0;

  const allScopeHints = sourceSearchScopeHints(fileCoverage);

  return {
    pattern,
    mode: opts.regexp ? 'regexp' : 'literal',
    identities,
    ...(reportedIdentities.length < identities.length ? { identityManifest: reportedIdentities } : {}),
    identityCoverage: {
      mode: reportedIdentities.length === identities.length ? 'complete' : 'bounded',
      returned: reportedIdentities.length,
      total: identities.length,
      omitted: identities.length - reportedIdentities.length,
    },
    matches,
    matchingLines: identities.length,
    matchingFiles: fileCoverage.length,
    omittedMatches: Math.max(0, identities.length - matches.length),
    fileCoverage,
    scopeHints: allScopeHints.slice(0, SOURCE_SEARCH_SCOPE_HINT_LIMIT),
    omittedScopeHints: Math.max(0, allScopeHints.length - SOURCE_SEARCH_SCOPE_HINT_LIMIT),
    scannedFiles: inventory.files.length,
    textCoverage: {
      basis: 'current-project-text-files',
      candidateFiles: inventory.candidateFiles,
      scannedTextFiles: inventory.files.length,
      scannedBytes: inventory.scannedBytes,
      skippedBinaryPaths: inventory.skippedBinaryPaths,
      skippedUnreadablePaths: inventory.skippedUnreadablePaths,
      skippedOversizedPaths: inventory.skippedOversizedPaths,
      semanticFiles: {
        aligned: inventory.files.filter((file) => file.freshness.semantic.state === 'aligned').length,
        stale: inventory.files.filter((file) => file.freshness.semantic.state === 'stale').length,
        unavailable: inventory.files.filter((file) => file.freshness.semantic.state === 'unavailable').length,
      },
    },
  };
}

function smallestSourceCallable(
  callables: readonly { name: string; startLine: number; endLine: number }[],
  line: number,
): { name: string; startLine: number; endLine: number } | null {
  return (
    callables
      .filter((callable) => callable.startLine <= line && callable.endLine >= line)
      .sort(
        (left, right) =>
          left.endLine - left.startLine - (right.endLine - right.startLine) || left.startLine - right.startLine,
      )[0] ?? null
  );
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

function searchableSourceLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines;
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

function fileKindRank(kind: FileKind): number {
  switch (kind) {
    case 'entry':
    case 'source':
    case 'worker':
      return 0;
    case 'barrel':
      return 1;
    case 'test':
      return 2;
  }
}
