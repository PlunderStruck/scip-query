import { writeAllBytes } from '../platform/write-bytes.js';
import { closeSync, openSync, renameSync, rmSync } from 'node:fs';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import {
  DocumentSchema,
  IndexSchema,
  MetadataSchema,
  PositionEncoding,
  SymbolInformationSchema,
  SymbolRole,
} from '@c4312/scip';
import type { Document, Index, Metadata } from '@c4312/scip';
import { normalizeSafeProjectRelativePath } from '../domain/path-normalization.js';
import { readFileWithinLimit, SCIP_ARTIFACT_MAX_BYTES } from '../platform/bounded-file.js';
import { eachWireField, encodeLengthDelimitedTag, encodeVarint, ScipWireError, type WireField } from './scip-wire.js';

export interface SanitizeScipResult {
  removedDefinitionOccurrences: number;
  touchedDocuments: number;
  /** Metadata shells recovered from explicit nonlocal definition occurrences. */
  recoveredDefinitionSymbols?: number;
}

const INDEX_DOCUMENTS_FIELD = 2;
const INDEX_EXTERNAL_SYMBOLS_FIELD = 3;
const DOCUMENT_RELATIVE_PATH_FIELD = 1;
const DOCUMENT_OCCURRENCES_FIELD = 2;
const DOCUMENT_SYMBOLS_FIELD = 3;
const DOCUMENT_LANGUAGE_FIELD = 4;
const DOCUMENT_POSITION_ENCODING_FIELD = 6;
const SYMBOL_INFORMATION_SYMBOL_FIELD = 1;
const OCCURRENCE_SYMBOL_FIELD = 2;
const OCCURRENCE_SYMBOL_ROLES_FIELD = 3;

/**
 * Streaming form of `sanitizeScipIndex` for whole artifacts. The wire format
 * makes each document an addressable byte range, so both passes (collect
 * defined symbols, then recover metadata for definition occurrences) frame the
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

  collectIndexDefinedSymbols(buffer, text, definedSymbols);

  let removedDefinitionOccurrences = 0;
  let recoveredDefinitionSymbols = 0;
  const dirtyDocuments: Array<{ field: WireField; repair: DefinitionRepair }> = [];
  const metadata = unambiguousProducerMetadata(buffer);
  for (const field of eachWireField(buffer)) {
    if (field.wireType !== 2 || field.fieldNumber !== INDEX_DOCUMENTS_FIELD) continue;
    const repair = documentDefinitionRepair(buffer, field, text, definedSymbols, metadata);
    if (!needsRepair(repair)) continue;
    removedDefinitionOccurrences += repair.removed;
    recoveredDefinitionSymbols += repair.symbols.length;
    dirtyDocuments.push({ field, repair });
  }
  if (dirtyDocuments.length > 0) rewriteSanitizedScip(buffer, path, dirtyDocuments);
  return sanitizeResult(removedDefinitionOccurrences, dirtyDocuments.length, recoveredDefinitionSymbols);
}

interface DefinitionRepair {
  removed: number;
  symbols: string[];
  positionEncoding?: PositionEncoding;
}

/** Metadata is not definition evidence: preserve every nonempty identity, including document-local symbols. */
function recordDefinitionRepair(symbol: string, roles: number, known: Set<string>, repair: DefinitionRepair): void {
  if ((roles & SymbolRole.Definition) === 0) return;
  if (!symbol) {
    repair.removed++;
    return;
  }
  if (symbol.startsWith('local ') || known.has(symbol)) return;
  known.add(symbol);
  repair.symbols.push(symbol);
}

function repairDocument(document: Document, repair: DefinitionRepair): Document {
  if (!needsRepair(repair)) return document;
  return create(DocumentSchema, {
    ...document,
    positionEncoding: repair.positionEncoding ?? document.positionEncoding,
    occurrences: document.occurrences.filter(
      (occurrence) => occurrence.symbol || (occurrence.symbolRoles & SymbolRole.Definition) === 0,
    ),
    symbols: [...document.symbols, ...repair.symbols.map((symbol) => create(SymbolInformationSchema, { symbol }))],
  });
}

function sanitizeResult(
  removedDefinitionOccurrences: number,
  touchedDocuments: number,
  recoveredDefinitionSymbols: number,
): SanitizeScipResult {
  return {
    removedDefinitionOccurrences,
    touchedDocuments,
    ...(recoveredDefinitionSymbols > 0 ? { recoveredDefinitionSymbols } : {}),
  };
}

function collectIndexDefinedSymbols(buffer: Uint8Array, text: TextDecoder, definedSymbols: Set<string>): void {
  for (const field of eachWireField(buffer)) {
    if (field.wireType !== 2) continue;
    if (field.fieldNumber === INDEX_DOCUMENTS_FIELD) {
      collectDocumentDefinedSymbols(buffer, field, text, definedSymbols);
    } else if (field.fieldNumber === INDEX_EXTERNAL_SYMBOLS_FIELD) {
      collectSymbolInformationSymbol(buffer, field, text, definedSymbols);
    }
  }
}

function collectDocumentDefinedSymbols(
  buffer: Uint8Array,
  field: WireField,
  text: TextDecoder,
  definedSymbols: Set<string>,
): void {
  for (const inner of eachWireField(buffer, field.valueStart, field.valueEnd)) {
    if (inner.wireType !== 2) continue;
    if (inner.fieldNumber === DOCUMENT_RELATIVE_PATH_FIELD) {
      normalizeSafeProjectRelativePath(text.decode(buffer.subarray(inner.valueStart, inner.valueEnd)));
    } else if (inner.fieldNumber === DOCUMENT_SYMBOLS_FIELD) {
      collectSymbolInformationSymbol(buffer, inner, text, definedSymbols);
    }
  }
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

function documentDefinitionRepair(
  buffer: Uint8Array,
  documentField: WireField,
  text: TextDecoder,
  known: Set<string>,
  metadata: Metadata | undefined,
): DefinitionRepair {
  const repair: DefinitionRepair = { removed: 0, symbols: [] };
  let language = '',
    positionEncoding = PositionEncoding.UnspecifiedPositionEncoding;
  for (const field of eachWireField(buffer, documentField.valueStart, documentField.valueEnd)) {
    if (field.fieldNumber === DOCUMENT_LANGUAGE_FIELD && field.wireType === 2)
      language = text.decode(buffer.subarray(field.valueStart, field.valueEnd));
    if (field.fieldNumber === DOCUMENT_POSITION_ENCODING_FIELD && field.wireType === 0) positionEncoding = field.varint;
    if (field.wireType !== 2 || field.fieldNumber !== DOCUMENT_OCCURRENCES_FIELD) continue;
    const { symbol, symbolRoles } = occurrenceDefinitionIdentity(buffer, field, text);
    recordDefinitionRepair(symbol, symbolRoles, known, repair);
  }
  repair.positionEncoding = knownProducerEncoding(language, positionEncoding, metadata);
  return repair;
}

function rewriteSanitizedScip(
  buffer: Uint8Array,
  path: string,
  dirtyDocuments: readonly { field: WireField; repair: DefinitionRepair }[],
): void {
  const temporaryPath = `${path}.sanitize-tmp`;
  const descriptor = openSync(temporaryPath, 'w', 0o600);
  try {
    let segmentStart = 0;
    for (const { field, repair } of dirtyDocuments) {
      writeAllBytes(descriptor, buffer.subarray(segmentStart, field.fieldStart));
      const document = repairDocument(
        fromBinary(DocumentSchema, buffer.subarray(field.valueStart, field.valueEnd)),
        repair,
      );
      const encoded = toBinary(DocumentSchema, document);
      writeAllBytes(descriptor, encodeLengthDelimitedTag(INDEX_DOCUMENTS_FIELD));
      writeAllBytes(descriptor, encodeVarint(encoded.byteLength));
      writeAllBytes(descriptor, encoded);
      segmentStart = field.fieldEnd;
    }
    writeAllBytes(descriptor, buffer.subarray(segmentStart));
  } catch (error) {
    closeSync(descriptor);
    rmSync(temporaryPath, { force: true });
    throw error;
  }
  closeSync(descriptor);
  renameSync(temporaryPath, path);
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
  let recoveredDefinitionSymbols = 0;
  let touchedDocuments = 0;
  const documents = index.documents.map((document) => {
    const repair: DefinitionRepair = { removed: 0, symbols: [] };
    for (const occurrence of document.occurrences)
      recordDefinitionRepair(occurrence.symbol, occurrence.symbolRoles, definedSymbols, repair);
    repair.positionEncoding = knownProducerEncoding(document.language, document.positionEncoding, index.metadata);
    const repaired = repairDocument(document, repair);
    if (repaired !== document) touchedDocuments++;
    removedDefinitionOccurrences += repair.removed;
    recoveredDefinitionSymbols += repair.symbols.length;
    return repaired;
  });
  return {
    index: touchedDocuments === 0 ? index : create(IndexSchema, { ...index, documents }),
    ...sanitizeResult(removedDefinitionOccurrences, touchedDocuments, recoveredDefinitionSymbols),
  };
}

function needsRepair(repair: DefinitionRepair): boolean {
  return repair.removed > 0 || repair.symbols.length > 0 || repair.positionEncoding !== undefined;
}

/** Only experimentally verified producer versions supplies a missing convention. */
function knownProducerEncoding(
  language: string,
  encoding: number,
  metadata: Metadata | undefined,
): PositionEncoding | undefined {
  if (encoding !== PositionEncoding.UnspecifiedPositionEncoding) return undefined;
  if (language !== '' && language !== 'python') return undefined;
  if (metadata?.toolInfo?.name !== 'scip-python' || !['0.7.4', '0.7.5'].includes(metadata.toolInfo.version))
    return undefined;
  return PositionEncoding.UTF16CodeUnitOffsetFromLineStart;
}

/** Normalize before combining indexes, while each input's producer identity is still available. */
export function normalizeScipDocumentEncoding(document: Document, metadata: Metadata | undefined): Document {
  const encoding = knownProducerEncoding(document.language, document.positionEncoding, metadata);
  return encoding === undefined ? document : create(DocumentSchema, { ...document, positionEncoding: encoding });
}

function unambiguousProducerMetadata(buffer: Uint8Array): Metadata | undefined {
  let metadata: Metadata | undefined;
  for (const field of eachWireField(buffer)) {
    if (field.fieldNumber !== 1 || field.wireType !== 2) continue;
    const next = fromBinary(MetadataSchema, buffer.subarray(field.valueStart, field.valueEnd));
    if (!next.toolInfo) return undefined;
    if (metadata && JSON.stringify(metadata.toolInfo) !== JSON.stringify(next.toolInfo)) return undefined;
    metadata = next;
  }
  return metadata;
}

function occurrenceDefinitionIdentity(
  buffer: Uint8Array,
  field: WireField,
  text: TextDecoder,
): { symbol: string; symbolRoles: number } {
  let symbol = '';
  let symbolRoles = 0;
  for (const occurrenceField of eachWireField(buffer, field.valueStart, field.valueEnd)) {
    if (occurrenceField.fieldNumber === OCCURRENCE_SYMBOL_FIELD && occurrenceField.wireType === 2) {
      symbol = text.decode(buffer.subarray(occurrenceField.valueStart, occurrenceField.valueEnd));
    } else if (occurrenceField.fieldNumber === OCCURRENCE_SYMBOL_ROLES_FIELD && occurrenceField.wireType === 0) {
      symbolRoles = occurrenceField.varint;
    }
  }
  return { symbol, symbolRoles };
}
