export type ChangeActionTier = 'direct' | 'signal' | 'support';

export type DocCitationKind = 'behavioral-claim' | 'configuration-example' | 'guide-reference' | 'intentional-record';

/** A contiguous changed line span within one file, as parsed from a diff. */
export interface ChangedLineRange {
  file: string;
  startLine: number;
  endLine: number;
}
