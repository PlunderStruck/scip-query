import { resolve } from 'node:path';

import {
  createProtectedWorkAuthorization,
  decodeProtectedWorkAuthorizationRequest,
} from '../../domain/protected-work-authorization.js';
import { sanitizeTerminalLine } from '../../platform/terminal-output.js';
import {
  activateProtectedWorkAuthorization,
  readProtectedWorkAuthorization,
  readProtectedWorkAuthorizations,
  writeProtectedWorkAuthorization,
} from '../../storage/protected-work-authorization.js';
import {
  booleanOptionValue,
  commandOptions,
  parseEnumArgument,
  printJsonEnvelope,
  stringOptionValue,
} from '../command-kit/command-execution.js';
import { resolveProjectRoot } from '../cli-context.js';
import { cliVersion } from '../cli-support.js';
import { optionalTarget, readJsonRequest, requiredCollaborationDomain, requiredString } from './work-state-handlers.js';

const PROTECTED_WORK_AUTHORIZATION_OPERATIONS = ['issue', 'read', 'activate', 'status'] as const;
type ProtectedWorkAuthorizationOperation = (typeof PROTECTED_WORK_AUTHORIZATION_OPERATIONS)[number];

export function handleProtectedWorkAuthorization(
  operationValue: unknown,
  targetValue: unknown,
  rawOpts: unknown,
): void {
  const operation = parseEnumArgument(
    operationValue,
    PROTECTED_WORK_AUTHORIZATION_OPERATIONS,
    'work-authorization operation',
  );
  const target = optionalTarget(targetValue);
  const opts = commandOptions(rawOpts);
  const candidateRoot = resolve(stringOptionValue(opts, 'candidateRoot') ?? resolveProjectRoot());
  const protectedRoot = requiredString(
    stringOptionValue(opts, 'protectedRoot'),
    'work-authorization requires --protected-root outside the candidate worktree',
  );
  try {
    const result = runProtectedWorkAuthorizationOperation(
      operation,
      target,
      protectedRoot,
      candidateRoot,
      stringOptionValue(opts, 'input'),
    );
    if (booleanOptionValue(opts, 'json')) {
      printJsonEnvelope('work-authorization', [operation, ...(target ? [target] : [])], opts, result);
      return;
    }
    renderProtectedWorkAuthorizationResult(operation, result);
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

function runProtectedWorkAuthorizationOperation(
  operation: ProtectedWorkAuthorizationOperation,
  target: string | undefined,
  protectedRoot: string,
  candidateRoot: string,
  inputPath: string | undefined,
): unknown {
  if (operation === 'issue') {
    if (!inputPath) throw new Error('work-authorization issue requires --input <path>');
    const request = decodeProtectedWorkAuthorizationRequest(
      readJsonRequest(inputPath, 'protected work authorization request'),
    );
    if (!request.ok) throw new Error(request.error);
    const authorization = createProtectedWorkAuthorization({
      collaborationDomainId: requiredCollaborationDomain(candidateRoot),
      request: request.request,
      createdAt: new Date().toISOString(),
      toolVersion: cliVersion,
    });
    return { operation, ...writeProtectedWorkAuthorization(protectedRoot, candidateRoot, authorization) };
  }
  if (operation === 'status') {
    return { operation, ...readProtectedWorkAuthorizations(protectedRoot, candidateRoot) };
  }
  const authorizationId = requiredString(target, `work-authorization ${operation} requires an authorization ID`);
  const authorization = readProtectedWorkAuthorization(protectedRoot, candidateRoot, authorizationId);
  if (operation === 'read') return { operation, ...authorization };
  if (authorization.state !== 'current') {
    throw new Error(
      `protected work authorization ${authorizationId} is ${authorization.state}: ${authorization.error}`,
    );
  }
  return {
    operation,
    ...activateProtectedWorkAuthorization(
      candidateRoot,
      requiredCollaborationDomain(candidateRoot),
      authorization.record,
    ),
  };
}

function renderProtectedWorkAuthorizationResult(operation: ProtectedWorkAuthorizationOperation, result: unknown): void {
  const value = result as {
    authorizationId?: string;
    path?: string;
    publication?: string;
    state?: string;
    record?: { authorizationId: string; goal: { goalId: string }; change: { changeId: string } };
    records?: Array<{ authorizationId: string; goal: { goalId: string }; change: { changeId: string } }>;
    issues?: readonly unknown[];
    goal?: { publication: string; record: { goalId: string } };
    change?: { publication: string; record: { changeId: string } };
  };
  if (operation === 'issue') {
    console.log(
      sanitizeTerminalLine(
        `Protected work authorization ${value.publication ?? 'unknown'} at ${value.path ?? 'unknown path'}.`,
      ),
    );
    return;
  }
  if (operation === 'activate') {
    console.log(
      sanitizeTerminalLine(
        `Activated ${value.authorizationId ?? 'unknown authorization'}: goal ${value.goal?.record.goalId ?? 'unknown'} (${value.goal?.publication ?? 'unknown'}), change ${value.change?.record.changeId ?? 'unknown'} (${value.change?.publication ?? 'unknown'}).`,
      ),
    );
    return;
  }
  if (operation === 'read') {
    console.log(`Authorization: ${sanitizeTerminalLine(value.record?.authorizationId ?? value.state ?? 'unknown')}`);
    if (value.record) {
      console.log(`Goal: ${value.record.goal.goalId}`);
      console.log(`Change: ${value.record.change.changeId}`);
    }
    return;
  }
  console.log(`Protected work authorizations: ${value.records?.length ?? 0}`);
  for (const record of value.records ?? []) {
    console.log(`  ${record.authorizationId}  ${record.goal.goalId}  ${record.change.changeId}`);
  }
  console.log(`Record issues: ${value.issues?.length ?? 0}`);
}
