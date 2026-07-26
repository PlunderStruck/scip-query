import { basename, join } from 'node:path';
import type { FindingSuppression } from '../domain/config-types.js';
import { cliVersion } from '../platform/cli-version.js';
import {
  decodeSuppressionFile,
  SUPPRESSION_FILE_SCHEMA_VERSION,
  suppressionDirPath,
  suppressionFileName,
  suppressionIdentity,
  type SuppressionFileRecordV1,
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
  const path = join(suppressionDirPath(projectRoot), suppressionFileName(normalized));
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
      const existing = parseExistingSuppression(snapshot);
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
      onBeforeCommit: options.onBeforeCommit,
    },
  );
  return {
    path,
    disposition,
    revision: mutation.current.revision.hash,
  };
}

function parseExistingSuppression(snapshot: RevisionedTextSnapshot) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(snapshot.text) as unknown;
  } catch (error) {
    throw new Error(`Cannot update ${snapshot.path}: the existing suppression is malformed JSON.`, {
      cause: error,
    });
  }
  const decoded = decodeSuppressionFile(parsed, suppressionIdentityFromPath(snapshot.path));
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
): SuppressionFileRecordV1 {
  const timestamp = now.toISOString();
  return {
    schemaVersion: SUPPRESSION_FILE_SCHEMA_VERSION,
    suppressionIdentity: suppressionIdentity(suppression),
    writer: { tool: 'scip-query', version: toolVersion },
    ...suppression,
    createdAt: existing?.createdAt ?? suppression.createdAt ?? timestamp,
    ...(existing ? { updatedAt: timestamp } : {}),
  };
}

function normalizeSuppression(suppression: FindingSuppression): FindingSuppression {
  const reason = suppression.reason?.trim();
  if (!reason) throw new Error('suppression requires a non-empty reason');
  const id = suppression.id?.trim();
  const check = suppression.check?.trim();
  if (!id && !check) throw new Error('suppression requires an id or a check');
  return {
    ...(id ? { id } : {}),
    ...(check ? { check } : {}),
    ...(suppression.file ? { file: suppression.file } : {}),
    reason,
    ...(suppression.expiresAt ? { expiresAt: suppression.expiresAt } : {}),
    ...(suppression.createdAt ? { createdAt: suppression.createdAt } : {}),
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

function suppressionIdentityFromPath(path: string): string {
  const name = basename(path);
  return name.endsWith('.json') ? name.slice(0, -'.json'.length) : name;
}

function serializeSuppressionRecord(record: SuppressionFileRecordV1): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}
