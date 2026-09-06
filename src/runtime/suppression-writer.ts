import { createHash } from 'node:crypto';
import { relative } from 'node:path';
import {
  SUPPRESSION_REASON_CODES,
  type FindingSuppression,
  type SuppressionCounterevidence,
  type SuppressionDecision,
  type SuppressionEvidenceKind,
  type SuppressionReasonCode,
} from '../domain/config-types.js';
import { normalizeSafeProjectRelativePath } from '../domain/path-normalization.js';
import { isSuppressionDecision } from '../domain/suppression-adjudication.js';
import type { ObservationReceipt } from '../domain/observation-receipt.js';
import { readProjectFileText } from '../platform/project-files.js';
import { cliVersion } from '../platform/cli-version.js';
import {
  decodeSuppressionFile,
  assertSuppressionPath,
  LEGACY_SUPPRESSION_FILE_SCHEMA_VERSION,
  SUPPRESSION_FILE_KIND,
  SUPPRESSION_FILE_SCHEMA_VERSION,
  suppressionDirPath,
  suppressionWritePath,
  suppressionIdentity,
  type SuppressionFileRecord,
} from '../storage/suppression-store.js';
import {
  mutateTextFileRevisionAware,
  type RevisionedFileMutationOptions,
  type RevisionedTextSnapshot,
} from './revisioned-file.js';

export interface WriteSuppressionOptions {
  now?: Date;
  expectedRevision?: string;
  toolVersion?: string;
  /** @internal deterministic concurrency/fault-injection boundary. */
  onBeforeCommit?: RevisionedFileMutationOptions['onBeforeCommit'];
}

export interface WriteSuppressionResult {
  path: string;
  revision: string;
  disposition: 'created' | 'unchanged' | 'replaced';
}

export function formatSuppressionWriteReceipt(
  result: WriteSuppressionResult,
  suppression: FindingSuppression,
): string[] {
  const scope = [
    suppression.id ? `finding ${suppression.id}` : undefined,
    suppression.check ? `check ${suppression.check}` : undefined,
    suppression.file ? `file ${suppression.file}` : undefined,
  ].filter((entry): entry is string => entry !== undefined);
  const decision = suppression.decision;
  return [
    `Suppression ${result.disposition} at ${result.path}.`,
    `  scope: ${scope.join('; ')}`,
    `  reason code: ${decision?.reasonCode ?? 'legacy/manual'}`,
    `  counterevidence: ${decision?.evidence.length ?? 0} item(s)`,
    `  expires: ${suppression.expiresAt ?? 'none — no time limit; evidence invalidation still applies'}`,
    `  revision: ${result.revision}`,
  ];
}

export class SuppressionWriteConflictError extends Error {
  constructor(
    message: string,
    readonly path: string,
    readonly currentRevision?: string,
  ) {
    super(
      `${message} ${
        currentRevision
          ? `Current revision: ${currentRevision}. Retry with --replace ${currentRevision} after reviewing it.`
          : 'The suppression file was left untouched.'
      }`,
    );
    this.name = 'SuppressionWriteConflictError';
  }
}

export function buildAutomatedSuppressionDecision(
  projectRoot: string,
  reasonCode: string,
  evidenceSpecs: readonly string[],
  claim: string,
  observation?: ObservationReceipt,
): SuppressionDecision {
  if (!SUPPRESSION_REASON_CODES.includes(reasonCode as SuppressionReasonCode)) {
    throw new Error(
      `unsupported suppression reason code ${JSON.stringify(reasonCode)}; expected one of ${SUPPRESSION_REASON_CODES.join(', ')}`,
    );
  }
  if (evidenceSpecs.length === 0) {
    throw new Error('automatic suppression requires at least one --evidence <kind:referent>');
  }
  const evidence = evidenceSpecs.map((spec) => parseSuppressionEvidence(projectRoot, spec, claim));
  return {
    kind: 'automated-adjudication',
    reasonCode: reasonCode as SuppressionReasonCode,
    decidedBy: 'agent',
    policyVersion: 1,
    ...(observation ? { observation } : {}),
    evidence,
    invalidateOn: {
      targetContentChange: evidence.some((entry) => entry.contentHash !== undefined),
      detectorMajorChange: true,
    },
  };
}

/**
 * Creates one immutable first suppression or performs an explicit
 * compare-and-replace. Different decisions never inherit overwrite authority
 * merely because they name the same finding.
 */
export function writeSuppressionFile(
  projectRoot: string,
  suppression: FindingSuppression,
  nowOrOptions: Date | WriteSuppressionOptions = {},
): WriteSuppressionResult {
  const options: WriteSuppressionOptions = nowOrOptions instanceof Date ? { now: nowOrOptions } : nowOrOptions;
  const normalized = normalizeSuppression(suppression);
  const expectedRevision = normalizeExpectedRevision(options.expectedRevision);
  const path = suppressionWritePath(projectRoot, normalized);
  const now = options.now ?? new Date();
  let disposition: WriteSuppressionResult['disposition'] = 'unchanged';
  const mutation = mutateTextFileRevisionAware(
    path,
    (snapshot) => {
      if (!snapshot.revision.exists) {
        if (expectedRevision) {
          throw new SuppressionWriteConflictError(
            `Cannot replace ${path}: the observed suppression no longer exists.`,
            path,
          );
        }
        disposition = 'created';
        return {
          kind: 'write',
          text: serializeSuppressionRecord(createRecord(normalized, undefined, now, options.toolVersion)),
        };
      }
      const existing = parseExistingSuppression(snapshot, projectRoot);
      if (sameSuppressionPolicy(existing.suppression, normalized)) {
        disposition = 'unchanged';
        return { kind: 'unchanged' };
      }
      if (!expectedRevision) {
        throw new SuppressionWriteConflictError(
          `A different suppression decision already exists at ${path}.`,
          path,
          snapshot.revision.hash,
        );
      }
      if (expectedRevision !== snapshot.revision.hash) {
        throw new SuppressionWriteConflictError(
          `Suppression ${path} changed after the revision you reviewed.`,
          path,
          snapshot.revision.hash,
        );
      }
      disposition = 'replaced';
      return {
        kind: 'write',
        text: serializeSuppressionRecord(createRecord(normalized, existing.suppression, now, options.toolVersion)),
      };
    },
    {
      maxRetries: 0,
      onBeforeCommit: (context) => {
        options.onBeforeCommit?.(context);
        assertSuppressionPath(projectRoot, path);
      },
    },
  );
  return {
    path,
    disposition,
    revision: mutation.current.revision.hash,
  };
}

function parseExistingSuppression(snapshot: RevisionedTextSnapshot, projectRoot: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(snapshot.text) as unknown;
  } catch (error) {
    throw new Error(`Cannot update ${snapshot.path}: the existing suppression is malformed JSON.`, {
      cause: error,
    });
  }
  const identity = relative(suppressionDirPath(projectRoot), snapshot.path)
    .replaceAll('\\', '/')
    .slice(0, -'.json'.length);
  const decoded = decodeSuppressionFile(parsed, identity);
  if ('error' in decoded) {
    throw new Error(`Cannot update ${snapshot.path}: ${decoded.error}.`);
  }
  return decoded;
}

function createRecord(
  suppression: FindingSuppression,
  existing: FindingSuppression | undefined,
  now: Date,
  toolVersion = cliVersion,
): SuppressionFileRecord {
  const timestamp = now.toISOString();
  const { decision, createdAt, ...policy } = suppression;
  const envelope = {
    kind: SUPPRESSION_FILE_KIND as typeof SUPPRESSION_FILE_KIND,
    suppressionIdentity: suppressionIdentity(suppression),
    writer: { tool: 'scip-query' as const, version: toolVersion },
    ...policy,
    createdAt: existing?.createdAt ?? createdAt ?? timestamp,
    ...(existing ? { updatedAt: timestamp } : {}),
  };
  return decision
    ? { ...envelope, schemaVersion: SUPPRESSION_FILE_SCHEMA_VERSION, decision }
    : { ...envelope, schemaVersion: LEGACY_SUPPRESSION_FILE_SCHEMA_VERSION };
}

function normalizeSuppression(suppression: FindingSuppression): FindingSuppression {
  const reason = suppression.reason?.trim();
  if (!reason) throw new Error('suppression requires a non-empty reason');
  const id = suppression.id?.trim();
  const check = suppression.check?.trim();
  if (!id && !check) throw new Error('suppression requires an id or a check');
  if (suppression.decision !== undefined && !isSuppressionDecision(suppression.decision)) {
    throw new Error('suppression decision is malformed');
  }
  return {
    ...(id ? { id } : {}),
    ...(check ? { check } : {}),
    ...(suppression.file ? { file: suppression.file } : {}),
    reason,
    ...(suppression.expiresAt ? { expiresAt: suppression.expiresAt } : {}),
    ...(suppression.createdAt ? { createdAt: suppression.createdAt } : {}),
    ...(suppression.decision ? { decision: suppression.decision } : {}),
  };
}

function normalizeExpectedRevision(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const revision = value.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(revision)) {
    throw new Error('--replace requires the 64-character SHA-256 revision reported by suppress.');
  }
  return revision;
}

function sameSuppressionPolicy(left: FindingSuppression, right: FindingSuppression): boolean {
  return JSON.stringify(policyFields(left)) === JSON.stringify(policyFields(right));
}

function policyFields(suppression: FindingSuppression): Omit<FindingSuppression, 'createdAt'> {
  const { createdAt: _createdAt, ...policy } = suppression;
  return policy;
}

function serializeSuppressionRecord(record: SuppressionFileRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

function parseSuppressionEvidence(projectRoot: string, spec: string, claim: string): SuppressionCounterevidence {
  const separator = spec.indexOf(':');
  if (separator <= 0 || separator === spec.length - 1) {
    throw new Error('--evidence must use <source|config|test|graph>:<referent>');
  }
  const kind = spec.slice(0, separator) as SuppressionEvidenceKind;
  const rawReferent = spec.slice(separator + 1).trim();
  if (kind === 'graph') {
    if (!rawReferent.startsWith('scip-query ')) {
      throw new Error('graph suppression evidence must name the exact scip-query command that produced it');
    }
    return { kind, referent: rawReferent, claim };
  }
  if (kind !== 'source' && kind !== 'config' && kind !== 'test') {
    throw new Error(`unsupported suppression evidence kind ${JSON.stringify(kind)}`);
  }
  const referent = normalizeSafeProjectRelativePath(rawReferent);
  const content = readProjectFileText(projectRoot, referent);
  return {
    kind,
    referent,
    claim,
    contentHash: createHash('sha256').update(content).digest('hex'),
  };
}
