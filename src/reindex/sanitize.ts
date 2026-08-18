import { writeFileSync } from 'node:fs';
import { create } from '@bufbuild/protobuf';
import { deserializeSCIP, DocumentSchema, IndexSchema, serializeSCIP, SymbolRole } from '@c4312/scip';
import type { Document, Index } from '@c4312/scip';
import { normalizeSafeProjectRelativePath } from '../domain/path-normalization.js';
import { readFileWithinLimit, SCIP_ARTIFACT_MAX_BYTES } from '../platform/bounded-file.js';

export interface SanitizeScipResult {
  removedDefinitionOccurrences: number;
  touchedDocuments: number;
}

export function sanitizeScipFile(path: string): SanitizeScipResult {
  let index: Index;
  try {
    index = deserializeSCIP(
      readFileWithinLimit(path, { inputKind: 'SCIP sanitization input', maxBytes: SCIP_ARTIFACT_MAX_BYTES }),
    );
  } catch {
    return {
      removedDefinitionOccurrences: 0,
      touchedDocuments: 0,
    };
  }
  const result = sanitizeScipIndex(index);
  if (result.removedDefinitionOccurrences > 0) {
    writeFileSync(path, serializeSCIP(result.index));
  }
  return {
    removedDefinitionOccurrences: result.removedDefinitionOccurrences,
    touchedDocuments: result.touchedDocuments,
  };
}

export function sanitizeScipIndex(index: Index): SanitizeScipResult & { index: Index } {
  const definedSymbols = new Set<string>();
  for (const document of index.documents) {
    normalizeSafeProjectRelativePath(document.relativePath);
    for (const symbol of document.symbols) {
      if (symbol.symbol) definedSymbols.add(symbol.symbol);
    }
  }
  for (const symbol of index.externalSymbols) {
    if (symbol.symbol) definedSymbols.add(symbol.symbol);
  }

  let removedDefinitionOccurrences = 0;
  let touchedDocuments = 0;
  const documents: Document[] = [];

  for (const document of index.documents) {
    const occurrences = document.occurrences.filter((occurrence) => {
      if ((occurrence.symbolRoles & SymbolRole.Definition) === 0) return true;
      if (definedSymbols.has(occurrence.symbol)) return true;
      removedDefinitionOccurrences += 1;
      return false;
    });

    if (occurrences.length === document.occurrences.length) {
      documents.push(document);
      continue;
    }

    touchedDocuments += 1;
    documents.push(
      create(DocumentSchema, {
        language: document.language,
        relativePath: document.relativePath,
        occurrences,
        symbols: document.symbols,
        text: document.text,
        positionEncoding: document.positionEncoding,
      }),
    );
  }

  return {
    index:
      removedDefinitionOccurrences === 0
        ? index
        : create(IndexSchema, {
            metadata: index.metadata,
            documents,
            externalSymbols: index.externalSymbols,
          }),
    removedDefinitionOccurrences,
    touchedDocuments,
  };
}
