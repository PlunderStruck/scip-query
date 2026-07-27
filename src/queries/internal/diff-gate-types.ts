export type DiffGateActionTier = 'direct' | 'signal' | 'support';

export type DiffGateCheck =
  | 'echo'
  | 'incomplete-migration'
  | 'co-change-partner'
  | 'twin-partner'
  | 'coverage-contract'
  | 'architecture'
  | 'doc-reference'
  | 'unused-params'
  | 'new-dead'
  | 'baseline';

export type DocCitationKind = 'behavioral-claim' | 'configuration-example' | 'guide-reference' | 'intentional-record';

/** A contiguous changed line span within one file, as parsed from a diff. */
export interface ChangedLineRange {
  file: string;
  startLine: number;
  endLine: number;
}
