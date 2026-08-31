import { closeSync, openSync, renameSync, rmSync, writeSync } from 'node:fs';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { DocumentSchema, IndexSchema, SymbolRole } from '@c4312/scip';
import type { Document, Index } from '@c4312/scip';
import { normalizeSafeProjectRelativePath } from '../domain/path-normalization.js';
import { readFileWithinLimit, SCIP_ARTIFACT_MAX_BYTES } from '../platform/bounded-file.js';
import { eachWireField, encodeLengthDelimitedTag, encodeVarint, ScipWireError, type WireField } from './scip-wire.js';

export interface SanitizeScipResult {
  removedDefinitionOccurrences: number;
  touchedDocuments: number;
}

const INDEX_DOCUMENTS_FIELD = 2;
const INDEX_EXTERNAL_SYMBOLS_FIELD = 3;
const DOCUMENT_RELATIVE_PATH_FIELD = 1;
const DOCUMENT_OCCURRENCES_FIELD = 2;
const DOCUMENT_SYMBOLS_FIELD = 3;
const SYMBOL_INFORMATION_SYMBOL_FIELD = 1;
const OCCURRENCE_SYMBOL_FIELD = 2;
const OCCURRENCE_SYMBOL_ROLES_FIELD = 3;

/**
 * Streaming form of `sanitizeScipIndex` for whole artifacts. The wire format
 * makes each document an addressable byte range, so both passes (collect
 * defined symbols, then find dangling definition occurrences) frame the
 * buffer instead of materializing the index object graph — a few hundred
 * megabytes of SCIP deserializes to multiple gigabytes of objects, which is
 * what used to push the reindex coordinator over its heap. Documents that
 * need no repair are copied to the output verbatim.
 */
export function sanitizeScipFile(path: string): SanitizeScipResult {
  let buffer: Uint8Array;
  try {
    buffer = readFileWithinLimit(path, { inputKind: 'SCIP sanitization input', maxBytes: SCIP_ARTIFACT_MAX_BYTES });
  } catch {
    return { removedDefinitionOccurrences: 0, touchedDocuments: 0 };
  }

  try {
    return sanitizeScipBuffer(buffer, path);
  } catch (error) {
    // Malformed wire data matches the historical "unreadable input" contract;
    // everything else (notably unsafe document paths) must keep propagating.
    if (error instanceof ScipWireError) return { removedDefinitionOccurrences: 0, touchedDocuments: 0 };
    throw error;
  }
}

function sanitizeScipBuffer(buffer: Uint8Array, path: string): SanitizeScipResult {
  const text = new TextDecoder();
  const definedSymbols = new Set<string>();

  for (const field of eachWireField(buffer)) {
    if (field.wireType !== 2) continue;
    if (field.fieldNumber === INDEX_DOCUMENTS_FIELD) {
      for (const inner of eachWireField(buffer, field.valueStart, field.valueEnd)) {
        if (inner.wireType !== 2) continue;
        if (inner.fieldNumber === DOCUMENT_RELATIVE_PATH_FIELD) {
          normalizeSafeProjectRelativePath(text.decode(buffer.subarray(inner.valueStart, inner.valueEnd)));
        } else if (inner.fieldNumber === DOCUMENT_SYMBOLS_FIELD) {
          collectSymbolInformationSymbol(buffer, inner, text, definedSymbols);
        }
      }
    } else if (field.fieldNumber === INDEX_EXTERNAL_SYMBOLS_FIELD) {
      collectSymbolInformationSymbol(buffer, field, text, definedSymbols);
    }
  }

  let removedDefinitionOccurrences = 0;
  const dirtyDocuments: WireField[] = [];
  for (const field of eachWireField(buffer)) {
    if (field.wireType !== 2 || field.fieldNumber !== INDEX_DOCUMENTS_FIELD) continue;
    const removed = countDanglingDefinitionOccurrences(buffer, field, text, definedSymbols);
    if (removed > 0) {
      removedDefinitionOccurrences += removed;
      dirtyDocuments.push(field);
    }
  }

  if (removedDefinitionOccurrences === 0) {
    return { removedDefinitionOccurrences: 0, touchedDocuments: 0 };
  }

  rewriteSanitizedScip(buffer, path, dirtyDocuments, definedSymbols);
  return { removedDefinitionOccurrences, touchedDocuments: dirtyDocuments.length };
}

function collectSymbolInformationSymbol(
  buffer: Uint8Array,
  informationField: WireField,
  text: TextDecoder,
  definedSymbols: Set<string>,
): void {
  for (const field of eachWireField(buffer, informationField.valueStart, informationField.valueEnd)) {
    if (field.wireType !== 2 || field.fieldNumber !== SYMBOL_INFORMATION_SYMBOL_FIELD) continue;
    const symbol = text.decode(buffer.subarray(field.valueStart, field.valueEnd));
    if (symbol) definedSymbols.add(symbol);
  }
}

function countDanglingDefinitionOccurrences(
  buffer: Uint8Array,
  documentField: WireField,
  text: TextDecoder,
  definedSymbols: Set<string>,
): number {
  let removed = 0;
  for (const field of eachWireField(buffer, documentField.valueStart, documentField.valueEnd)) {
    if (field.wireType !== 2 || field.fieldNumber !== DOCUMENT_OCCURRENCES_FIELD) continue;
    let symbol = '';
    let symbolRoles = 0;
    for (const occurrenceField of eachWireField(buffer, field.valueStart, field.valueEnd)) {
      if (occurrenceField.fieldNumber === OCCURRENCE_SYMBOL_FIELD && occurrenceField.wireType === 2) {
        symbol = text.decode(buffer.subarray(occurrenceField.valueStart, occurrenceField.valueEnd));
      } else if (occurrenceField.fieldNumber === OCCURRENCE_SYMBOL_ROLES_FIELD && occurrenceField.wireType === 0) {
        symbolRoles = occurrenceField.varint;
      }
    }
    if ((symbolRoles & SymbolRole.Definition) !== 0 && !definedSymbols.has(symbol)) removed += 1;
  }
  return removed;
}

function rewriteSanitizedScip(
  buffer: Uint8Array,
  path: string,
  dirtyDocuments: readonly WireField[],
  definedSymbols: Set<string>,
): void {
  const temporaryPath = `${path}.sanitize-tmp`;
  const descriptor = openSync(temporaryPath, 'w', 0o600);
  try {
    let segmentStart = 0;
    for (const field of dirtyDocuments) {
      writeAll(descriptor, buffer.subarray(segmentStart, field.fieldStart));
      const document = fromBinary(DocumentSchema, buffer.subarray(field.valueStart, field.valueEnd));
      document.occurrences = document.occurrences.filter(
        (occurrence) => (occurrence.symbolRoles & SymbolRole.Definition) === 0 || definedSymbols.has(occurrence.symbol),
      );
      const encoded = toBinary(DocumentSchema, document);
      writeAll(descriptor, encodeLengthDelimitedTag(INDEX_DOCUMENTS_FIELD));
      writeAll(descriptor, encodeVarint(encoded.byteLength));
      writeAll(descriptor, encoded);
      segmentStart = field.fieldEnd;
    }
    writeAll(descriptor, buffer.subarray(segmentStart));
  } catch (error) {
    closeSync(descriptor);
    rmSync(temporaryPath, { force: true });
    throw error;
  }
  closeSync(descriptor);
  renameSync(temporaryPath, path);
}

function writeAll(descriptor: number, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.byteLength) offset += writeSync(descriptor, bytes, offset, bytes.byteLength - offset);
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
