import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

import {
  decodeGoalCreateRequest,
  decodeIntendedChangeCreateRequest,
  renderGoalGherkin,
  type GoalRecordV1,
} from '../../domain/autonomous-work-state.js';
import { readSmallArtifactText } from '../../platform/bounded-file.js';
import { sanitizeTerminalLine, sanitizeTerminalText } from '../../platform/terminal-output.js';
import {
  createGoalRecordFile,
  createIntendedChangeRecordFile,
  readGoalRecordFile,
  readGoalRecordPath,
  readGoalRecords,
  readIntendedChangeRecordFile,
  readIntendedChangeRecordPath,
  readIntendedChangeRecords,
} from '../../storage/autonomous-work-state.js';
import { commandOptions, printJsonEnvelope, stringOptionValue } from '../command-kit/command-execution.js';
import { resolveProjectRoot } from '../cli-context.js';
import { cliVersion } from '../cli-support.js';
import { loadProjectConfig } from '../config.js';

const WORK_STATE_OPERATIONS = ['create', 'read', 'validate', 'status'] as const;
type WorkStateOperation = (typeof WORK_STATE_OPERATIONS)[number];

export function handleGoal(operationValue: unknown, targetValue: unknown, rawOpts: unknown): void {
  const operation = workStateOperation(operationValue, 'goal');
  const target = optionalTarget(targetValue);
  const opts = commandOptions(rawOpts);
  const projectRoot = resolveProjectRoot();
  const result = runGoalOperation(projectRoot, operation, target, stringOptionValue(opts, 'input'));
  printWorkStateResult('goal', [operation, ...(target ? [target] : [])], opts, result);
  if (workStateResultFailed(result)) process.exitCode = 1;
}

export function handleIntendedChange(operationValue: unknown, targetValue: unknown, rawOpts: unknown): void {
  const operation = workStateOperation(operationValue, 'change');
  const target = optionalTarget(targetValue);
  const opts = commandOptions(rawOpts);
  const projectRoot = resolveProjectRoot();
  const result = runIntendedChangeOperation(projectRoot, operation, target, stringOptionValue(opts, 'input'));
  printWorkStateResult('change', [operation, ...(target ? [target] : [])], opts, result);
  if (workStateResultFailed(result)) process.exitCode = 1;
}

function runGoalOperation(
  projectRoot: string,
  operation: WorkStateOperation,
  target: string | undefined,
  input: string | undefined,
): unknown {
  switch (operation) {
    case 'create': {
      const request = decodeGoalCreateRequest(readJsonRequest(requiredInput(input, 'goal create')));
      if (!request.ok) throw new Error(request.error);
      const result = createGoalRecordFile(projectRoot, requiredCollaborationDomain(projectRoot), request.request, {
        toolVersion: cliVersion,
      });
      return { operation, ...result, gherkin: renderGoalGherkin(result.record.gherkin) };
    }
    case 'read':
      return { operation, ...readGoalRecordFile(projectRoot, requiredTarget(target, 'goal read')) };
    case 'validate': {
      const path = repositoryRecordPath(projectRoot, requiredTarget(target, 'goal validate'));
      return { operation, path: relative(projectRoot, path), ...readGoalRecordPath(path) };
    }
    case 'status': {
      if (target) return { operation, ...readGoalRecordFile(projectRoot, target) };
      const goals = readGoalRecords(projectRoot);
      return { operation, ...goals };
    }
  }
}

function runIntendedChangeOperation(
  projectRoot: string,
  operation: WorkStateOperation,
  target: string | undefined,
  input: string | undefined,
): unknown {
  switch (operation) {
    case 'create': {
      const request = decodeIntendedChangeCreateRequest(readJsonRequest(requiredInput(input, 'change create')));
      if (!request.ok) throw new Error(request.error);
      return {
        operation,
        ...createIntendedChangeRecordFile(projectRoot, requiredCollaborationDomain(projectRoot), request.request, {
          toolVersion: cliVersion,
        }),
      };
    }
    case 'read':
      return {
        operation,
        ...readIntendedChangeRecordFile(projectRoot, requiredTarget(target, 'change read')),
      };
    case 'validate': {
      const path = repositoryRecordPath(projectRoot, requiredTarget(target, 'change validate'));
      return { operation, path: relative(projectRoot, path), ...readIntendedChangeRecordPath(path) };
    }
    case 'status': {
      if (target) return { operation, ...readIntendedChangeRecordFile(projectRoot, target) };
      const goals = readGoalRecords(projectRoot);
      return {
        operation,
        ...readIntendedChangeRecords(projectRoot, goals),
        goalCompatibility: goals.compatibility,
      };
    }
  }
}

function printWorkStateResult(
  command: 'goal' | 'change',
  args: readonly string[],
  opts: Readonly<Record<string, unknown>>,
  result: unknown,
): void {
  if (opts['json'] === true) {
    printJsonEnvelope(command, args, opts, result);
    return;
  }
  if (!isObject(result)) {
    console.log(sanitizeTerminalLine(String(result)));
    return;
  }
  if (result['operation'] === 'create' && isObject(result['record'])) {
    const identity = command === 'goal' ? String(result['record']['goalId']) : String(result['record']['changeId']);
    console.log(
      `${result['publication'] === 'created' ? 'Created' : 'Reused'} ${command} ${sanitizeTerminalLine(identity)} at ${sanitizeTerminalLine(String(result['path']))}.`,
    );
    if (command === 'goal' && typeof result['gherkin'] === 'string') {
      console.log('');
      console.log(sanitizeTerminalText(result['gherkin']).trimEnd());
    }
    return;
  }
  if (result['operation'] === 'status' && Array.isArray(result['records'])) {
    console.log(`${command === 'goal' ? 'Goals' : 'Intended changes'}: ${result['records'].length} current record(s).`);
    for (const record of result['records']) {
      if (!isObject(record)) continue;
      const identity = command === 'goal' ? record['goalId'] : record['changeId'];
      const label = command === 'goal' ? record['gherkin'] : record['title'];
      console.log(`  ${sanitizeTerminalLine(String(identity))}  ${recordLabel(label)}`);
    }
    const warnings = Array.isArray(result['warnings']) ? result['warnings'] : [];
    for (const warning of warnings) console.log(`warning: ${sanitizeTerminalLine(String(warning))}`);
    const issues = Array.isArray(result['integrityIssues']) ? result['integrityIssues'] : [];
    for (const issue of issues) console.log(`error: ${sanitizeTerminalLine(String(issue))}`);
    return;
  }
  if (result['state'] === 'current' && isObject(result['record'])) {
    const record = result['record'];
    if (command === 'goal' && isObject(record['gherkin'])) {
      console.log(
        `${sanitizeTerminalLine(String(record['goalId']))} (${sanitizeTerminalLine(String(result['path']))})`,
      );
      console.log('');
      console.log(
        sanitizeTerminalText(renderGoalGherkin(record['gherkin'] as unknown as GoalRecordV1['gherkin'])).trimEnd(),
      );
      return;
    }
    console.log(
      `${sanitizeTerminalLine(String(record['changeId']))}  ${sanitizeTerminalLine(String(record['title']))}\nGoal: ${sanitizeTerminalLine(String(record['goalId']))}\nOutcome: ${sanitizeTerminalLine(String(record['intendedOutcome']))}`,
    );
    return;
  }
  console.log(
    `${sanitizeTerminalLine(String(result['state'] ?? 'unknown'))}: ${sanitizeTerminalLine(String(result['error'] ?? result['path'] ?? 'no detail'))}`,
  );
}

function workStateResultFailed(result: unknown): boolean {
  if (!isObject(result)) return true;
  if (typeof result['state'] === 'string' && result['state'] !== 'current') return true;
  if (isObject(result['compatibility']) && result['compatibility']['complete'] === false) return true;
  if (isObject(result['goalCompatibility']) && result['goalCompatibility']['complete'] === false) return true;
  return Array.isArray(result['integrityIssues']) && result['integrityIssues'].length > 0;
}

function workStateOperation(value: unknown, command: string): WorkStateOperation {
  if (typeof value === 'string' && WORK_STATE_OPERATIONS.includes(value as WorkStateOperation)) {
    return value as WorkStateOperation;
  }
  throw new Error(`${command} operation must be one of: ${WORK_STATE_OPERATIONS.join(', ')}`);
}

function optionalTarget(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') throw new Error('record target must be non-empty');
  return value;
}

function requiredTarget(value: string | undefined, operation: string): string {
  if (!value) throw new Error(`${operation} requires a record identity or repository-relative path`);
  return value;
}

function requiredInput(value: string | undefined, operation: string): string {
  if (!value) throw new Error(`${operation} requires --input <path>`);
  return value;
}

function requiredCollaborationDomain(projectRoot: string): string {
  const collaborationDomainId = loadProjectConfig(projectRoot).collaborationDomainId;
  if (!collaborationDomainId) {
    throw new Error('project config has no collaborationDomainId; run scip-query init or scip-query setup');
  }
  return collaborationDomainId;
}

function readJsonRequest(path: string): unknown {
  try {
    return JSON.parse(readSmallArtifactText(resolve(path), 'work-state create request'));
  } catch (error) {
    throw new Error(
      `cannot read work-state create request ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function repositoryRecordPath(projectRoot: string, target: string): string {
  const canonicalProjectRoot = realpathSync(projectRoot);
  const path = realpathSync(resolve(projectRoot, target));
  const relativePath = relative(canonicalProjectRoot, path);
  if (relativePath === '' || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error('record validation path must stay inside the repository');
  }
  return path;
}

function recordLabel(value: unknown): string {
  if (isObject(value) && typeof value['feature'] === 'string') return sanitizeTerminalLine(value['feature']);
  return sanitizeTerminalLine(String(value));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
