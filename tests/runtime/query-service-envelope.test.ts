import { describe, expect, it } from 'vitest';
import { parseQueryServiceEnvelope } from '../../src/runtime/query-service-envelope.js';
import { QUERY_SERVICE_PROTOCOL_VERSION, type QueryServiceRequest } from '../../src/runtime/query-service.js';
import { SOURCE_INSPECTION_MAX_SELECTORS } from '../../src/domain/source-inspection-limits.js';

const generation = 'generation-1';
const requests = {
  outline: { kind: 'outline', expectedGeneration: generation, filePattern: 'src/a.ts' },
  files: { kind: 'files', expectedGeneration: generation, pattern: '*.ts' },
  stats: { kind: 'stats', expectedGeneration: generation },
  members: { kind: 'members', expectedGeneration: generation, symbolPattern: 'Owner' },
  methods: { kind: 'methods', expectedGeneration: generation, className: 'Owner' },
  'file-dependencies': {
    kind: 'file-dependencies',
    expectedGeneration: generation,
    direction: 'incoming',
    filePattern: 'src/a.ts',
  },
  'imported-by': { kind: 'imported-by', expectedGeneration: generation, symbolPattern: 'run' },
  hierarchy: { kind: 'hierarchy', expectedGeneration: generation, symbolPattern: 'Owner' },
  refs: { kind: 'refs', expectedGeneration: generation, symbolPattern: 'run' },
  'call-graph': { kind: 'call-graph', expectedGeneration: generation, symbolPattern: 'run' },
  'dependence-slice': { kind: 'dependence-slice', expectedGeneration: generation, criterion: 'src/a.ts:2' },
  'by-kind': { kind: 'by-kind', expectedGeneration: generation, kindQuery: 'function' },
  'kind-counts': { kind: 'kind-counts', expectedGeneration: generation },
  imports: { kind: 'imports', expectedGeneration: generation, filePattern: 'src/a.ts' },
  'unused-imports': { kind: 'unused-imports', expectedGeneration: generation, filePattern: 'src/a.ts' },
  system: { kind: 'system', expectedGeneration: generation, modulePattern: 'src/runtime' },
  surface: { kind: 'surface', expectedGeneration: generation, modulePattern: 'src/runtime' },
  code: {
    kind: 'code',
    expectedGeneration: generation,
    selectors: ['src/a.ts:1-5'],
    options: { context: 0, members: 'all' },
  },
  entrypoints: { kind: 'entrypoints', expectedGeneration: generation, options: { search: 'run', scope: 'src' } },
  'source-search': {
    kind: 'source-search',
    expectedGeneration: generation,
    pattern: 'run',
    options: { scope: 'src', context: 0, limit: 1, regexp: false, ignoreCase: true, ranking: 'structural' },
  },
} satisfies { [K in QueryServiceRequest['kind']]: Extract<QueryServiceRequest, { kind: K }> };

function envelope(request: unknown): Record<string, unknown> {
  return {
    mailboxVersion: 1,
    protocolVersion: QUERY_SERVICE_PROTOCOL_VERSION,
    id: 'request-1',
    operationKey: 'operation-1',
    clientId: 'client-1',
    enqueuedAtMs: 10,
    deadlineAtMs: 20,
    sessionIdentity: 'session-1',
    request,
  };
}
function decode(request: unknown): QueryServiceRequest {
  return parseQueryServiceEnvelope(JSON.stringify(envelope(request)), 'session-1').request;
}

describe('query service envelope decoding', () => {
  it.each(Object.values(requests))('decodes $kind and discards undeclared payload fields', (request) => {
    const input = envelope({ ...request, unexpected: 'discard' });
    expect(parseQueryServiceEnvelope(JSON.stringify({ ...input, unexpected: true }), 'session-1')).toEqual(
      envelope(request),
    );
  });

  it.each(Object.values(requests))('rejects absent or invalid fields of $kind', (request) => {
    for (const field of Object.keys(request)) {
      const missing: Record<string, unknown> = { ...request };
      delete missing[field];
      expect(() => decode(missing), `missing ${request.kind}.${field}`).toThrow();
      expect(() => decode({ ...request, [field]: null }), `null ${request.kind}.${field}`).toThrow();
    }
  });

  it.each([
    ['mailboxVersion', 2],
    ['protocolVersion', -1],
    ['id', ''],
    ['operationKey', ''],
    ['clientId', ''],
    ['enqueuedAtMs', -1],
    ['enqueuedAtMs', 1.5],
    ['enqueuedAtMs', Number.MAX_SAFE_INTEGER + 1],
    ['deadlineAtMs', 9],
    ['deadlineAtMs', 20.5],
    ['deadlineAtMs', Number.MAX_SAFE_INTEGER + 1],
    ['sessionIdentity', 'another-session'],
    ['request', []],
    ['request', null],
  ])('rejects invalid envelope field %s=%s', (field, value) => {
    const input = { ...envelope(requests.stats), [field as string]: value };
    expect(() => parseQueryServiceEnvelope(JSON.stringify(input), 'session-1')).toThrow(
      'Invalid query service request envelope.',
    );
  });

  it.each(['null', '[]', '0', '"request"', '{'])('rejects invalid serialized envelope %s', (raw) => {
    expect(() => parseQueryServiceEnvelope(raw, 'session-1')).toThrow();
  });

  it.each(['constructor', '__proto__', 'toString', 'unknown'])('rejects an unregistered kind %s', (kind) => {
    expect(() => decode({ kind, expectedGeneration: generation })).toThrow(
      'Invalid query service source-search request.',
    );
  });

  it('preserves optional-field absence, empty string operands, and exact selector bounds', () => {
    expect(decode({ ...requests.entrypoints, options: {} })).toEqual({ ...requests.entrypoints, options: {} });
    expect(decode({ ...requests['source-search'], options: {} })).toEqual({
      ...requests['source-search'],
      options: {},
    });
    expect(decode({ ...requests.outline, expectedGeneration: '', filePattern: '' })).toEqual({
      ...requests.outline,
      expectedGeneration: '',
      filePattern: '',
    });
    const selectors = Array<string>(SOURCE_INSPECTION_MAX_SELECTORS).fill('src/a.ts');
    expect(decode({ ...requests.code, selectors })).toEqual({ ...requests.code, selectors });
    expect(() => decode({ ...requests.code, selectors: [...selectors, 'src/b.ts'] })).toThrow(
      'Invalid query service code request.',
    );
    for (const invalid of [[], [''], [1], null])
      expect(() => decode({ ...requests.code, selectors: invalid })).toThrow();
    expect(() => decode({ ...requests['source-search'], pattern: '' })).toThrow();
  });

  it('validates options independently and rejects invalid directions', () => {
    for (const options of [[], null, 1]) {
      for (const request of [requests.code, requests.entrypoints, requests['source-search']]) {
        expect(() => decode({ ...request, options })).toThrow();
      }
    }
    for (const context of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, '0']) {
      expect(() => decode({ ...requests.code, options: { ...requests.code.options, context } })).toThrow(
        'non-negative safe integer',
      );
      expect(() => decode({ ...requests['source-search'], options: { context } })).toThrow('non-negative safe integer');
    }
    for (const limit of [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => decode({ ...requests['source-search'], options: { limit } })).toThrow('positive safe integer');
    }
    for (const options of [{ scope: 1 }, { regexp: 1 }, { ignoreCase: 'false' }, { ranking: 'relevance' }]) {
      expect(() => decode({ ...requests['source-search'], options })).toThrow();
    }
    for (const options of [{ search: null }, { scope: 1 }])
      expect(() => decode({ ...requests.entrypoints, options })).toThrow();
    expect(() => decode({ ...requests.code, options: { context: 0, members: 'private' } })).toThrow(
      'members must be exported or all',
    );
    expect(decode({ ...requests['file-dependencies'], direction: 'outgoing' })).toMatchObject({
      direction: 'outgoing',
    });
    expect(() => decode({ ...requests['file-dependencies'], direction: 'both' })).toThrow('file dependencies request');
  });
});
