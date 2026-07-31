import { resolve } from 'node:path';

import { sanitizeTerminalLine } from '../../platform/terminal-output.js';
import {
  readProtectedGoalEvidence,
  readProtectedGoalEvidenceCollection,
} from '../../storage/protected-goal-evidence.js';
import { evaluateAndWriteProtectedGoalEvidence } from '../protected-goal-evidence-controller.js';
import {
  booleanOptionValue,
  commandOptions,
  parseEnumArgument,
  printJsonEnvelope,
  stringOptionValue,
} from '../command-kit/command-execution.js';
import { resolveProjectRoot } from '../cli-context.js';
import { cliVersion } from '../cli-support.js';
import { optionalTarget, requiredString } from './work-state-handlers.js';

const PROTECTED_GOAL_EVIDENCE_OPERATIONS = ['evaluate', 'read', 'status'] as const;
type ProtectedGoalEvidenceOperation = (typeof PROTECTED_GOAL_EVIDENCE_OPERATIONS)[number];

export function handleProtectedGoalEvidence(operationValue: unknown, targetValue: unknown, rawOpts: unknown): void {
  const operation = parseEnumArgument(
    operationValue,
    PROTECTED_GOAL_EVIDENCE_OPERATIONS,
    'protected-evidence operation',
  );
  const target = optionalTarget(targetValue);
  const opts = commandOptions(rawOpts);
  const candidateRoot = resolve(stringOptionValue(opts, 'candidateRoot') ?? resolveProjectRoot());
  const protectedRoot = requiredString(
    stringOptionValue(opts, 'protectedRoot'),
    'protected-evidence requires --protected-root outside the candidate worktree',
  );
  try {
    const result = runProtectedGoalEvidenceOperation(operation, target, protectedRoot, candidateRoot, opts);
    if (booleanOptionValue(opts, 'json')) {
      printJsonEnvelope('protected-evidence', [operation, ...(target ? [target] : [])], opts, result);
      return;
    }
    renderProtectedGoalEvidenceResult(operation, result);
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

function runProtectedGoalEvidenceOperation(
  operation: ProtectedGoalEvidenceOperation,
  target: string | undefined,
  protectedRoot: string,
  candidateRoot: string,
  opts: Readonly<Record<string, unknown>>,
): unknown {
  if (operation === 'evaluate') {
    const authorizationId = requiredString(target, 'protected-evidence evaluate requires an authorization ID');
    const evaluatorPath = requiredString(
      stringOptionValue(opts, 'evaluator'),
      'protected-evidence evaluate requires --evaluator <absolute-path>',
    );
    const {
      evaluatorStdout: _stdout,
      evaluatorStderr: _stderr,
      ...publication
    } = evaluateAndWriteProtectedGoalEvidence({
      projectRoot: candidateRoot,
      protectedRoot,
      authorizationId,
      evaluatorPath,
      toolVersion: cliVersion,
    });
    return { operation, ...publication };
  }
  if (operation === 'status') {
    return { operation, ...readProtectedGoalEvidenceCollection(protectedRoot, candidateRoot) };
  }
  const evidenceId = requiredString(target, 'protected-evidence read requires an evidence ID');
  return { operation, ...readProtectedGoalEvidence(protectedRoot, candidateRoot, evidenceId) };
}

function renderProtectedGoalEvidenceResult(operation: ProtectedGoalEvidenceOperation, result: unknown): void {
  const value = result as {
    path?: string;
    publication?: string;
    state?: string;
    record?: { evidenceId: string; judgments: Record<string, string> };
    records?: Array<{ evidenceId: string; judgments: Record<string, string> }>;
    issues?: readonly unknown[];
  };
  if (operation === 'evaluate') {
    console.log(
      sanitizeTerminalLine(
        `Protected goal evidence ${value.publication ?? 'unknown'} at ${value.path ?? 'unknown path'}: ${value.record?.evidenceId ?? 'unknown evidence'}.`,
      ),
    );
    return;
  }
  if (operation === 'read') {
    console.log(`Evidence: ${sanitizeTerminalLine(value.record?.evidenceId ?? value.state ?? 'unknown')}`);
    if (value.record) console.log(`Judgments: ${JSON.stringify(value.record.judgments)}`);
    return;
  }
  console.log(`Protected goal evidence receipts: ${value.records?.length ?? 0}`);
  for (const record of value.records ?? []) console.log(`  ${record.evidenceId}  ${JSON.stringify(record.judgments)}`);
  console.log(`Record issues: ${value.issues?.length ?? 0}`);
}
