/** Agent-facing graph families. Provider-specific detail belongs in edge subtypes. */
export const GRAPH_EVIDENCE_FAMILIES = [
  'execution',
  'runtime',
  'dataflow',
  'state',
  'temporal',
  'contract',
  'identity',
  'ownership',
  'dependencies',
] as const;

export type GraphEvidenceFamily = (typeof GRAPH_EVIDENCE_FAMILIES)[number];

export const GRAPH_PROJECTION_DIRECTIONS = ['incoming', 'outgoing', 'both'] as const;
export type GraphProjectionDirection = (typeof GRAPH_PROJECTION_DIRECTIONS)[number];

export const GRAPH_PROJECTION_OPERATIONS = ['adjacency', 'reachability', 'connecting', 'slice'] as const;
export type GraphProjectionOperation = (typeof GRAPH_PROJECTION_OPERATIONS)[number];

export const GRAPH_COMPRESSION_MODES = ['none', 'linear', 'scc', 'topology'] as const;
export type GraphCompressionMode = (typeof GRAPH_COMPRESSION_MODES)[number];

export const PROGRAM_GRAPH_ROOT_KINDS = [
  'text',
  'file',
  'symbol',
  'construct',
  'runtime-key',
  'state-resource',
] as const;
export type ProgramGraphRootKind = (typeof PROGRAM_GRAPH_ROOT_KINDS)[number];
