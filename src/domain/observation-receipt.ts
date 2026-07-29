export const OBSERVATION_RECEIPT_SCHEMA_VERSION = 1 as const;

export type ObservationAuthorityKind = 'index-worktree' | 'index-only' | 'worktree-only' | 'process-local';

/**
 * Identifies the concrete index and checkout state surrounding one result.
 * `alignment: not-certified` is deliberate: ordinary commands disclose their
 * state but do not claim the pre/post lease that Stop establishes.
 */
export interface ObservationReceipt {
  schemaVersion: typeof OBSERVATION_RECEIPT_SCHEMA_VERSION;
  authorityKind: ObservationAuthorityKind;
  observedAt: string;
  projectIdentity: string;
  index?: {
    generationIdentity: string;
    source: 'immutable' | 'legacy';
    alignment: 'not-certified' | 'leased';
  };
  worktree?: {
    identity: string;
    clean: boolean;
    headCommit?: string;
    treeOid?: string;
  };
}

export interface ObservationReceiptComparison {
  compatible: boolean;
  reasons: Array<
    | 'project-mismatch'
    | 'index-authority-missing'
    | 'generation-mismatch'
    | 'worktree-authority-missing'
    | 'worktree-mismatch'
  >;
}

/**
 * Decide whether two results can support one same-state complete-set claim.
 * Both index and worktree authority are required; equal timestamps alone do
 * not make observations compatible.
 */
export function compareObservationReceipts(
  left: ObservationReceipt,
  right: ObservationReceipt,
): ObservationReceiptComparison {
  const reasons: ObservationReceiptComparison['reasons'] = [];
  if (left.projectIdentity !== right.projectIdentity) reasons.push('project-mismatch');
  if (!left.index || !right.index) reasons.push('index-authority-missing');
  else if (left.index.generationIdentity !== right.index.generationIdentity) reasons.push('generation-mismatch');
  if (!left.worktree || !right.worktree) reasons.push('worktree-authority-missing');
  else if (left.worktree.identity !== right.worktree.identity) reasons.push('worktree-mismatch');
  return { compatible: reasons.length === 0, reasons };
}

export function isObservationReceipt(value: unknown): value is ObservationReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const receipt = value as Partial<ObservationReceipt>;
  return (
    receipt.schemaVersion === OBSERVATION_RECEIPT_SCHEMA_VERSION &&
    (receipt.authorityKind === 'index-worktree' ||
      receipt.authorityKind === 'index-only' ||
      receipt.authorityKind === 'worktree-only' ||
      receipt.authorityKind === 'process-local') &&
    typeof receipt.observedAt === 'string' &&
    !Number.isNaN(Date.parse(receipt.observedAt)) &&
    isIdentity(receipt.projectIdentity) &&
    (receipt.index === undefined ||
      (isIdentity(receipt.index.generationIdentity) &&
        (receipt.index.source === 'immutable' || receipt.index.source === 'legacy') &&
        (receipt.index.alignment === 'not-certified' || receipt.index.alignment === 'leased'))) &&
    (receipt.worktree === undefined ||
      (isIdentity(receipt.worktree.identity) &&
        typeof receipt.worktree.clean === 'boolean' &&
        (receipt.worktree.headCommit === undefined || isIdentity(receipt.worktree.headCommit)) &&
        (receipt.worktree.treeOid === undefined || isIdentity(receipt.worktree.treeOid)))) &&
    authorityFieldsAgree(receipt)
  );
}

function authorityFieldsAgree(receipt: Partial<ObservationReceipt>): boolean {
  if (receipt.authorityKind === 'index-worktree') return receipt.index !== undefined && receipt.worktree !== undefined;
  if (receipt.authorityKind === 'index-only') return receipt.index !== undefined && receipt.worktree === undefined;
  if (receipt.authorityKind === 'worktree-only') return receipt.index === undefined && receipt.worktree !== undefined;
  return receipt.authorityKind === 'process-local' && receipt.index === undefined && receipt.worktree === undefined;
}

function isIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\0\r\n]/u.test(value);
}
