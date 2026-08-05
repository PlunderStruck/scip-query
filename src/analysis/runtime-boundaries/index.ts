export { collectRuntimeBoundaryGraph, RUNTIME_BOUNDARY_EXTRACTOR_VERSION } from './graph.js';
export {
  readRuntimeBoundaryGraph,
  readRuntimeBoundaryObservations,
  readRuntimeBoundaryRelationGroups,
  writeRuntimeBoundaryGraph,
} from './storage.js';
export { propagateCompilerResolvedWrappers } from './wrapper-propagation.js';
export type {
  BoundaryEvidenceStrength,
  BoundaryDerivation,
  BoundaryDerivationKind,
  BoundaryExtractorCoverage,
  BoundaryFrontier,
  BoundaryKeyPart,
  BoundaryLink,
  BoundaryObservation,
  BoundaryOwner,
  BoundaryRelationGroup,
  BoundaryResolutionState,
  BoundaryRuntimeModality,
  BoundarySourceLocation,
  BoundarySourceScope,
  BoundaryTerm,
  BoundaryValuePrecision,
  RuntimeBoundaryCoverage,
  RuntimeBoundaryPhaseCoverage,
  RuntimeBoundaryPhaseId,
  RuntimeBoundaryFileCoverage,
  RuntimeBoundaryGraph,
} from './types.js';
