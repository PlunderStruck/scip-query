import { closeSync, openSync, readSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import {
  deserializeSCIP,
  serializeSCIP,
  DocumentSchema,
  IndexSchema,
  MetadataSchema,
  SymbolInformationSchema,
} from '@c4312/scip';
import type { Document, Index, Occurrence, Relationship, SymbolInformation } from '@c4312/scip';
import { profileSpan } from '../instrumentation/profile.js';
import {
  eachWireField,
  encodeLengthDelimitedTag,
  encodeVarint,
  readScipIndexProjectRoot,
  type WireField,
} from './scip-wire.js';
import { readFileWithinLimit, SCIP_ARTIFACT_MAX_BYTES } from '../platform/bounded-file.js';
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

  const indexes = inputPaths.map((path) =>
    deserializeSCIP(readFileWithinLimit(path, { inputKind: 'SCIP merge input', maxBytes: SCIP_ARTIFACT_MAX_BYTES })),
  );
  const merged = mergeScipIndexes(indexes);
  writeFileSync(outputPath, serializeSCIP(merged));

  return {
    documentCount: merged.documents.length,
    externalSymbolCount: merged.externalSymbols.length,
    inputCount: inputPaths.length,
  };
}

/**
 * Protobuf permits repeated encodings of one message to be concatenated: a
 * reader merges singular fields and appends repeated fields. scip-typescript
 * uses this same representation when it indexes several projects. Copying the
 * bytes therefore combines disjoint compiler shards without deserializing the
 * whole repository graph into the coordinator heap.
 */
export function concatenateScipFiles(inputPaths: readonly string[], outputPath: string): void {
  if (inputPaths.length === 0) throw new Error('Cannot concatenate zero SCIP files');
  let totalBytes = 0;
  for (const path of inputPaths) {
    totalBytes += statSync(path).size;
    if (totalBytes > SCIP_ARTIFACT_MAX_BYTES) {
      throw new Error(
        `Concatenated SCIP output exceeds the ${SCIP_ARTIFACT_MAX_BYTES}-byte artifact limit. ` +
          'Reduce the indexed project scope or use compatible cached generations.',
      );
    }
  }

  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const output = openSync(outputPath, 'w', 0o600);
  try {
    for (const path of inputPaths) {
      const input = openSync(path, 'r');
      try {
        let bytesRead = 0;
        while ((bytesRead = readSync(input, buffer, 0, buffer.byteLength, null)) > 0) {
          let offset = 0;
          while (offset < bytesRead) offset += writeSync(output, buffer, offset, bytesRead - offset);
        }
      } finally {
        closeSync(input);
      }
    }
  } catch (error) {
    closeSync(output);
    rmSync(outputPath, { force: true });
    throw error;
  }
  closeSync(output);
}

export function mergeAndSanitizeScipFiles(
  inputPaths: readonly string[],
  outputPath: string,
): MergeAndSanitizeScipResult {
  if (inputPaths.length === 0) throw new Error('Cannot merge zero SCIP files');
  const indexes = profileSpan('reindex.publish.scip-output.deserialize', () =>
    inputPaths.map((path) =>
      deserializeSCIP(readFileWithinLimit(path, { inputKind: 'SCIP merge input', maxBytes: SCIP_ARTIFACT_MAX_BYTES })),
    ),
  );
  const merged = profileSpan('reindex.publish.scip-output.merge', () => mergeScipIndexes(indexes));
  const sanitized = profileSpan('reindex.publish.scip-output.sanitize', () => sanitizeScipIndex(merged));
  profileSpan('reindex.publish.scip-output.serialize', () => writeFileSync(outputPath, serializeSCIP(sanitized.index)));
  return {
    documentCount: sanitized.index.documents.length,
    externalSymbolCount: sanitized.index.externalSymbols.length,
    inputCount: inputPaths.length,
    removedDefinitionOccurrences: sanitized.removedDefinitionOccurrences,
    touchedDocuments: sanitized.touchedDocuments,
  };
}

export function rebaseScipProjectRoot(index: Index, expectedProjectRoot: string, targetProjectRoot: string): Index {
  const metadata = index.metadata;
  if (!metadata) throw new Error('Cannot rebase a SCIP index without metadata');
  if (metadata.projectRoot !== expectedProjectRoot) {
    throw new Error(`Cannot rebase SCIP project root: expected ${expectedProjectRoot}, got ${metadata.projectRoot}`);
  }
  return create(IndexSchema, {
    metadata: create(MetadataSchema, { ...metadata, projectRoot: targetProjectRoot }),
    documents: index.documents,
    externalSymbols: index.externalSymbols,
  });
}

const INDEX_METADATA_FIELD = 1;

/**
 * Rewrites only the metadata occurrences of the artifact: deserializing a
 * whole few-hundred-megabyte index into objects to change one string costs
 * gigabytes of transient heap, and every non-metadata byte can be copied
 * verbatim. Each metadata message (concatenated shard artifacts carry one per
 * shard) gets the target root so the merged view resolves to it.
 */
export function rebaseScipFileProjectRoot(path: string, expectedProjectRoot: string, targetProjectRoot: string): void {
  const buffer = readFileWithinLimit(path, {
    inputKind: 'SCIP normalization input',
    maxBytes: SCIP_ARTIFACT_MAX_BYTES,
  });
  const effectiveRoot = readScipIndexProjectRoot(buffer);
  const metadataFields: WireField[] = [];
  for (const field of eachWireField(buffer)) {
    if (field.fieldNumber === INDEX_METADATA_FIELD && field.wireType === 2) metadataFields.push(field);
  }
  if (metadataFields.length === 0) throw new Error('Cannot rebase a SCIP index without metadata');
  if ((effectiveRoot ?? '') !== expectedProjectRoot) {
    throw new Error(`Cannot rebase SCIP project root: expected ${expectedProjectRoot}, got ${effectiveRoot ?? ''}`);
  }

  const temporaryPath = `${path}.rebase-tmp`;
  const descriptor = openSync(temporaryPath, 'w', 0o600);
  try {
    let segmentStart = 0;
    for (const field of metadataFields) {
      writeChunk(descriptor, buffer.subarray(segmentStart, field.fieldStart));
      const metadata = fromBinary(MetadataSchema, buffer.subarray(field.valueStart, field.valueEnd));
      metadata.projectRoot = targetProjectRoot;
      const encoded = toBinary(MetadataSchema, metadata);
      writeChunk(descriptor, encodeLengthDelimitedTag(INDEX_METADATA_FIELD));
      writeChunk(descriptor, encodeVarint(encoded.byteLength));
      writeChunk(descriptor, encoded);
      segmentStart = field.fieldEnd;
    }
    writeChunk(descriptor, buffer.subarray(segmentStart));
  } catch (error) {
    closeSync(descriptor);
    rmSync(temporaryPath, { force: true });
    throw error;
  }
  closeSync(descriptor);
  renameSync(temporaryPath, path);
}

function writeChunk(descriptor: number, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.byteLength) offset += writeSync(descriptor, bytes, offset, bytes.byteLength - offset);
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
