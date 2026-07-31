import { isRecordObject } from '../domain/record-validation.js';
import { isObservationReceipt, type ObservationReceipt } from '../domain/observation-receipt.js';
import { isCommandOperationRole, type CommandOperationRole } from './command-operation.js';

export const CLI_JSON_ENVELOPE_KIND = 'scip-query-result' as const;
export const LEGACY_CLI_JSON_ENVELOPE_SCHEMA_VERSION = 0 as const;
export const CURRENT_CLI_JSON_ENVELOPE_SCHEMA_VERSION = 1 as const;
export const DEFAULT_CLI_RESULT_SCHEMA_VERSION = 1 as const;
export const CLI_EVIDENCE_CONTEXT_SCHEMA_VERSION = 1 as const;
export const CLI_ANALYSIS_MANIFEST_SCHEMA_VERSION = 1 as const;

export interface CliJsonProducer {
  name: 'scip-query';
  version: string;
}

/**
 * How one CLI result was produced and how much of the possible answer the
 * invocation examined. These fields remain separate from the receipt because
 * changing an analysis budget does not change which repository state was
 * observed.
 */
export interface CliAnalysisManifestV1 {
  schemaVersion: typeof CLI_ANALYSIS_MANIFEST_SCHEMA_VERSION;
  evidence?: 'graph-fact' | 'heuristic' | 'mixed';
  analysisBudget?: unknown;
  coverage?: unknown;
}

/**
 * The self-contained evidence carried by one repository-observation result.
 * A version-1 receipt supplies local provenance; it does not by itself claim
 * the fixed-snapshot and content relationships required for final completion.
 */
export interface CliEvidenceContextV1 {
  schemaVersion: typeof CLI_EVIDENCE_CONTEXT_SCHEMA_VERSION;
  /** Optional only so evidence contexts written before operation roles remain readable. */
  operationRole?: CommandOperationRole;
  receipt: ObservationReceipt;
  analysisManifest: CliAnalysisManifestV1;
}

/**
 * One public machine-readable CLI response. The envelope is the stable
 * transport contract; `result` remains the command-owned payload whose schema
 * can advance independently through `resultSchemaVersion`.
 */
export interface CliJsonEnvelopeV1<Result = unknown> {
  kind: typeof CLI_JSON_ENVELOPE_KIND;
  schemaVersion: typeof CURRENT_CLI_JSON_ENVELOPE_SCHEMA_VERSION;
  producer: CliJsonProducer;
  command: string;
  /** Optional only for additive compatibility with envelopes written before this field existed. */
  operationRole?: CommandOperationRole;
  resultSchemaVersion: number;
  evidence?: 'graph-fact' | 'heuristic' | 'mixed';
  analysisBudget?: unknown;
  args: readonly unknown[];
  options: Readonly<Record<string, unknown>>;
  result: Result;
  coverage?: unknown;
  agentResult?: unknown;
  evidenceContext?: CliEvidenceContextV1;
}

export interface LegacyCliJsonEnvelope<Result = unknown> {
  command: string;
  args: readonly unknown[];
  options: Readonly<Record<string, unknown>>;
  result: Result;
  evidence?: 'graph-fact' | 'heuristic' | 'mixed';
  analysisBudget?: unknown;
  coverage?: unknown;
  agentResult?: unknown;
}

export type CompatibleCliJsonEnvelope<Result = unknown> =
  | {
      kind: 'legacy';
      schemaVersion: typeof LEGACY_CLI_JSON_ENVELOPE_SCHEMA_VERSION;
      envelope: LegacyCliJsonEnvelope<Result>;
    }
  | {
      kind: 'supported';
      schemaVersion: typeof CURRENT_CLI_JSON_ENVELOPE_SCHEMA_VERSION;
      envelope: CliJsonEnvelopeV1<Result>;
    };

export type DecodedCliJsonEnvelope<Result = unknown> =
  | CompatibleCliJsonEnvelope<Result>
  | {
      kind: 'unsupported';
      schemaVersion: number;
      direction: 'older' | 'future';
      producer?: { name: string; version: string };
    }
  | {
      kind: 'unsupported-result';
      schemaVersion: typeof CURRENT_CLI_JSON_ENVELOPE_SCHEMA_VERSION;
      command: string;
      resultSchemaVersion: number;
      supportedResultSchemaVersions: readonly number[];
    }
  | { kind: 'malformed'; reason: string };

export function createCliJsonEnvelope<Result>(
  input: Omit<CliJsonEnvelopeV1<Result>, 'kind' | 'schemaVersion' | 'producer' | 'resultSchemaVersion'> & {
    producerVersion: string;
    resultSchemaVersion?: number;
  },
): CliJsonEnvelopeV1<Result> {
  const resultSchemaVersion = input.resultSchemaVersion ?? DEFAULT_CLI_RESULT_SCHEMA_VERSION;
  if (!isPositiveSafeInteger(resultSchemaVersion)) {
    throw new Error('CLI result schema version must be a positive safe integer.');
  }
  const { producerVersion, ...fields } = input;
  return {
    kind: CLI_JSON_ENVELOPE_KIND,
    schemaVersion: CURRENT_CLI_JSON_ENVELOPE_SCHEMA_VERSION,
    producer: { name: 'scip-query', version: producerVersion },
    resultSchemaVersion,
    ...fields,
  };
}

export function serializeCliJsonEnvelope(envelope: CliJsonEnvelopeV1, compact: boolean): string {
  return JSON.stringify(envelope, null, compact ? 0 : 2);
}

/**
 * Decodes the current envelope and the immediately preceding unversioned
 * shape. Unknown additive fields are deliberately preserved on the returned
 * object and ignored by compatibility checks.
 */
export function decodeCliJsonEnvelope<Result = unknown>(input: unknown): DecodedCliJsonEnvelope<Result> {
  if (!isRecordObject(input)) return { kind: 'malformed', reason: 'CLI JSON output must be an object.' };

  const hasKind = Object.hasOwn(input, 'kind');
  const hasSchemaVersion = Object.hasOwn(input, 'schemaVersion');
  if (!hasKind && !hasSchemaVersion) {
    const reason = validateCommonEnvelopeFields(input);
    return reason
      ? { kind: 'malformed', reason: `Legacy CLI JSON envelope: ${reason}` }
      : {
          kind: 'legacy',
          schemaVersion: LEGACY_CLI_JSON_ENVELOPE_SCHEMA_VERSION,
          envelope: input as unknown as LegacyCliJsonEnvelope<Result>,
        };
  }
  if (!hasKind || !hasSchemaVersion) {
    return { kind: 'malformed', reason: 'CLI JSON envelope must contain both kind and schemaVersion.' };
  }
  if (input['kind'] !== CLI_JSON_ENVELOPE_KIND) {
    return {
      kind: 'malformed',
      reason: `Unsupported CLI JSON envelope kind: ${describeValue(input['kind'])}.`,
    };
  }

  const schemaVersion = input['schemaVersion'];
  if (!Number.isSafeInteger(schemaVersion) || Number(schemaVersion) < 1) {
    return { kind: 'malformed', reason: 'CLI JSON envelope schemaVersion must be a positive safe integer.' };
  }
  if (schemaVersion !== CURRENT_CLI_JSON_ENVELOPE_SCHEMA_VERSION) {
    return {
      kind: 'unsupported',
      schemaVersion: Number(schemaVersion),
      direction: Number(schemaVersion) < CURRENT_CLI_JSON_ENVELOPE_SCHEMA_VERSION ? 'older' : 'future',
      ...(isProducer(input['producer']) ? { producer: input['producer'] } : {}),
    };
  }

  const commonReason = validateCommonEnvelopeFields(input);
  if (commonReason) return { kind: 'malformed', reason: `CLI JSON envelope v1: ${commonReason}` };
  if (!isProducer(input['producer'])) {
    return {
      kind: 'malformed',
      reason: 'CLI JSON envelope v1: producer must identify scip-query and its non-empty version.',
    };
  }
  if (!isPositiveSafeInteger(input['resultSchemaVersion'])) {
    return {
      kind: 'malformed',
      reason: 'CLI JSON envelope v1: resultSchemaVersion must be a positive safe integer.',
    };
  }
  const supportedResultSchemaVersions = supportedCliResultSchemaVersions(input['command'] as string);
  if (!supportedResultSchemaVersions.includes(input['resultSchemaVersion'])) {
    return {
      kind: 'unsupported-result',
      schemaVersion: CURRENT_CLI_JSON_ENVELOPE_SCHEMA_VERSION,
      command: input['command'] as string,
      resultSchemaVersion: input['resultSchemaVersion'],
      supportedResultSchemaVersions,
    };
  }
  if (input['evidenceContext'] !== undefined && !isCliEvidenceContextV1(input['evidenceContext'])) {
    return {
      kind: 'malformed',
      reason: 'CLI JSON envelope v1: evidenceContext must contain a supported receipt and analysis manifest.',
    };
  }
  if (input['operationRole'] !== undefined && !isCommandOperationRole(input['operationRole'])) {
    return {
      kind: 'malformed',
      reason: 'CLI JSON envelope v1: operationRole must be a supported command operation role.',
    };
  }
  if (
    isRecordObject(input['evidenceContext']) &&
    input['operationRole'] !== undefined &&
    input['evidenceContext']['operationRole'] !== undefined &&
    input['operationRole'] !== input['evidenceContext']['operationRole']
  ) {
    return {
      kind: 'malformed',
      reason: 'CLI JSON envelope v1: top-level and evidence-context operation roles must agree.',
    };
  }

  return {
    kind: 'supported',
    schemaVersion: CURRENT_CLI_JSON_ENVELOPE_SCHEMA_VERSION,
    envelope: input as unknown as CliJsonEnvelopeV1<Result>,
  };
}

export function requireCompatibleCliJsonEnvelope<Result = unknown>(input: unknown): CompatibleCliJsonEnvelope<Result> {
  const decoded = decodeCliJsonEnvelope<Result>(input);
  if (decoded.kind === 'legacy' || decoded.kind === 'supported') return decoded;
  if (decoded.kind === 'unsupported') {
    const producer = decoded.producer ? ` from ${decoded.producer.name}@${decoded.producer.version}` : '';
    throw new Error(
      `Unsupported scip-query CLI JSON schemaVersion ${decoded.schemaVersion}${producer}; this consumer supports the legacy unversioned envelope and schemaVersion ${CURRENT_CLI_JSON_ENVELOPE_SCHEMA_VERSION}.`,
    );
  }
  if (decoded.kind === 'unsupported-result') {
    throw new Error(
      `Unsupported resultSchemaVersion ${decoded.resultSchemaVersion} for scip-query command ${JSON.stringify(decoded.command)}; this consumer supports ${decoded.supportedResultSchemaVersions.join(', ')}.`,
    );
  }
  throw new Error(`Malformed scip-query CLI JSON envelope: ${decoded.reason}`);
}

/**
 * Result schemas start at v1. A command that advances independently adds its
 * supported transition window here without forcing unrelated commands to
 * change their payload contract.
 */
export function supportedCliResultSchemaVersions(command: string): readonly number[] {
  return RESULT_SCHEMA_VERSION_OVERRIDES[command] ?? [DEFAULT_CLI_RESULT_SCHEMA_VERSION];
}

const RESULT_SCHEMA_VERSION_OVERRIDES: Readonly<Record<string, readonly number[]>> = {};

function validateCommonEnvelopeFields(input: Record<string, unknown>): string | null {
  if (typeof input['command'] !== 'string' || input['command'].length === 0) {
    return 'command must be a non-empty string.';
  }
  if (!Array.isArray(input['args'])) return 'args must be an array.';
  if (!isRecordObject(input['options'])) return 'options must be an object.';
  if (!Object.hasOwn(input, 'result')) return 'result is required.';
  return null;
}

function isProducer(value: unknown): value is { name: 'scip-query'; version: string } {
  return (
    isRecordObject(value) &&
    value['name'] === 'scip-query' &&
    typeof value['version'] === 'string' &&
    value['version'].length > 0
  );
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isCliEvidenceContextV1(value: unknown): value is CliEvidenceContextV1 {
  if (!isRecordObject(value) || value['schemaVersion'] !== CLI_EVIDENCE_CONTEXT_SCHEMA_VERSION) return false;
  if (value['operationRole'] !== undefined && !isCommandOperationRole(value['operationRole'])) return false;
  if (!isObservationReceipt(value['receipt'])) return false;
  const manifest = value['analysisManifest'];
  return (
    isRecordObject(manifest) &&
    manifest['schemaVersion'] === CLI_ANALYSIS_MANIFEST_SCHEMA_VERSION &&
    (manifest['evidence'] === undefined ||
      manifest['evidence'] === 'graph-fact' ||
      manifest['evidence'] === 'heuristic' ||
      manifest['evidence'] === 'mixed')
  );
}

function describeValue(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}
