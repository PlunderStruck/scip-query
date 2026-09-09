import { fromBinary } from '@bufbuild/protobuf';
import { DocumentSchema, IndexSchema, PositionEncoding } from '@c4312/scip';
import { expect, it } from 'vitest';
import { loadTypeScriptDocumentRuntime } from '../../src/reindex/typescript-document-emitter.js';

it('declares the compiler column encoding in standalone, nested, and reused TypeScript documents', () => {
  const loaded = loadTypeScriptDocumentRuntime();
  if (!loaded.available) throw new Error(loaded.reason);
  const { runtime } = loaded;
  const document = new runtime.Document({ relative_path: 'unicode.ts', occurrences: [] });
  const bytes = document.serializeBinary();
  expect(fromBinary(DocumentSchema, bytes)).toMatchObject({
    relativePath: 'unicode.ts',
    positionEncoding: PositionEncoding.UTF16CodeUnitOffsetFromLineStart,
  });
  const index = new runtime.Index({ documents: [document] });
  expect(fromBinary(IndexSchema, index.serializeBinary()).documents[0]?.positionEncoding).toBe(
    PositionEncoding.UTF16CodeUnitOffsetFromLineStart,
  );
  // Incremental assembly deserializes retained documents with the pinned runtime.
  const reused = runtime.Document.deserializeBinary(bytes);
  expect(fromBinary(DocumentSchema, reused.serializeBinary()).positionEncoding).toBe(
    PositionEncoding.UTF16CodeUnitOffsetFromLineStart,
  );
  expect(loadTypeScriptDocumentRuntime().available).toBe(true);
  expect(document.serializeBinary()).toEqual(bytes);
});
