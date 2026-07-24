import type { ParsedReExport, ParsedSourceImport } from '../domain/types.js';
import { getReExports, getSourceImports } from './index.js';
import type { ScipDatabase } from '../storage/db.js';
import { getAst } from '../source/ast/ast-core.js';
import type { Tree } from '../source/ast/ast-types.js';
import type { SourceFacts } from '../source/facts/source-fact-types.js';
import { getSourceFactsResult, type SourceFactsUnavailable } from '../source/facts/source-facts.js';
import { getSourceLines, getSourceText } from '../source/primitives/source-text.js';

export interface SourceEvidenceRequest {
  text?: boolean;
  lines?: boolean;
  ast?: boolean;
  imports?: boolean;
  reexports?: boolean;
  facts?: boolean;
  identifiers?: boolean;
}

export interface SourceFileEvidence {
  file: string;
  text?: string;
  lines?: readonly string[];
  ast?: Tree | null;
  imports?: ParsedSourceImport[];
  reexports?: ParsedReExport[];
  facts?: SourceFacts | null;
  sourceFactsUnavailable?: SourceFactsUnavailable;
  identifiers?: Set<string>;
  identifierLineMap?: Map<string, number[]>;
}

export interface SourceEvidence {
  forFile(file: string, request: SourceEvidenceRequest): SourceFileEvidence;
  forFiles(files: readonly string[], request: SourceEvidenceRequest): Map<string, SourceFileEvidence>;
}

export function sourceEvidence(db: ScipDatabase): SourceEvidence {
  return {
    forFile(file, request) {
      return sourceEvidenceForFile(db, file, request);
    },
    forFiles(files, request) {
      const evidence = new Map<string, SourceFileEvidence>();
      for (const file of files) evidence.set(file, sourceEvidenceForFile(db, file, request));
      return evidence;
    },
  };
}

function sourceEvidenceForFile(db: ScipDatabase, file: string, request: SourceEvidenceRequest): SourceFileEvidence {
  const evidence: SourceFileEvidence = { file };
  const needsFacts = request.facts || request.identifiers;

  if (request.text) evidence.text = getSourceText(db, file);
  if (request.lines) evidence.lines = getSourceLines(db, file);
  if (request.ast) evidence.ast = getAst(db, file);
  if (request.imports) evidence.imports = getSourceImports(db, file);
  if (request.reexports) evidence.reexports = getReExports(db, file);
  if (needsFacts) {
    const result = getSourceFactsResult(db, file);
    const facts = result.facts;
    if (request.facts) evidence.facts = facts;
    if (result.unavailable) evidence.sourceFactsUnavailable = result.unavailable;
    if (request.identifiers && facts) {
      evidence.identifiers = facts.fileIdentifiers;
      evidence.identifierLineMap = facts.identifierLineMap;
    }
  }

  return evidence;
}
