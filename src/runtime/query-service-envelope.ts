import { SOURCE_INSPECTION_MAX_SELECTORS } from '../domain/source-inspection-limits.js';
import {
  QUERY_SERVICE_PROTOCOL_VERSION,
  type QueryServiceEnvelope,
  type QueryServiceRequest,
} from './query-service.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function readEnvelopeIdentity(record: Record<string, unknown>, sessionIdentity: string) {
  const { id, operationKey, clientId } = record;
  if (
    !isNonEmptyString(id) ||
    !isNonEmptyString(operationKey) ||
    !isNonEmptyString(clientId) ||
    record['sessionIdentity'] !== sessionIdentity
  ) {
    throw new Error('Invalid query service request envelope.');
  }
  return { id, operationKey, clientId, sessionIdentity };
}

function readEnvelopeTiming(record: Record<string, unknown>) {
  const { enqueuedAtMs, deadlineAtMs } = record;
  if (
    !isNonNegativeSafeInteger(enqueuedAtMs) ||
    !isNonNegativeSafeInteger(deadlineAtMs) ||
    deadlineAtMs < enqueuedAtMs
  ) {
    throw new Error('Invalid query service request envelope.');
  }
  return { enqueuedAtMs, deadlineAtMs };
}

export function parseQueryServiceEnvelope(raw: string, expectedSessionIdentity: string): QueryServiceEnvelope {
  const record: unknown = JSON.parse(raw);
  if (!isRecord(record)) throw new Error('Invalid query service request.');
  const request = record['request'];
  if (
    record['mailboxVersion'] !== 1 ||
    record['protocolVersion'] !== QUERY_SERVICE_PROTOCOL_VERSION ||
    !isRecord(request)
  ) {
    throw new Error('Invalid query service request envelope.');
  }
  const identity = readEnvelopeIdentity(record, expectedSessionIdentity);
  const timing = readEnvelopeTiming(record);
  if (typeof request['expectedGeneration'] !== 'string') {
    throw new Error('Invalid query service request generation.');
  }
  return {
    mailboxVersion: 1,
    protocolVersion: QUERY_SERVICE_PROTOCOL_VERSION,
    ...identity,
    ...timing,
    request: decodeRequest(request, request['expectedGeneration']),
  };
}

type RequestDecoders = {
  [K in QueryServiceRequest['kind']]: (
    record: Record<string, unknown>,
    expectedGeneration: string,
  ) => Extract<QueryServiceRequest, { kind: K }>;
};

function requestString(record: Record<string, unknown>, field: string, kind: string): string {
  const value = record[field];
  if (typeof value !== 'string') throw new Error(`Invalid query service ${kind} request.`);
  return value;
}

// Every protocol kind must supply a decoder returning that exact request type.
const requestDecoders = {
  outline: (record, expectedGeneration) => ({
    kind: 'outline',
    expectedGeneration,
    filePattern: requestString(record, 'filePattern', 'outline'),
  }),
  files: (record, expectedGeneration) => ({
    kind: 'files',
    expectedGeneration,
    pattern: requestString(record, 'pattern', 'files'),
  }),
  members: (record, expectedGeneration) => ({
    kind: 'members',
    expectedGeneration,
    symbolPattern: requestString(record, 'symbolPattern', 'members'),
  }),
  methods: (record, expectedGeneration) => ({
    kind: 'methods',
    expectedGeneration,
    className: requestString(record, 'className', 'methods'),
  }),
  'imported-by': (record, expectedGeneration) => ({
    kind: 'imported-by',
    expectedGeneration,
    symbolPattern: requestString(record, 'symbolPattern', 'imported-by'),
  }),
  hierarchy: (record, expectedGeneration) => ({
    kind: 'hierarchy',
    expectedGeneration,
    symbolPattern: requestString(record, 'symbolPattern', 'hierarchy'),
  }),
  refs: (record, expectedGeneration) => ({
    kind: 'refs',
    expectedGeneration,
    symbolPattern: requestString(record, 'symbolPattern', 'refs'),
  }),
  'call-graph': (record, expectedGeneration) => ({
    kind: 'call-graph',
    expectedGeneration,
    symbolPattern: requestString(record, 'symbolPattern', 'call-graph'),
  }),
  'dependence-slice': (record, expectedGeneration) => ({
    kind: 'dependence-slice',
    expectedGeneration,
    criterion: requestString(record, 'criterion', 'dependence-slice'),
  }),
  'by-kind': (record, expectedGeneration) => ({
    kind: 'by-kind',
    expectedGeneration,
    kindQuery: requestString(record, 'kindQuery', 'by-kind'),
  }),
  imports: (record, expectedGeneration) => ({
    kind: 'imports',
    expectedGeneration,
    filePattern: requestString(record, 'filePattern', 'imports'),
  }),
  'unused-imports': (record, expectedGeneration) => ({
    kind: 'unused-imports',
    expectedGeneration,
    filePattern: requestString(record, 'filePattern', 'unused-imports'),
  }),
  system: (record, expectedGeneration) => ({
    kind: 'system',
    expectedGeneration,
    modulePattern: requestString(record, 'modulePattern', 'system'),
  }),
  surface: (record, expectedGeneration) => ({
    kind: 'surface',
    expectedGeneration,
    modulePattern: requestString(record, 'modulePattern', 'surface'),
  }),
  stats: (_record, expectedGeneration) => ({ kind: 'stats', expectedGeneration }),
  'kind-counts': (_record, expectedGeneration) => ({ kind: 'kind-counts', expectedGeneration }),
  'file-dependencies': (record, expectedGeneration) => {
    const direction = record['direction'];
    if (direction !== 'incoming' && direction !== 'outgoing') {
      throw new Error('Invalid query service file dependencies request.');
    }
    return {
      kind: 'file-dependencies',
      expectedGeneration,
      direction,
      filePattern: requestString(record, 'filePattern', 'file dependencies'),
    };
  },
  code: (requestRecord, expectedGeneration) => {
    if (
      !Array.isArray(requestRecord['selectors']) ||
      requestRecord['selectors'].length < 1 ||
      requestRecord['selectors'].length > SOURCE_INSPECTION_MAX_SELECTORS ||
      requestRecord['selectors'].some((selector) => typeof selector !== 'string' || selector.length === 0) ||
      !isRecord(requestRecord['options'])
    ) {
      throw new Error('Invalid query service code request.');
    }
    const optionsRecord = requestRecord['options'] as Record<string, unknown>;
    const members = optionsRecord['members'];
    if (members !== 'exported' && members !== 'all') {
      throw new Error('Query service code members must be exported or all.');
    }
    return {
      kind: 'code',
      expectedGeneration: expectedGeneration,
      selectors: requestRecord['selectors'] as string[],
      options: {
        context: requiredNonNegativeInteger(optionsRecord['context'], 'context'),
        members,
      },
    };
  },
  entrypoints: (requestRecord, expectedGeneration) => {
    if (!isRecord(requestRecord['options'])) {
      throw new Error('Invalid query service entrypoints request.');
    }
    const optionsRecord = requestRecord['options'] as Record<string, unknown>;
    return {
      kind: 'entrypoints',
      expectedGeneration: expectedGeneration,
      options: {
        ...(optionsRecord['search'] === undefined ? {} : { search: requiredString(optionsRecord['search'], 'search') }),
        ...(optionsRecord['scope'] === undefined ? {} : { scope: requiredString(optionsRecord['scope'], 'scope') }),
      },
    };
  },
  'source-search': (requestRecord, expectedGeneration) => {
    if (
      typeof requestRecord['pattern'] !== 'string' ||
      requestRecord['pattern'].length === 0 ||
      !isRecord(requestRecord['options'])
    ) {
      throw new Error('Invalid query service source-search request.');
    }
    const optionsRecord = requestRecord['options'] as Record<string, unknown>;
    const options = {
      ...(optionsRecord['scope'] === undefined ? {} : { scope: requiredString(optionsRecord['scope'], 'scope') }),
      ...(optionsRecord['context'] === undefined
        ? {}
        : { context: requiredNonNegativeInteger(optionsRecord['context'], 'context') }),
      ...(optionsRecord['limit'] === undefined
        ? {}
        : { limit: requiredPositiveInteger(optionsRecord['limit'], 'limit') }),
      ...(optionsRecord['regexp'] === undefined ? {} : { regexp: requiredBoolean(optionsRecord['regexp'], 'regexp') }),
      ...(optionsRecord['ignoreCase'] === undefined
        ? {}
        : { ignoreCase: requiredBoolean(optionsRecord['ignoreCase'], 'ignoreCase') }),
      ...(optionsRecord['ranking'] === undefined
        ? {}
        : { ranking: requiredStructuralRanking(optionsRecord['ranking']) }),
    };
    return {
      kind: 'source-search',
      expectedGeneration: expectedGeneration,
      pattern: requestRecord['pattern'],
      options,
    };
  },
} satisfies RequestDecoders;

function decodeRequest(record: Record<string, unknown>, expectedGeneration: string): QueryServiceRequest {
  const kind = record['kind'];
  if (typeof kind !== 'string' || !Object.hasOwn(requestDecoders, kind)) {
    throw new Error('Invalid query service source-search request.');
  }
  return requestDecoders[kind as keyof typeof requestDecoders](record, expectedGeneration);
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`Query service option ${name} must be a string.`);
  return value;
}

function requiredNonNegativeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Query service option ${name} must be a non-negative safe integer.`);
  }
  return value as number;
}

function requiredPositiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`Query service option ${name} must be a positive safe integer.`);
  }
  return value as number;
}

function requiredBoolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`Query service option ${name} must be a boolean.`);
  return value;
}

function requiredStructuralRanking(value: unknown): 'structural' {
  if (value !== 'structural') throw new Error('Query service option ranking must be structural.');
  return value;
}
