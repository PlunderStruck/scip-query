import type { TaskEvidenceContract } from '../domain/task-evidence.js';

export function taskEvidenceContractRows(contract: TaskEvidenceContract): string[] {
  return [
    `  Task: ${contract.task}`,
    '  The agent owns relevance and assessment; scip-query does not mark a category complete from structural resemblance.',
    ...contract.obligations.map(
      (obligation) => `  [${obligation.disposition}] ${obligation.id} — ${obligation.question}`,
    ),
    `  Completion rule: ${contract.completionRule}`,
  ];
}
