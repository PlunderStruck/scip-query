import type { FileKind } from '../../source/primitives/file-kind.js';
import type { SourceObservationFreshness } from '../../source/primitives/repository-text.js';
import type { SourceSnippet } from './source-snippet.js';

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
