import { resolve } from 'node:path';

import { decodePlanContractRecord } from '../../change-control/plan-contract.js';
import { normalizeSafeProjectRelativePath } from '../../domain/path-normalization.js';
import { sanitizeTerminalLine } from '../../platform/terminal-output.js';
import { parseRecordFile } from '../../storage/autonomous-work-state.js';
import { readPlanContractRecordFile, readPlanContractRecords } from '../../storage/plan-contract.js';
import { applyPlanContract } from '../plan-contract-compiler.js';
import { captureFixedRepositoryObservationReceipt } from '../observation-receipt.js';
import { cliVersion } from '../cli-support.js';
import { loadProjectConfig } from '../config.js';
import { resolveProjectRoot } from '../cli-context.js';
import {
  booleanOptionValue,
  commandOptions,
  parseEnumArgument,
  printJsonEnvelope,
} from '../command-kit/command-execution.js';
import { isObject, optionalTarget, requiredCollaborationDomain } from './work-state-handlers.js';

const PLAN_OPERATIONS = ['example', 'apply', 'read', 'validate', 'status'] as const;
type PlanOperation = (typeof PLAN_OPERATIONS)[number];

const PLAN_CONTRACT_STARTER = `# Change plan

State the observable goal and the repository facts that must remain true. Add
retirement, survivor, reuse, or slice entries only when the change needs them.

\`\`\`scip-query-plan
{
  "schemaVersion": 1,
  "form": "compact",
  "goal": {
    "feature": "The requested repository change reaches coherent completion",
    "invariants": ["Unrelated behavior remains true"],
    "scenario": {
      "name": "The requested outcome is complete",
      "given": "The repository has its current behavior",
      "when": "The authorized change is complete",
      "then": "The requested outcome and preservation rules hold"
    }
  },
  "change": {
    "key": "replace-with-stable-task-key",
    "outcome": "Replace with the observable repository outcome"
  },
  "class": "relational",
  "seeds": [
    { "id": "entry", "kind": "symbol", "referent": "replaceMe", "role": "current entry point" }
  ],
  "preserve": [
    { "condition": "Unrelated behavior remains true", "evidence": ["tests"] }
  ],
  "architecture": [
    { "condition": "Configured architecture rules remain clean", "evidence": ["gate"] }
  ],
  "evidence": {
    "tests": { "description": "Run the focused repository checks" },
    "gate": { "description": "Run the final configured gate", "command": "scip-query diff-gate" }
  }
}
\`\`\`

## Optional shared-owner item

Use this shape only when two or more affected symbol seeds must delegate one
responsibility to an existing owner. Copy the object into \`reuseAuthorities\`
and replace every value with repository evidence.

\`\`\`json
{
  "referent": "existingOwner",
  "consumers": ["entry", "second-entry"],
  "responsibility": "the one responsibility that the existing symbol owns",
  "condition": "Both affected entries delegate that responsibility to the existing owner",
  "evidence": ["tests"]
}
\`\`\``;

export function handlePlanContract(operationValue: unknown, targetValue: unknown, rawOpts: unknown): void {
  const operation = parseEnumArgument(operationValue, PLAN_OPERATIONS, 'plan operation') as PlanOperation;
  const target = optionalTarget(targetValue);
  const opts = commandOptions(rawOpts);
  const projectRoot = resolveProjectRoot();
  const result = runPlanContractOperation(projectRoot, operation, target);
  if (booleanOptionValue(opts, 'json')) {
    printJsonEnvelope('plan', [operation, ...(target ? [target] : [])], opts, result);
  } else {
    renderPlanContractResult(result);
  }
  if (planResultFailed(result)) process.exitCode = 1;
}

export function runPlanContractOperation(
  projectRoot: string,
  operation: PlanOperation,
  target: string | undefined,
): unknown {
  switch (operation) {
    case 'example': {
      if (target) throw new Error('plan example does not accept a target');
      return { operation, markdown: PLAN_CONTRACT_STARTER };
    }
    case 'apply': {
      if (!target) throw new Error('plan apply requires a repository-relative Markdown plan path');
      const config = loadProjectConfig(projectRoot);
      const collaborationDomainId = requiredCollaborationDomain(projectRoot);
      const applied = applyPlanContract(projectRoot, target, {
        collaborationDomainId,
        toolVersion: cliVersion,
        captureObservation: () =>
          captureFixedRepositoryObservationReceipt({ projectRoot, config, collaborationDomainId }),
      });
      return {
        operation,
        ...(applied.goal ? { goal: applied.goal } : {}),
        ...(applied.change ? { change: applied.change } : {}),
        plan: applied.plan,
        obligations: applied.obligations,
      };
    }
    case 'read': {
      if (!target) throw new Error('plan read requires a plan identity');
      return { operation, ...readPlanContractRecordFile(projectRoot, target) };
    }
    case 'validate': {
      if (!target) throw new Error('plan validate requires a repository-relative record path');
      const relativePath = normalizeSafeProjectRelativePath(target);
      return {
        operation,
        path: relativePath,
        ...parseRecordFile(resolve(projectRoot, relativePath), 'plan contract', decodePlanContractRecord),
      };
    }
    case 'status': {
      const records = readPlanContractRecords(projectRoot);
      return { operation, ...records };
    }
  }
}

function renderPlanContractResult(result: unknown): void {
  if (!isObject(result)) {
    console.log(sanitizeTerminalLine(String(result)));
    return;
  }
  if (result['operation'] === 'example' && typeof result['markdown'] === 'string') {
    console.log(result['markdown']);
    return;
  }
  if (result['operation'] === 'apply' && isObject(result['plan']) && isObject(result['plan']['record'])) {
    const plan = result['plan'];
    const record = plan['record'] as Record<string, unknown>;
    const obligations = Array.isArray(result['obligations']) ? result['obligations'] : [];
    const goal = isObject(result['goal']) && isObject(result['goal']['record']) ? result['goal']['record'] : undefined;
    const change =
      isObject(result['change']) && isObject(result['change']['record']) ? result['change']['record'] : undefined;
    const materialized =
      goal && change
        ? `Goal ${sanitizeTerminalLine(String(goal['goalId']))} and change ${sanitizeTerminalLine(
            String(change['changeId']),
          )} are ready. `
        : '';
    console.log(
      `${materialized}${plan['publication'] === 'created' ? 'Applied' : 'Reused'} plan ${sanitizeTerminalLine(
        String(record['planId']),
      )} at ${sanitizeTerminalLine(String(plan['path']))}; ${obligations.length} completion obligation(s) ready.`,
    );
    return;
  }
  if (result['operation'] === 'status' && Array.isArray(result['currentRecords'])) {
    console.log(`Plans: ${result['currentRecords'].length} current contract(s).`);
    for (const record of result['currentRecords']) {
      if (!isObject(record)) continue;
      console.log(
        `  ${sanitizeTerminalLine(String(record['planId']))}  ${sanitizeTerminalLine(
          String(record['workflowClass']),
        )}  ${sanitizeTerminalLine(String(record['changeId']))}`,
      );
    }
    for (const warning of arrayStrings(result['warnings'])) console.log(`warning: ${sanitizeTerminalLine(warning)}`);
    for (const issue of arrayStrings(result['integrityIssues'])) console.log(`error: ${sanitizeTerminalLine(issue)}`);
    return;
  }
  if (result['state'] === 'current' && isObject(result['record'])) {
    console.log(
      `${sanitizeTerminalLine(String(result['record']['planId']))}  ${sanitizeTerminalLine(
        String(result['record']['workflowClass']),
      )}\nChange: ${sanitizeTerminalLine(String(result['record']['changeId']))}`,
    );
    return;
  }
  console.log(
    `${sanitizeTerminalLine(String(result['state'] ?? 'unknown'))}: ${sanitizeTerminalLine(
      String(result['error'] ?? result['path'] ?? 'no detail'),
    )}`,
  );
}

function planResultFailed(result: unknown): boolean {
  if (!isObject(result)) return true;
  if (typeof result['state'] === 'string' && result['state'] !== 'current') return true;
  if (isObject(result['compatibility']) && result['compatibility']['complete'] === false) return true;
  return arrayStrings(result['integrityIssues']).length > 0;
}

function arrayStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}
