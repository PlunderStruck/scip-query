import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { it } from 'vitest';
import { encodeResultCursor, decodeCompatibleResultCursor } from '../../src/runtime/result-pagination.js';
import {
  CLI_OUTPUT_PAGE_KIND,
  CLI_OUTPUT_PAGE_SCHEMA_VERSION,
  decodeCliOutputPageEnvelope,
  requireCliOutputPageEnvelope,
  runWithCliOutputPagination,
  continueCliOutput,
} from '../../src/runtime/output-pagination.js';
import { checkProperty, textArbitrary, PROPERTY_TIMEOUT } from './support.js';

it(
  'pagination: cursors retain exact invocation identity and contradictory page counts are rejected',
  async () => {
    await checkProperty(
      'pagination',
      'identity-and-coverage-accounting',
      fc.property(
        textArbitrary,
        textArbitrary,
        fc.nat({ max: 1_000_000 }),
        fc.nat({ max: 1000 }),
        fc.boolean(),
        (text, target, offset, remaining, keyset) => {
          const identity = { command: 'refs', target, indexGeneration: 'generation:' + text };
          const position = keyset
            ? {
                after: { relativePath: 'path:' + text, line: offset },
                producer: 'source-keyset' as const,
                semanticEnrichment: false,
              }
            : { offset };
          const cursor = encodeResultCursor({ ...identity, ...position });
          assert.deepEqual(decodeCompatibleResultCursor(cursor, identity), {
            version: keyset ? 2 : 1,
            ...identity,
            ...position,
          });
          for (const field of ['command', 'target', 'indexGeneration'] as const)
            assert.throws(() =>
              decodeCompatibleResultCursor(cursor, { ...identity, [field]: identity[field] + 'changed' }),
            );
          const page = {
            offset,
            returnedCharacters: text.length,
            totalCharacters: offset + text.length + remaining,
            omittedCharacters: offset + remaining,
            remainingCharacters: remaining,
            outputHash: 'a'.repeat(64),
            complete: remaining === 0,
            ...(remaining > 0 ? { continuation: { cursor: 'test', command: 'continue test' } } : {}),
          };
          const envelope = {
            kind: CLI_OUTPUT_PAGE_KIND,
            schemaVersion: CLI_OUTPUT_PAGE_SCHEMA_VERSION,
            producer: { name: 'scip-query', version: 'test' },
            command: 'refs',
            contentType: 'text/plain',
            content: text,
            page,
          };
          assert.equal(decodeCliOutputPageEnvelope(envelope).kind, 'supported');
          for (const field of [
            'offset',
            'returnedCharacters',
            'totalCharacters',
            'omittedCharacters',
            'remainingCharacters',
          ] as const) {
            assert.equal(
              decodeCliOutputPageEnvelope({ ...envelope, page: { ...page, [field]: page[field] + 1 } }).kind,
              'malformed',
            );
          }
          assert.equal(
            decodeCliOutputPageEnvelope({ ...envelope, page: { ...page, complete: !page.complete } }).kind,
            'malformed',
          );
        },
      ),
    );
  },
  PROPERTY_TIMEOUT,
);

it(
  'pagination: saved Unicode output recovers exactly across arbitrary byte chunk boundaries and every continuation',
  async () => {
    await checkProperty(
      'pagination',
      'saved-output-lossless-recovery',
      fc.asyncProperty(
        textArbitrary,
        fc.integer({ min: 1, max: 31 }),
        fc.integer({ min: 1000, max: 2000 }),
        async (text, chunkSize, pageSize) => {
          const root = mkdtempSync(join(tmpdir(), 'scip-query-property-pages-'));
          const content = JSON.stringify({ value: (text + '😀\n').repeat(150) });
          const bytes = Buffer.from(content);
          const chunks: string[] = [];
          const runtime = {
            writeStdout: (value: string) => {
              chunks.push(value);
            },
            writeStderr: (value: string) => {
              throw new Error(value);
            },
            stdoutIsRegularFile: () => false,
          };
          try {
            await runWithCliOutputPagination(
              {
                command: 'refs',
                producerVersion: 'test',
                argv: ['refs', '--json', '--agent-output'],
                cwd: root,
                json: true,
                agentOutput: true,
                pageSize,
                snapshotRoot: root,
                sourceSession: false,
              },
              () => {
                for (let n = 0; n < bytes.length; n += chunkSize)
                  process.stdout.write(bytes.subarray(n, n + chunkSize));
              },
              runtime,
            );
            const initial = chunks.join('');
            // A complete first page is intentionally emitted without an envelope.
            if (initial === content) return;
            let page = requireCliOutputPageEnvelope(JSON.parse(initial));
            let recovered = '';
            const cursors = new Set<string>();
            const hash = page.page.outputHash;
            for (;;) {
              assert.equal(page.page.offset, recovered.length);
              assert.equal(page.page.totalCharacters, content.length);
              assert.equal(page.page.outputHash, hash);
              recovered += page.content;
              if (page.page.complete) break;
              const cursor = page.page.continuation.cursor;
              assert.ok(!cursors.has(cursor));
              cursors.add(cursor);
              assert.ok(cursors.size < content.length + 1, 'continuation must progress');
              chunks.length = 0;
              await continueCliOutput(cursor, 'test', root, runtime);
              page = requireCliOutputPageEnvelope(JSON.parse(chunks.join('')));
            }
            assert.equal(recovered, content);
          } finally {
            rmSync(root, { recursive: true, force: true });
          }
        },
      ),
      'integration',
    );
  },
  PROPERTY_TIMEOUT,
);
