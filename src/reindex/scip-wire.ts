/**
 * Minimal protobuf wire framing for SCIP artifacts.
 *
 * A SCIP file is one `scip.Index` message, and protobuf's wire format makes
 * its top-level fields (metadata, documents, external symbols) independently
 * addressable byte ranges. Framing lets whole-index passes visit one document
 * at a time — and copy untouched documents verbatim — instead of
 * materializing a multi-gigabyte object graph for a few-hundred-megabyte
 * artifact.
 */

/** Malformed wire data; callers treat the artifact as unreadable, not as a crash. */
export class ScipWireError extends Error {}

export interface WireField {
  fieldNumber: number;
  wireType: number;
  /** Offset of the field's tag byte, for verbatim copies of the whole field. */
  fieldStart: number;
  /** Payload bounds. For length-delimited fields this is the payload; for scalars it spans the encoded value. */
  valueStart: number;
  valueEnd: number;
  /** Offset just past the field. */
  fieldEnd: number;
  /** Decoded value for varint (wire type 0) fields. */
  varint: number;
}

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LENGTH_DELIMITED = 2;
const WIRE_FIXED32 = 5;

function readVarint(buffer: Uint8Array, pos: number, end: number): { value: number; pos: number } {
  let value = 0;
  let shift = 0;
  while (pos < end) {
    const byte = buffer[pos]!;
    pos += 1;
    if (shift < 53) value += (byte & 0x7f) * 2 ** shift;
    else if ((byte & 0x7f) !== 0) throw new ScipWireError('varint exceeds the safe integer range');
    if ((byte & 0x80) === 0) return { value, pos };
    shift += 7;
    if (shift > 63) throw new ScipWireError('varint is longer than 64 bits');
  }
  throw new ScipWireError('varint runs past the end of the buffer');
}

/** Iterate the fields of one message encoded in `buffer[start, end)`. */
export function* eachWireField(buffer: Uint8Array, start = 0, end = buffer.length): Generator<WireField> {
  let pos = start;
  while (pos < end) {
    const fieldStart = pos;
    const tag = readVarint(buffer, pos, end);
    pos = tag.pos;
    const fieldNumber = Math.floor(tag.value / 8);
    const wireType = tag.value % 8;
    if (fieldNumber === 0) throw new ScipWireError('field number 0 is invalid');

    let valueStart = pos;
    let varint = 0;
    if (wireType === WIRE_VARINT) {
      const value = readVarint(buffer, pos, end);
      varint = value.value;
      pos = value.pos;
    } else if (wireType === WIRE_LENGTH_DELIMITED) {
      const length = readVarint(buffer, pos, end);
      valueStart = length.pos;
      pos = length.pos + length.value;
      if (pos > end) throw new ScipWireError('length-delimited field runs past the end of the buffer');
    } else if (wireType === WIRE_FIXED64) {
      pos += 8;
    } else if (wireType === WIRE_FIXED32) {
      pos += 4;
    } else {
      throw new ScipWireError(`unsupported wire type ${wireType}`);
    }
    if (pos > end) throw new ScipWireError('field value runs past the end of the buffer');

    yield { fieldNumber, wireType, fieldStart, valueStart, valueEnd: pos, fieldEnd: pos, varint };
  }
}

export function isLengthDelimited(field: WireField): boolean {
  return field.wireType === WIRE_LENGTH_DELIMITED;
}

export function encodeVarint(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) throw new ScipWireError(`cannot encode varint ${value}`);
  const bytes: number[] = [];
  let remaining = value;
  do {
    let byte = remaining % 128;
    remaining = Math.floor(remaining / 128);
    if (remaining > 0) byte |= 0x80;
    bytes.push(byte);
  } while (remaining > 0);
  return Uint8Array.from(bytes);
}

/** Tag byte(s) for a length-delimited field. */
export function encodeLengthDelimitedTag(fieldNumber: number): Uint8Array {
  return encodeVarint(fieldNumber * 8 + WIRE_LENGTH_DELIMITED);
}

const INDEX_METADATA_FIELD = 1;
const METADATA_PROJECT_ROOT_FIELD = 3;

/**
 * The `scip.Index.metadata.project_root` string, without materializing the
 * index: deserializing a few-hundred-megabyte artifact costs gigabytes of
 * transient objects to answer this one field, which is what pushed the
 * reindex coordinator over its default heap during shared-generation
 * validation. Concatenated shard artifacts carry one metadata message per
 * shard; per protobuf merge semantics the last set value wins.
 */
export function readScipIndexProjectRoot(buffer: Uint8Array): string | undefined {
  const text = new TextDecoder();
  let projectRoot: string | undefined;
  for (const field of eachWireField(buffer)) {
    if (field.fieldNumber !== INDEX_METADATA_FIELD || field.wireType !== 2) continue;
    for (const inner of eachWireField(buffer, field.valueStart, field.valueEnd)) {
      if (inner.fieldNumber !== METADATA_PROJECT_ROOT_FIELD || inner.wireType !== 2) continue;
      const value = text.decode(buffer.subarray(inner.valueStart, inner.valueEnd));
      if (value) projectRoot = value;
    }
  }
  return projectRoot;
}
