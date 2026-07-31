export const PROTECTED_ARTIFACT_CLASSES = [
  'goal',
  'transition-rule',
  'evaluator',
  'test',
  'baseline',
  'suppression',
  'configuration',
] as const;

export type ProtectedArtifactClass = (typeof PROTECTED_ARTIFACT_CLASSES)[number];
export type ProtectedArtifactAuthority = 'bootstrap-trust-root' | 'fixed-predecessor';

export interface ProtectedArtifactRule {
  class: ProtectedArtifactClass;
  selectors: readonly string[];
  authority: ProtectedArtifactAuthority;
}

export interface ProtectedArtifactSetSnapshot {
  setIdentity: string;
  rules: readonly ProtectedArtifactRule[];
}
