// ── Dead Code Query Options ────────────────────────────────

export interface DeadOptions {
  scope?: string;
  minLoc?: number;
  includeTests?: boolean;
  skipBarrels?: boolean;
  includeMembers?: boolean;
  deadCodeOnly?: boolean;
  scanLimit?: number;
  semantic?: boolean;
}
