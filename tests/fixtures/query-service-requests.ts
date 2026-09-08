import { QUERY_SERVICE_PROTOCOL_VERSION, type QueryServiceRequest } from '../../src/runtime/query-service.js';

export const generation = 'generation-1';
export const requests = {
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

export function envelope(request: unknown): Record<string, unknown> {
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
