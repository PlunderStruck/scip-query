/** Compatibility projection used by current renderers while evidence axes remain independent. */
export type BoundaryEvidenceStrength = 'exact' | 'derived' | 'candidate';

export type BoundaryDerivationKind = 'direct' | 'mechanically-derived' | 'heuristic';
export type BoundaryValuePrecision = 'literal' | 'finite-set' | 'constrained-pattern' | 'symbolic' | 'unknown';
export type BoundaryRuntimeModality = 'must' | 'may' | 'unknown';
export type BoundaryResolutionState = 'locally-linked' | 'external' | 'unresolved' | 'ambiguous';
export type BoundarySourceScope = 'production' | 'test' | 'fixture' | 'example' | 'generated' | 'script' | 'unknown';

export type BoundaryTerm =
  | { kind: 'literal'; value: string }
  | { kind: 'finite-set'; values: string[] }
  | { kind: 'parameter'; callable: string; position: number; name: string | null }
  | { kind: 'concat'; parts: BoundaryTerm[] }
  | { kind: 'property'; base: BoundaryTerm; key: string }
  | { kind: 'pattern'; language: string; value: string }
  | { kind: 'symbol'; symbol: string }
  | { kind: 'unknown'; reason: string };

export interface BoundaryDerivation {
  kind: BoundaryDerivationKind;
  rule: string;
  ruleVersion: string;
  inputFactIds: string[];
  sourceSpans: BoundarySourceLocation[];
}

export interface BoundarySourceLocation {
  file: string;
  startLine: number;
  endLine: number;
}

export interface BoundaryOwner {
  file: string;
  symbol: string | null;
  name: string | null;
  startLine: number;
  endLine: number;
}

export interface BoundaryKeyPart {
  name: string;
  value: string;
  evidence: 'literal' | 'constant' | 'identifier' | 'expression';
  term?: BoundaryTerm;
  derivation?: BoundaryDerivation;
}

/** A source-grounded runtime operation observed independently of any matching peer. */
export interface BoundaryObservation {
  id: string;
  extractor: string;
  action: string;
  owner: BoundaryOwner;
  source: BoundarySourceLocation;
  keyParts: BoundaryKeyPart[];
  evidence: string;
  strength: BoundaryEvidenceStrength;
  protocol: string;
  role: string;
  executionDomain: string | null;
  derivation: BoundaryDerivation;
  valuePrecision: BoundaryValuePrecision;
  modality: BoundaryRuntimeModality;
  resolution: BoundaryResolutionState;
  sourceScope: BoundarySourceScope;
}

/** A relationship derived from two observations by one named, inspectable rule. */
export interface BoundaryLink {
  id: string;
  from: string;
  to: string;
  joinRule: string;
  matchedKeyParts: BoundaryKeyPart[];
  strength: BoundaryEvidenceStrength;
  derivation: BoundaryDerivation;
}

export interface BoundaryFrontier {
  observationId: string;
  reason: string;
  missingKeyParts: string[];
  sourceScope: BoundarySourceScope;
}

/** A factorized rendezvous: participants attach once instead of forming a pairwise product. */
export interface BoundaryRelationGroup {
  id: string;
  protocol: string;
  joinRule: string;
  normalizedKey: string;
  keyParts: BoundaryKeyPart[];
  producerIds: string[];
  consumerIds: string[];
  declarationIds: string[];
  derivation: BoundaryDerivation;
}

export interface BoundaryExtractorCoverage {
  id: string;
  applicableFiles: number;
  observations: number;
  errors: number;
}

export interface RuntimeBoundaryCoverage {
  filesScanned: number;
  filesWithAst: number;
  filesWithoutAst: number;
  extractors: BoundaryExtractorCoverage[];
  extractionErrors: string[];
}

export interface RuntimeBoundaryGraph {
  schemaVersion: 2;
  extractorVersion: string;
  observations: BoundaryObservation[];
  relationGroups: BoundaryRelationGroup[];
  links: BoundaryLink[];
  frontiers: BoundaryFrontier[];
  coverage: RuntimeBoundaryCoverage;
}
