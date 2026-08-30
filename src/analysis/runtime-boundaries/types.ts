import type { IndexedDefinition } from '../../domain/types.js';
import type {
  StaticValueDerivation,
  StaticValueDerivationKind,
  StaticValuePrecision,
  StaticValueTerm,
  ValueFlowSourceSpan,
} from '../../symbols/graph/value-flow.js';

/** Compatibility projection used by current renderers while evidence axes remain independent. */
export type BoundaryEvidenceStrength = 'exact' | 'derived' | 'candidate';

export type BoundaryDerivationKind = StaticValueDerivationKind;
export type BoundaryValuePrecision = StaticValuePrecision;
export type BoundaryRuntimeModality = 'must' | 'may' | 'unknown';
export type BoundaryResolutionState = 'locally-linked' | 'external' | 'unresolved' | 'ambiguous';
export type BoundarySourceScope = 'production' | 'test' | 'fixture' | 'example' | 'generated' | 'script' | 'unknown';

export type BoundaryTerm = StaticValueTerm;
export type BoundaryDerivation = StaticValueDerivation;
export type BoundarySourceLocation = ValueFlowSourceSpan;

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
  /** Optional on persisted graphs written before standalone analysis frontiers. */
  kind?: 'observation' | 'call-resolution' | 'value-flow';
  /** Standalone fields describe a stopped proof that has no observation yet. */
  action?: string;
  strength?: BoundaryEvidenceStrength;
  source?: BoundarySourceLocation;
  ownerShortName?: string | null;
  address?: string;
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

export interface RuntimeBoundaryBodySummary {
  definition: IndexedDefinition;
  parameterIndexes: number[];
}

export interface RuntimeBoundaryFileCoverage {
  file: string;
  hasAst: boolean;
  /** Token hash that ignores TypeScript and JavaScript trivia such as whitespace and comments. */
  syntaxHash?: string;
  /** Token-kind hash that also ignores literal values while retaining identifiers and control flow. */
  shapeHash?: string;
  /** Static request-body serializers found while this file was already parsed. */
  bodySummaries?: RuntimeBoundaryBodySummary[];
  observationIds: string[];
  extractors: BoundaryExtractorCoverage[];
  extractionErrors: string[];
}

export type RuntimeBoundaryPhaseId =
  | 'direct-extraction'
  | 'http-summary'
  | 'http-mount'
  | 'carrier'
  | 'relations'
  | 'links'
  | 'frontiers';

export interface RuntimeBoundaryPhaseCoverage {
  id: RuntimeBoundaryPhaseId;
  durationMs: number;
  inputFacts: number;
  outputFacts: number;
  filesVisited?: number;
  filesReused?: number;
  factsReused?: number;
  factsInvalidated?: number;
}

export interface RuntimeBoundaryCoverage {
  filesScanned: number;
  filesWithAst: number;
  filesWithoutAst: number;
  filesReused?: number;
  extractors: BoundaryExtractorCoverage[];
  extractionErrors: string[];
  /** Optional so readers remain compatible with graphs written before phase instrumentation. */
  phases?: RuntimeBoundaryPhaseCoverage[];
}

export interface RuntimeBoundaryGraph {
  schemaVersion: 2;
  extractorVersion: string;
  observations: BoundaryObservation[];
  relationGroups: BoundaryRelationGroup[];
  links: BoundaryLink[];
  frontiers: BoundaryFrontier[];
  coverage: RuntimeBoundaryCoverage;
  /** Optional for backward compatibility with runtime-boundaries-v5 graphs. */
  fileCoverage?: RuntimeBoundaryFileCoverage[];
}
