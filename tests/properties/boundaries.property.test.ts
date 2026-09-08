import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { closeSync, fstatSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { it } from 'vitest';
import { parseQueryServiceEnvelope } from '../../src/runtime/query-service-envelope.js';
import {
  readFileDescriptorBytes,
  readFileWithinLimit,
  hashFileWithinLimit,
} from '../../src/filesystem/bounded-file.js';
import { readProjectFile } from '../../src/platform/project-files.js';
import { requests, envelope } from '../fixtures/query-service-requests.js';
import { checkProperty, textArbitrary, PROPERTY_TIMEOUT } from './support.js';

it(
  'boundaries: every registered request kind round-trips and rejects identity, deadline and payload corruption',
  async () => {
    await checkProperty(
      'boundaries',
      'request-envelope-contract',
      fc.property(
        fc.constantFrom(...Object.values(requests)),
        textArbitrary,
        fc.nat({ max: 1_000_000 }),
        fc.integer({ min: 0, max: 9 }),
        (template, text, enqueued, mutation) => {
          const request = { ...template, expectedGeneration: text };
          const input = {
            ...envelope(request),
            id: 'id:' + text,
            operationKey: 'op:' + text,
            clientId: 'client:' + text,
            sessionIdentity: 'session:' + text,
            enqueuedAtMs: enqueued,
            deadlineAtMs: enqueued + 100,
          };
          assert.deepEqual(
            parseQueryServiceEnvelope(JSON.stringify({ ...input, unknownField: text }), input.sessionIdentity),
            input,
          );
          const corruptions: Array<Record<string, unknown>> = [
            { sessionIdentity: input.sessionIdentity + 'wrong' },
            { id: '' },
            { protocolVersion: -1 },
            { mailboxVersion: 2 },
            { deadlineAtMs: enqueued - 1 },
            { enqueuedAtMs: -1 },
            { deadlineAtMs: Number.MAX_SAFE_INTEGER + 1 },
            { request: { ...request, kind: '__proto__' } },
            { request: { ...request, expectedGeneration: null } },
            { request: [] },
          ];
          assert.throws(() =>
            parseQueryServiceEnvelope(JSON.stringify({ ...input, ...corruptions[mutation] }), input.sessionIdentity),
          );
          assert.throws(() => parseQueryServiceEnvelope(JSON.stringify(input).slice(0, -1), input.sessionIdentity));
        },
      ),
    );
  },
  PROPERTY_TIMEOUT,
);

it(
  'boundaries: actual file readers enforce byte limits and preserve descriptor ownership for generated binary content',
  async () => {
    await checkProperty(
      'boundaries',
      'real-file-byte-limits',
      fc.property(fc.uint8Array({ maxLength: 2048 }), fc.integer({ min: 0, max: 2048 }), (raw, limit) => {
        const root = mkdtempSync(join(tmpdir(), 'scip-query-property-bytes-'));
        const path = join(root, 'input.ts');
        const bytes = Buffer.from(raw);
        try {
          writeFileSync(path, bytes);
          const readers = [
            () => readFileWithinLimit(path, { inputKind: 'property', maxBytes: limit }),
            () => readProjectFile(root, 'input.ts', { maxBytes: limit }),
          ];
          for (const read of readers) {
            if (bytes.length > limit) assert.throws(read);
            else assert.deepEqual(read(), bytes);
          }
          const actualHash = createHash('sha256');
          if (bytes.length <= limit) {
            assert.equal(
              hashFileWithinLimit(path, { inputKind: 'property', maxBytes: limit }, (chunk) => {
                actualHash.update(chunk);
              }),
              bytes.length,
            );
            assert.equal(actualHash.digest('hex'), createHash('sha256').update(bytes).digest('hex'));
          }
          const descriptor = openSync(path, 'r');
          try {
            assert.deepEqual(readFileDescriptorBytes(descriptor, limit), bytes.subarray(0, limit));
            assert.equal(fstatSync(descriptor).size, bytes.length);
          } finally {
            closeSync(descriptor);
          }
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      }),
      'integration',
    );
  },
  PROPERTY_TIMEOUT,
);
