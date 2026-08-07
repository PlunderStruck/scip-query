export const TASK_EVIDENCE_CONTRACT_SCHEMA_VERSION = 1;

export type TaskEvidenceObligationId =
  | 'scope'
  | 'entry'
  | 'guards'
  | 'transformations'
  | 'effects'
  | 'boundaries'
  | 'outputs'
  | 'failures'
  | 'recovery'
  | 'variants';

export type TaskEvidenceDisposition = 'unassessed' | 'established' | 'contradicted' | 'not-applicable' | 'unsupported';

export interface TaskEvidenceObligation {
  id: TaskEvidenceObligationId;
  disposition: TaskEvidenceDisposition;
  question: string;
}

/**
 * A task evidence contract is the agent-owned checklist of fact categories
 * whose relevance and support must be decided before answering a repository
 * question. The CLI transports the contract but never upgrades an obligation
 * from unassessed merely because structurally similar evidence was present.
 */
export interface TaskEvidenceContract {
  schemaVersion: typeof TASK_EVIDENCE_CONTRACT_SCHEMA_VERSION;
  task: string;
  assessmentAuthority: 'agent';
  obligations: readonly TaskEvidenceObligation[];
  completionRule: string;
}

const UNIVERSAL_EXPLORATION_OBLIGATIONS: ReadonlyArray<Omit<TaskEvidenceObligation, 'disposition'>> = [
  { id: 'scope', question: 'Which exact implementation, operating mode, and repository path are in scope?' },
  { id: 'entry', question: 'What starts the selected behavior, and what inputs enter?' },
  { id: 'guards', question: 'Which predicates, authorization checks, and sibling branches change the outcome?' },
  { id: 'transformations', question: 'How is data reshaped, and in what order?' },
  { id: 'effects', question: 'Which externally visible or durable state changes occur, and in what order?' },
  {
    id: 'boundaries',
    question: 'Which process, protocol, queue, database, registry, or callback boundary is crossed?',
  },
  { id: 'outputs', question: 'Which values, events, notifications, logs, or records leave the selected behavior?' },
  { id: 'failures', question: 'What happens when a material operation fails or execution is interrupted?' },
  { id: 'recovery', question: 'Is partial work prevented, rolled back, repaired later, compacted, or cleaned up?' },
  { id: 'variants', question: 'Which relevant implementations or modes behave differently?' },
];

export function createTaskEvidenceContract(task: string): TaskEvidenceContract {
  const normalizedTask = task.trim();
  if (normalizedTask.length === 0)
    throw new Error('A task evidence contract requires the original repository question.');
  return {
    schemaVersion: TASK_EVIDENCE_CONTRACT_SCHEMA_VERSION,
    task: normalizedTask,
    assessmentAuthority: 'agent',
    obligations: UNIVERSAL_EXPLORATION_OBLIGATIONS.map((obligation) => ({
      ...obligation,
      disposition: 'unassessed',
    })),
    completionRule:
      'Before answering, classify every obligation as established, contradicted, not-applicable, or unsupported; graph presence alone never establishes task relevance.',
  };
}
