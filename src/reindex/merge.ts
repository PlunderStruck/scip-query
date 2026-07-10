import { readFileSync, writeFileSync } from 'node:fs';
import { create } from '@bufbuild/protobuf';
import { deserializeSCIP, serializeSCIP, DocumentSchema, IndexSchema, SymbolInformationSchema } from '@c4312/scip';
import type { Document, Index, Occurrence, Relationship, SymbolInformation } from '@c4312/scip';
import { sanitizeScipIndex } from './sanitize.js';

export interface MergeScipResult {
  documentCount: number;
  externalSymbolCount: number;
  inputCount: number;
}

export interface MergeAndSanitizeScipResult extends MergeScipResult {
  removedDefinitionOccurrences: number;
  touchedDocuments: number;
}

/**
 * Merge multiple SCIP indices into a single index message.
 *
 * A SCIP index is a code graph snapshot: metadata about one indexed project plus
 * the documents and external symbols discovered by one or more indexers. Merging
 * means producing one unified snapshot so later conversion to SQLite sees the
 * whole repo instead of whichever language indexed last.
 */
export function mergeScipIndexes(indexes: readonly Index[]): Index {
  if (indexes.length === 0) {
    throw new Error('Cannot merge zero SCIP indexes');
  }

  if (indexes.length === 1) {
    return indexes[0]!;
  }

  const metadata = mergeMetadata(indexes);
  const documents = mergeDocuments(indexes.flatMap((index) => index.documents ?? []));
  const externalSymbols = mergeSymbolInfos(indexes.flatMap((index) => index.externalSymbols ?? []));

  return create(IndexSchema, {
    metadata,
    documents,
    externalSymbols,
  });
}

export function mergeScipFiles(inputPaths: readonly string[], outputPath: string): MergeScipResult {
  if (inputPaths.length === 0) {
    throw new Error('Cannot merge zero SCIP files');
  }

  const indexes = inputPaths.map((path) => deserializeSCIP(readFileSync(path)));
  const merged = mergeScipIndexes(indexes);
  writeFileSync(outputPath, Buffer.from(serializeSCIP(merged)));

  return {
    documentCount: merged.documents.length,
    externalSymbolCount: merged.externalSymbols.length,
    inputCount: inputPaths.length,
  };
}

export function mergeAndSanitizeScipFiles(
  inputPaths: readonly string[],
  outputPath: string,
): MergeAndSanitizeScipResult {
  if (inputPaths.length === 0) throw new Error('Cannot merge zero SCIP files');
  const indexes = inputPaths.map((path) => deserializeSCIP(readFileSync(path)));
  const sanitized = sanitizeScipIndex(mergeScipIndexes(indexes));
  writeFileSync(outputPath, Buffer.from(serializeSCIP(sanitized.index)));
  return {
    documentCount: sanitized.index.documents.length,
    externalSymbolCount: sanitized.index.externalSymbols.length,
    inputCount: inputPaths.length,
    removedDefinitionOccurrences: sanitized.removedDefinitionOccurrences,
    touchedDocuments: sanitized.touchedDocuments,
  };
}

function mergeMetadata(indexes: readonly Index[]): Index['metadata'] {
  const first = indexes[0]?.metadata;
  if (!first) {
    return undefined;
  }

  const expectedProjectRoot = first.projectRoot;
  for (const index of indexes.slice(1)) {
    const actualProjectRoot = index.metadata?.projectRoot;
    if (expectedProjectRoot && actualProjectRoot && actualProjectRoot !== expectedProjectRoot) {
      throw new Error(
        `Cannot merge SCIP indexes with different project roots: ${expectedProjectRoot} vs ${actualProjectRoot}`,
      );
    }
  }

  return first;
}

function mergeDocuments(documents: readonly Document[]): Document[] {
  const byPath = new Map<string, Document>();

  for (const document of documents) {
    const existing = byPath.get(document.relativePath);
    if (!existing) {
      byPath.set(document.relativePath, document);
      continue;
    }

    byPath.set(
      document.relativePath,
      create(DocumentSchema, {
        language: existing.language || document.language,
        relativePath: existing.relativePath || document.relativePath,
        occurrences: mergeOccurrences([...existing.occurrences, ...document.occurrences]),
        symbols: mergeSymbolInfos([...existing.symbols, ...document.symbols]),
        text: chooseText(existing.text, document.text),
        positionEncoding: existing.positionEncoding || document.positionEncoding,
      }),
    );
  }

  return [...byPath.values()];
}

function mergeOccurrences(occurrences: readonly Occurrence[]): Occurrence[] {
  const seen = new Set<string>();
  const merged: Occurrence[] = [];

  for (const occurrence of occurrences) {
    const key = JSON.stringify(occurrence);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(occurrence);
  }

  return merged;
}

function mergeSymbolInfos(symbols: readonly SymbolInformation[]): SymbolInformation[] {
  const bySymbol = new Map<string, SymbolInformation>();

  for (const symbol of symbols) {
    const existing = bySymbol.get(symbol.symbol);
    if (!existing) {
      bySymbol.set(symbol.symbol, symbol);
      continue;
    }

    bySymbol.set(
      symbol.symbol,
      create(SymbolInformationSchema, {
        symbol: existing.symbol,
        documentation: uniqueStrings([...existing.documentation, ...symbol.documentation]),
        relationships: mergeRelationships([...existing.relationships, ...symbol.relationships]),
        kind: existing.kind || symbol.kind,
        displayName: existing.displayName || symbol.displayName,
        enclosingSymbol: existing.enclosingSymbol || symbol.enclosingSymbol,
        signatureDocumentation: existing.signatureDocumentation ?? symbol.signatureDocumentation,
      }),
    );
  }

  return [...bySymbol.values()];
}

function mergeRelationships(relationships: readonly Relationship[]): Relationship[] {
  const seen = new Set<string>();
  const merged: Relationship[] = [];

  for (const relationship of relationships) {
    const key = [
      relationship.symbol,
      relationship.isReference ? '1' : '0',
      relationship.isImplementation ? '1' : '0',
      relationship.isTypeDefinition ? '1' : '0',
      relationship.isDefinition ? '1' : '0',
    ].join('|');

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    merged.push(relationship);
  }

  return merged;
}

function chooseText(left: string, right: string): string {
  if (!left) return right;
  if (!right) return left;
  return left.length >= right.length ? left : right;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}
