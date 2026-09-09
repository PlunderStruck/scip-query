import { PositionEncoding } from '@c4312/scip';

interface DocumentWriter {
  writeEnum(field: number, value: number): void;
}

interface DocumentSerializer {
  serialize(writer?: DocumentWriter): Uint8Array | void;
}

const installed = new WeakSet<object>();
const encoding = PositionEncoding.UTF16CodeUnitOffsetFromLineStart;

/**
 * scip-typescript 0.4.0 uses TypeScript's UTF-16 columns, but its older generated
 * Document serializer omits SCIP field 6 (position_encoding). Extend that one
 * serializer for both standalone fragments and documents nested in full indexes.
 */
export function installTypeScriptDocumentEncoding(prototype: DocumentSerializer): void {
  if (installed.has(prototype)) return;
  const serialize = prototype.serialize;
  if (typeof serialize !== 'function') throw new Error('scip-typescript document serializer is unavailable');
  prototype.serialize = function (writer) {
    const bytes = serialize.call(this, writer);
    if (writer) {
      writer.writeEnum(6, encoding);
      return;
    }
    if (!bytes) throw new Error('scip-typescript document serializer returned no bytes');
    const encoded = new Uint8Array(bytes.length + 2);
    encoded.set(bytes);
    // Varint tag for Document.position_encoding (field 6), then its enum value.
    encoded.set([6 << 3, encoding], bytes.length);
    return encoded;
  };
  installed.add(prototype);
}
