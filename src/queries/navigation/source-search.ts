import type { ScipDatabase } from '../../storage/db.js';
import { compileBoundedRegExp } from '../../domain/bounded-regexp.js';
import { classifyFile, type FileKind } from '../../source/primitives/file-kind.js';
import { getDefinitionsForFile, findEnclosingDefinition } from '../../symbols/definition-catalog.js';
import { shortenSymbol } from '../../symbols/symbol-parser.js';
import { getSourceLines } from '../../source/primitives/source-text.js';
import { indexedDocumentPaths } from '../../storage/scip-documents.js';
import { selectInspectionCandidates } from './source-inspection-selection.js';
import { sourceSnippet, type SourceSnippet } from './source-snippet.js';

export interface SourceSearchIdentity {
  relativePath: string;
  focusLine: number;
  ownerSymbol: string | null;
  ownerShort: string | null;
  ownerStartLine: number | null;
  ownerEndLine: number | null;
  fileKind: FileKind;
}

export interface SourceSearchMatch extends SourceSnippet {
  ownerSymbol: string | null;
  ownerShort: string | null;
  ownerStartLine?: number | null;
  ownerEndLine?: number | null;
  fileKind?: FileKind;
}

export interface SourceSearchFileCoverage {
  relativePath: string;
  matchingLines: number;
  returnedMatches: number;
}

export interface SourceSearchResult {
  pattern: string;
  mode: 'literal' | 'regexp';
  identities?: SourceSearchIdentity[];
  matches: SourceSearchMatch[];
  matchingLines: number;
  omittedMatches: number;
  fileCoverage?: SourceSearchFileCoverage[];
  scannedFiles: number;
}

export interface SourceSearchOptions {
  scope?: string;
  context?: number;
  limit?: number;
  regexp?: boolean;
  ignoreCase?: boolean;
  ranking?: 'structural';
}

/** Search the source of indexed documents and retain line and symbol ownership. */
export function searchSource(db: ScipDatabase, pattern: string, opts: SourceSearchOptions = {}): SourceSearchResult {
  if (pattern.length === 0) throw new Error('The source search pattern must not be empty.');
  const context = opts.context ?? 6;
  const limit = opts.limit ?? 12;
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new RangeError(`limit must be a positive safe integer; received ${limit}`);
  }
  const regexp = opts.regexp
    ? compileBoundedRegExp(pattern, 'source search pattern', opts.ignoreCase ? 'iu' : 'u')
    : null;
  const literal = opts.ignoreCase ? pattern.toLocaleLowerCase() : pattern;
  const paths = indexedDocumentPaths(db, { scope: opts.scope, includeIgnored: false });
  const identities: SourceSearchIdentity[] = [];
  const fileCoverage: SourceSearchFileCoverage[] = [];

  for (const relativePath of paths) {
    const lines = getSourceLines(db, relativePath);
    if (lines.length === 0) continue;
    const definitions = getDefinitionsForFile(db, relativePath);
    let fileMatchingLines = 0;
    for (let line = 0; line < lines.length; line += 1) {
      const text = lines[line] ?? '';
      const matched = regexp
        ? regexp.test(text)
        : (opts.ignoreCase ? text.toLocaleLowerCase() : text).includes(literal);
      if (!matched) continue;
      fileMatchingLines += 1;
      const owner = findEnclosingDefinition(definitions, line);
      identities.push({
        relativePath,
        focusLine: line,
        ownerSymbol: owner?.symbol ?? null,
        ownerShort: owner ? shortenSymbol(owner.symbol) : null,
        ownerStartLine: owner?.startLine ?? null,
        ownerEndLine: owner?.endLine ?? null,
        fileKind: classifyFile(relativePath),
      });
    }
    if (fileMatchingLines > 0) {
      fileCoverage.push({ relativePath, matchingLines: fileMatchingLines, returnedMatches: 0 });
    }
  }

  identities.sort(compareSearchIdentities);
  const materializedIdentities =
    limit === Number.MAX_SAFE_INTEGER
      ? identities
      : opts.ranking
        ? selectRepresentativeIdentities(identities, limit)
        : identities.slice(0, limit);
  const matches = materializedIdentities.flatMap((identity) => {
    const snippet = sourceSnippet(db, identity.relativePath, identity.focusLine, context);
    return snippet ? [{ ...snippet, ...identity }] : [];
  });

  const returnedByFile = new Map<string, number>();
  for (const match of matches)
    returnedByFile.set(match.relativePath, (returnedByFile.get(match.relativePath) ?? 0) + 1);
  for (const file of fileCoverage) file.returnedMatches = returnedByFile.get(file.relativePath) ?? 0;

  return {
    pattern,
    mode: opts.regexp ? 'regexp' : 'literal',
    identities,
    matches,
    matchingLines: identities.length,
    omittedMatches: Math.max(0, identities.length - matches.length),
    fileCoverage,
    scannedFiles: paths.length,
  };
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
