import type * as TypeScript from 'typescript';
import type { IndexedDefinition } from '../../domain/types.js';
import type { ScipDatabase } from '../../storage/db.js';
import {
  isTypeScriptLike,
  loadTypeScriptModule,
  semanticLocalFlowForRange,
  typeScriptSourceFileForPath,
  type TypeScriptLocalFlowPoint,
  type TypeScriptLocalFlowResult,
} from '../../semantic/local-flow.js';
import { getDefinitionsForFile } from '../../symbols/definition-catalog.js';
import { resolveSymbol } from '../../symbols/symbol-lookup.js';
import { shortenSymbol } from '../../symbols/symbol-parser.js';
import { ProjectIndex } from '../internal/project-index.js';
import {
  runCandidateAnalysis,
  type CandidatePipelineCounters,
  type CandidateScanProgress,
} from '../internal/candidate-scan.js';
import { definitionLoc } from '../../symbols/definition-loc.js';

type TypeScriptModule = typeof TypeScript;

/** What a function hands to the outside world: a value, a field of a returned object, an effect, a write, or an exit. */
export type SliceCohesionOutputKind = 'return' | 'return-property' | 'effect-call' | 'mutation' | 'throw';
/**
 * One control-flow unit of the body. `jump` and `declaration` units are
 * placed but not counted: they carry no analyzable data flow.
 */
export type SliceCohesionUnitKind = 'statement' | 'predicate' | 'return' | 'throw' | 'jump' | 'declaration';
/** `signal` when the split is backed by a complete local model and a narrow extraction; `support` when a reviewer must confirm it. */
export type SliceCohesionActionTier = 'signal' | 'support';
/**
 * What kind of body was sliced. A React component or hook is bound by hook
 * rules, and an orchestration root sequences independent operations by
 * design, so each is read differently from a plain calculation.
 */
export type SliceCohesionArchetype = 'calculation' | 'react-component' | 'react-hook' | 'orchestration';
/**
 * What an extracted cluster would be: a pure calculation, an operation that
 * computes a result while awaiting or affecting the outside, a custom hook,
 * or a sequence of effects.
 */
export type SliceCohesionClusterKind = 'calculation' | 'operation' | 'hook' | 'effects';
/** The largest qualifying cluster stays in place; the others are the extractions; the rest are below threshold. */
export type SliceCohesionClusterRole = 'remainder' | 'extraction' | 'below-threshold';

export interface SliceCohesionUnit {
  index: number;
  kind: SliceCohesionUnitKind;
  startLine: number;
  endLine: number;
  label: string;
}

export interface SliceCohesionOutput {
  id: string;
  kind: SliceCohesionOutputKind;
  label: string;
  /** Zero-based line of the first unit producing the output. */
  line: number;
  /** Counted units that produce this output; a function's return value merges every non-guard return statement. */
  units: number[];
  /** True when the output carries no computed value: an exit whose slice is only itself. */
  guard: boolean;
  /** True for a React hook call such as `useEffect`: a lifecycle effect rather than a plain call. */
  hook: boolean;
  /** Size of the computation slice: counted units reached backward through data edges and non-guard control edges. */
  sliceSize: number;
  /** Size of the full slice: counted units reached through data edges and every control edge, guards included. */
  fullSliceSize: number;
  /** The computation slice itself; present when the candidate was requested in detail. */
  slice?: number[];
  /** The full slice itself; present when the candidate was requested in detail. */
  fullSlice?: number[];
}

export interface SliceCohesionLineRange {
  startLine: number;
  endLine: number;
}

export interface SliceCohesionCluster {
  outputs: string[];
  /** Counted units exclusive to this cluster after shared setup is removed. */
  units: number[];
  /** Zero-based line ranges covering the cluster's units. */
  lineRanges: SliceCohesionLineRange[];
  /**
   * The parameters an extraction would take: function parameters, `this`,
   * shared-setup bindings, and locals of an enclosing function the cluster
   * reads. Imports, module-level names, globals, and JSX tags stay imports.
   */
  inputs: string[];
  kind: SliceCohesionClusterKind;
  role: SliceCohesionClusterRole;
  /** Whether `inputs` is within the signal bound; the remainder never needs an interface. */
  narrow: boolean;
  /** Hook calls the cluster contains, for hook-candidate wording. */
  hooks: string[];
  /** True when every output in the cluster is a throw: validation, not a computation. */
  guardOnly: boolean;
}

export interface SliceCohesionMetrics {
  /** Share of counted statements in every value output's computation slice (Ott and Thuss tightness). */
  tightness: number;
  /** Tightness over full slices, guards included. */
  fullTightness: number;
  /** Mean computation-slice size as a share of counted statements (Ott and Thuss coverage). */
  sliceShare: number;
  fullSliceShare: number;
  /** Mean share of each computation slice that lies in the intersection of all of them (overlap). */
  overlap: number;
  /** Statements in every full slice. */
  superglue: number;
  /** Statements in two or more full slices. */
  glue: number;
}

export interface SliceCohesionCoverage {
  /** `partial` only when a gap can drop dependencies; conservative approximations keep `complete`. */
  status: 'complete' | 'partial';
  /**
   * What `complete` covers: the function-local flow model. Runtime order,
   * callee behavior, and framework scheduling are outside it.
   */
  model: 'function-local-flow';
  basis: 'typescript-local-flow-backward-slices';
  unsupported: string[];
  /** Flow edges used whose strength is candidate rather than exact. */
  candidateEdges: number;
  /** Candidate edges are treated as dependencies, so they can merge clusters but never separate them. */
  candidateEdgeEffect: 'merge-only';
}

export interface SliceCohesionCandidate {
  symbol: string;
  shortName: string;
  relativePath: string;
  startLine: number;
  endLine: number;
  loc: number;
  archetype: SliceCohesionArchetype;
  /** True under a scripts, tools, bin, or migrations directory: operational code that legitimately sequences steps. */
  operational: boolean;
  /** Every body unit; present when the candidate was requested in detail. */
  units?: SliceCohesionUnit[];
  /** Units that carry data flow: statements, predicates, returns, and throws. */
  statementCount: number;
  outputs: SliceCohesionOutput[];
  metrics: SliceCohesionMetrics;
  /** Independent computations, largest first. */
  clusters: SliceCohesionCluster[];
  /** Value outputs that depend on shared setup only; they belong to whichever function keeps the setup. */
  preambleOnlyOutputs: string[];
  /** Counted units derived only from inputs and read by several outputs. */
  preamble: number[];
  /** Counted units no output depends on. */
  orphans: number[];
  /** Statements in the extraction clusters: what could leave the function while the largest computation stays. */
  separableStatements: number;
  splitCandidate: boolean;
  actionTier: SliceCohesionActionTier;
  tierReason: string;
  evidenceReasons: string[];
  recommendation: string;
  coverage: SliceCohesionCoverage;
}

/** A body needs this many counted units before its partition means anything. */
const DEFAULT_MIN_STATEMENTS = 10;
/** A cluster reported as extractable carries at least this many counted units. */
const DEFAULT_MIN_CLUSTER_UNITS = 4;
/** A cluster reported as extractable spans at least this many source lines. */
const MIN_CLUSTER_LINES = 3;
/** A signal-tier extraction takes at most this many parameters. */
const MAX_SIGNAL_CLUSTER_INPUTS = 5;
/** A shared unit with its own dependencies is setup only when it feeds at least this share of the value outputs. */
const PREAMBLE_OUTPUT_SHARE = 0.5;
/** Unit labels are collapsed to one line of at most this many characters. */
const LABEL_LENGTH = 80;
/** A body whose value outputs are all calls, this many or more, sequences operations rather than computing a result. */
const MIN_ORCHESTRATION_OUTPUTS = 3;

const COUNTED_KINDS: ReadonlySet<SliceCohesionUnitKind> = new Set(['statement', 'predicate', 'return', 'throw']);
const HOOK_NAME = /^use[A-Z0-9_]/u;
const EFFECT_HOOK_NAME = /^use(?:[A-Z0-9_]\w*)?Effect$/u;
const OPERATIONAL_PATH = /(?:^|\/)(?:scripts?|bin|tools?|tooling|migrations?|integration-tests?|e2e)\//u;

interface Unit extends SliceCohesionUnit {
  node: TypeScript.Node;
  start: number;
  end: number;
}

interface OutputSeed {
  id: string;
  kind: SliceCohesionOutputKind;
  label: string;
  line: number;
  unit: number;
  /** Seeds sharing a group are one output: every return statement produces the function's one return value. */
  group: string;
  hook: boolean;
  /** Seed points for a property output; whole-unit outputs seed from their unit. */
  seedPoints: TypeScriptLocalFlowPoint[] | null;
}

interface BaseAccess {
  unit: number;
  base: string;
}

/** What a local closure touches outside its own scope, transitively through the closures it calls. */
interface ClosureSummary {
  reads: Set<string>;
  writes: Set<string>;
  /** Tuple state the closure writes through a setter: `setItems(...)` writes `items`. */
  stateWrites: Set<string>;
  calls: Set<string>;
}

interface SourceRange {
  start: number;
  end: number;
}

interface BodyModel {
  ts: TypeScriptModule;
  sourceFile: TypeScript.SourceFile;
  callable: TypeScript.FunctionLikeDeclaration;
  units: Unit[];
  paramNames: Set<string>;
  localNames: Set<string>;
  /** Predicates whose only consequence is leaving the function: `if (!x) return;`. */
  guardPredicates: Set<number>;
  /** Units inside an exit-only branch: the exit itself and the calls that report it. */
  guardUnits: Set<number>;
  /**
   * Predicates that syntactically enclose each unit (if, loop, and switch
   * conditions). The compiler's control dependence drops a branch statement
   * that a may-raise edge can skip, so structure supplies the dependence.
   */
  enclosingPredicates: number[][];
  /** Counted units that await outside their nested functions. */
  awaitUnits: Set<number>;
  /** `start:end` of every callee expression, so reads of a called name are not reported as inputs. */
  calleeSpans: Set<string>;
  closures: Map<string, ClosureSummary>;
  /** Locals declared as fresh aggregates: `[]`, `{}`, `new Map()`. Passing one to a call may write it. */
  containers: Set<string>;
  /** Local name to the bases it aliases: `bucket = map.get(k)` and `map.set(k, bucket)` both alias `bucket` to `map`. */
  aliases: Map<string, Set<string>>;
  /** Offsets of every enclosing function-like ancestor; locals declared there are closure inputs. */
  enclosingRanges: SourceRange[];
  /** Units inside a catch or finally block, mapped to the counted units of the try block they handle. */
  handlerDeps: Map<number, number[]>;
  /** Tuple state setter to the state it writes: `const [items, setItems] = useState()`. */
  stateSetters: Map<string, string>;
  /** Hook calls at each unit's top level, by leaf callee name. */
  hookCalls: Map<number, string[]>;
  /** True when the body calls hooks in a JSX-capable file or is itself named like a hook. */
  react: boolean;
}

/** Per-unit container writes after alias resolution, split by who owns the written base. */
interface UnitWrites {
  local: Set<string>;
  external: Set<string>;
}

/** Methods that read a container without changing it; calling one is not a write to the receiver. */
const READ_ONLY_METHODS: ReadonlySet<string> = new Set([
  'get',
  'has',
  'at',
  'find',
  'findLast',
  'findIndex',
  'findLastIndex',
  'includes',
  'indexOf',
  'lastIndexOf',
  'keys',
  'values',
  'entries',
  'forEach',
  'map',
  'filter',
  'flatMap',
  'reduce',
  'reduceRight',
  'some',
  'every',
  'slice',
  'concat',
  'join',
  'toString',
  'toJSON',
  'toSorted',
  'toReversed',
  'toSpliced',
  'with',
  'startsWith',
  'endsWith',
  'match',
  'matchAll',
  'test',
  'exec',
  'search',
  'localeCompare',
  'trim',
  'trimStart',
  'trimEnd',
  'split',
  'replace',
  'replaceAll',
  'toLowerCase',
  'toUpperCase',
  'padStart',
  'padEnd',
  'charAt',
  'charCodeAt',
  'codePointAt',
  'substring',
  'repeat',
  'normalize',
  'isArray',
  'from',
  'of',
  'assign',
  'freeze',
  'hasOwn',
  'getOwnPropertyNames',
  'stringify',
  'parse',
  'toFixed',
  'toISOString',
  'getTime',
  'valueOf',
  'then',
  'catch',
  'finally',
  'size',
  'length',
]);

/** Methods and properties that read from a container without exposing part of it. */
const NON_ALIASING_MEMBERS: ReadonlySet<string> = new Set([
  'map',
  'filter',
  'flatMap',
  'slice',
  'concat',
  'keys',
  'values',
  'entries',
  'from',
  'of',
  'toSorted',
  'toReversed',
  'toSpliced',
  'with',
  'join',
  'reduce',
  'reduceRight',
  'some',
  'every',
  'includes',
  'has',
  'indexOf',
  'lastIndexOf',
  'findIndex',
  'size',
  'length',
  'toString',
  'toJSON',
  'then',
  'catch',
  'finally',
  'trim',
  'split',
  'replace',
  'replaceAll',
  'toLowerCase',
  'toUpperCase',
  'startsWith',
  'endsWith',
  'match',
  'test',
  'exec',
  'localeCompare',
  'padStart',
  'padEnd',
  'charAt',
  'charCodeAt',
  'codePointAt',
  'substring',
  'repeat',
  'normalize',
]);

interface FlowModel {
  pointById: Map<string, TypeScriptLocalFlowPoint>;
  unitOfPoint: Map<string, number>;
  /** Definition points inside the body, keyed by `unit\0name`. */
  definitionsByUnitName: Map<string, TypeScriptLocalFlowPoint>;
  /** Units each unit depends on through data edges, including local container writes. */
  dataDeps: Set<number>[];
  controlDeps: Set<number>[];
  /** Units each use point depends on through data edges. */
  pointDeps: Map<string, Set<number>>;
  paramReads: Set<string>[];
  outerReads: Set<string>[];
  definedNames: Set<string>[];
  candidateEdges: number;
  writesByUnit: Map<number, UnitWrites>;
  /** Units whose render-time or effect-time state writes were recorded, with the state names. */
  stateWritesByUnit: Map<number, string[]>;
}

interface SourceFileCache {
  files: Map<string, TypeScript.SourceFile | null>;
}

interface Thresholds {
  minStatements: number;
  minClusterUnits: number;
}

/**
 * Measure functional cohesion from backward slices.
 *
 * For each thing a function hands to the outside world (its return value,
 * each property of a returned object, an effect call, a write to state it
 * does not own, a throw) the analysis takes the backward slice over the
 * local definition-use and control-dependence graph. Outputs whose slices
 * share statements belong to one computation; outputs whose slices are
 * disjoint are separate local computations that happen to live in one
 * body. Statements derived only from the inputs and read by several
 * outputs are shared setup, not glue. The partition is the finding: the
 * largest computation stays in place and every other qualifying cluster is
 * an extraction with its parameters already named.
 */
// scip-query: ignore-extract — this is the public cohesion detector
// pipeline: callable selection, per-symbol slicing, and result ordering are
// one command contract.
export function sliceCohesion(
  db: ScipDatabase,
  opts: {
    scope?: string;
    symbol?: string;
    minLoc?: number;
    minStatements?: number;
    minClusterUnits?: number;
    limit?: number;
    scanLimit?: number;
    /** Include every unit and slice in each candidate; defaults to true for a targeted symbol. */
    detail?: boolean;
    onProgress?: (progress: CandidateScanProgress) => void;
    /** Receives the scan counters, so a caller can report how much of the repository the result covers. */
    onProfile?: (counters: CandidatePipelineCounters) => void;
  } = {},
): SliceCohesionCandidate[] {
  const { scope, symbol, minLoc = 12, minStatements, minClusterUnits, limit = 20, scanLimit, onProgress } = opts;
  const cache: SourceFileCache = { files: new Map() };
  const thresholds = { minStatements, minClusterUnits, detail: opts.detail ?? symbol !== undefined };
  if (symbol) {
    const definition = resolveCallableDefinition(db, symbol);
    if (!definition) return [];
    const candidate = sliceCohesionForDefinition(db, definition, thresholds, cache);
    return candidate ? [candidate] : [];
  }
  const index = new ProjectIndex(db);
  return runCandidateAnalysis<IndexedDefinition, undefined, SliceCohesionCandidate>({
    candidates: () =>
      index.productionCallableDefinitions({
        scope,
        minLoc,
        excludeTypesFiles: true,
        requireFunctionLikeSymbol: true,
        sortByLocDesc: true,
      }),
    scanLimit,
    // Selection is by size; evaluation groups a file's callables together so
    // each file's flow graph and parse are computed once.
    orderScanned: (left, right) =>
      left.relativePath.localeCompare(right.relativePath) || left.startLine - right.startLine,
    filterCandidate: (definition) => isTypeScriptLike(definition.relativePath),
    profile: { name: 'slice-cohesion' },
    onProgress,
    onProfile: opts.onProfile,
    evaluate: (definition) => {
      const candidate = sliceCohesionForDefinition(db, definition, thresholds, cache);
      return candidate?.splitCandidate ? candidate : null;
    },
    orderResults: compareCandidates,
    limit,
  });
}

/** Signal first, product code before operational scripts, calculations before framework-bound bodies, then by what an extraction would move. */
function compareCandidates(left: SliceCohesionCandidate, right: SliceCohesionCandidate): number {
  return (
    tierRank(left.actionTier) - tierRank(right.actionTier) ||
    Number(left.operational) - Number(right.operational) ||
    archetypeRank(left.archetype) - archetypeRank(right.archetype) ||
    extractionKindRank(left) - extractionKindRank(right) ||
    narrowExtractionStatements(right) - narrowExtractionStatements(left) ||
    right.separableStatements - left.separableStatements ||
    right.loc - left.loc
  );
}

function tierRank(tier: SliceCohesionActionTier): number {
  return tier === 'signal' ? 0 : 1;
}

function archetypeRank(archetype: SliceCohesionArchetype): number {
  switch (archetype) {
    case 'calculation':
      return 0;
    case 'react-hook':
      return 1;
    case 'react-component':
      return 2;
    case 'orchestration':
      return 3;
  }
}

/** Calculations first, then operations and hooks, then bodies whose only extractions are effect sequences. */
function extractionKindRank(candidate: SliceCohesionCandidate): number {
  const kinds = new Set(
    candidate.clusters.filter((cluster) => cluster.role === 'extraction').map((cluster) => cluster.kind),
  );
  if (kinds.has('calculation')) return 0;
  if (kinds.has('operation') || kinds.has('hook')) return 1;
  return 2;
}

function narrowExtractionStatements(candidate: SliceCohesionCandidate): number {
  return candidate.clusters
    .filter((cluster) => cluster.role === 'extraction' && cluster.narrow)
    .reduce((sum, cluster) => sum + cluster.units.length, 0);
}

function resolveCallableDefinition(db: ScipDatabase, symbol: string): IndexedDefinition | null {
  const resolution = resolveSymbol(db, symbol);
  if (resolution.candidates.length > 0)
    throw new Error(`Ambiguous symbol: ${symbol}. Use an exact SCIP symbol or file:line.`);
  const match = resolution.match;
  if (!match) return null;
  const definitions = getDefinitionsForFile(db, match.relativePath);
  return (
    definitions.find((definition) => definition.symbolId === match.symbolId) ??
    definitions.find((definition) => definition.symbol === match.symbol) ??
    null
  );
}

/**
 * Slice one callable. Null when the file is not TypeScript-like, the
 * compiler is unavailable, no function-like body sits inside the
 * definition range, or the flow analysis reports no support at all.
 */
export function sliceCohesionForDefinition(
  db: ScipDatabase,
  definition: IndexedDefinition,
  opts: { minStatements?: number; minClusterUnits?: number; detail?: boolean } = {},
  cache: SourceFileCache = { files: new Map() },
): SliceCohesionCandidate | null {
  const thresholds: Thresholds = {
    minStatements: opts.minStatements ?? DEFAULT_MIN_STATEMENTS,
    minClusterUnits: opts.minClusterUnits ?? DEFAULT_MIN_CLUSTER_UNITS,
  };
  const detail = opts.detail ?? true;
  if (!isTypeScriptLike(definition.relativePath)) return null;
  const ts = loadTypeScriptModule();
  if (!ts) return null;
  const sourceFile = parsedSourceFile(db, definition.relativePath, cache);
  if (!sourceFile) return null;
  const callable = callableForDefinition(ts, sourceFile, definition);
  if (!callable) return null;
  // Coverage belongs to the selected callable and its nested functions. A gap
  // in a sibling must not downgrade this function's extraction evidence.
  const flow = semanticLocalFlowForRange(db, definition.relativePath, definition.startLine, definition.endLine);
  if (!flow || flow.coverage.status === 'unsupported') return null;

  const body = modelBody(ts, sourceFile, callable, definition.relativePath);
  const flowModel = projectFlow(body, flow, definition.relativePath);
  const seeds = collectOutputs(body, flowModel);
  const counted = body.units.filter((unit) => COUNTED_KINDS.has(unit.kind)).map((unit) => unit.index);
  const countedSet = new Set(counted);

  const sliced = sliceOutputs(body, flowModel, seeds, countedSet);

  const valueOutputs = sliced.filter((output) => !output.guard);
  const metrics = cohesionMetrics(valueOutputs, counted.length);
  const outputUnits = new Set(sliced.flatMap((output) => output.units));
  const { clusters, preamble } = partitionOutputComputations(valueOutputs, outputUnits, body, flowModel, thresholds);
  const clustered = new Set(clusters.flatMap((cluster) => cluster.outputs));
  const preambleOnlyOutputs = valueOutputs.filter((output) => !clustered.has(output.id)).map((output) => output.id);
  const reached = new Set(sliced.flatMap((output) => output.fullSlice ?? []));
  const orphans = counted.filter(
    (unit) => !reached.has(unit) && !outputUnits.has(unit) && body.units[unit]!.kind === 'statement',
  );
  const extractions = clusters.filter((cluster) => cluster.role === 'extraction');
  const separableStatements = extractions.reduce((sum, cluster) => sum + cluster.units.length, 0);
  const splitCandidate = counted.length >= thresholds.minStatements && extractions.length >= 1;
  const unsupported = [...flow.coverage.unsupported];
  const coverage: SliceCohesionCoverage = {
    status: flow.coverage.status === 'complete' && flowModel.candidateEdges === 0 ? 'complete' : 'partial',
    model: 'function-local-flow',
    basis: 'typescript-local-flow-backward-slices',
    unsupported,
    candidateEdges: flowModel.candidateEdges,
    candidateEdgeEffect: 'merge-only',
  };
  const archetype = archetypeFor(body, valueOutputs);
  const tier = tierFor(splitCandidate, archetype, clusters, coverage);
  const guards = sliced.filter((output) => output.guard).length;
  const context: ReportContext = {
    body,
    flow: flowModel,
    thresholds,
    archetype,
    clusters,
    preamble,
    orphans,
    guards,
    coverage,
  };
  const reportedOutputs = detail ? sliced : sliced.map(({ slice: _slice, fullSlice: _fullSlice, ...output }) => output);
  return {
    symbol: definition.symbol,
    shortName: shortenSymbol(definition.symbol),
    relativePath: definition.relativePath,
    startLine: definition.startLine,
    endLine: definition.endLine,
    loc: definitionLoc(definition),
    archetype,
    operational: OPERATIONAL_PATH.test(definition.relativePath),
    ...(detail ? { units: body.units.map(({ node: _node, start: _start, end: _end, ...unit }) => unit) } : {}),
    statementCount: counted.length,
    outputs: reportedOutputs,
    metrics,
    clusters,
    preambleOnlyOutputs,
    preamble,
    orphans,
    separableStatements,
    splitCandidate,
    actionTier: tier.tier,
    tierReason: tier.reason,
    evidenceReasons: evidenceReasons(counted.length, sliced, metrics, context),
    recommendation: recommendation(splitCandidate, valueOutputs, metrics, context),
    coverage,
  };
}

/** Slice outputs with and without guard predicates; handler dependencies belong to both. */
function sliceOutputs(
  body: BodyModel,
  flowModel: ReturnType<typeof projectFlow>,
  seeds: readonly OutputSeed[],
  countedSet: ReadonlySet<number>,
): SliceCohesionOutput[] {
  // A guard's own reads stay out of the computation, but the loops and
  // branches that enclose the guard still enclose everything under it. A
  // catch or finally block handles the try block, so it depends on it.
  const controlThroughGuards = (unit: number): number[] => {
    const result: number[] = [];
    const seen = new Set<number>();
    const stack = [...flowModel.controlDeps[unit]!];
    while (stack.length > 0) {
      const predicate = stack.pop()!;
      if (seen.has(predicate)) continue;
      seen.add(predicate);
      if (body.guardPredicates.has(predicate)) stack.push(...flowModel.controlDeps[predicate]!);
      else result.push(predicate);
    }
    return result;
  };
  const handlerDeps = (unit: number): number[] => body.handlerDeps.get(unit) ?? [];
  const computationDeps = (unit: number): number[] => [
    ...flowModel.dataDeps[unit]!,
    ...controlThroughGuards(unit),
    ...handlerDeps(unit),
  ];
  const fullDeps = (unit: number): number[] => [
    ...flowModel.dataDeps[unit]!,
    ...flowModel.controlDeps[unit]!,
    ...handlerDeps(unit),
  ];
  const slicedSeeds: SlicedSeed[] = seeds.map((seed) => {
    const seedUnitList = seedUnits(seed, flowModel);
    const slice = [...backwardSlice(seedUnitList, computationDeps)].filter((unit) => countedSet.has(unit));
    const fullSlice = [...backwardSlice(seedUnitList, fullDeps)].filter((unit) => countedSet.has(unit));
    // An output inside an exit-only branch is a guard, as is an unconditional
    // exit that reads nothing computed here.
    const guard =
      body.guardUnits.has(seed.unit) ||
      ((seed.kind === 'throw' || seed.kind === 'return') &&
        seed.seedPoints === null &&
        slice.every((unit) => unit === seed.unit));
    return { seed, guard, slice: new Set(slice), fullSlice: new Set(fullSlice) };
  });
  return mergeOutputs(slicedSeeds);
}

/** Reassign setup consumed by just one cluster until the shared partition stabilizes. */
function partitionOutputComputations(
  valueOutputs: SliceCohesionOutput[],
  outputUnits: Set<number>,
  body: BodyModel,
  flowModel: ReturnType<typeof projectFlow>,
  thresholds: Thresholds,
): { clusters: SliceCohesionCluster[]; preamble: number[] } {
  // Setup is shared only when outputs from different clusters read it. A
  // unit that every reader consumes within one cluster is that cluster's
  // computation, so it returns to the cluster and the partition is redrawn.
  const preambleSet = new Set(sharedPreamble(valueOutputs, outputUnits, body, flowModel));
  let clusters = clusterOutputs(valueOutputs, preambleSet, body, flowModel, thresholds);
  for (;;) {
    const clusterOf = new Map<string, number>();
    clusters.forEach((cluster, index) => cluster.outputs.forEach((id) => clusterOf.set(id, index)));
    const unshared = [...preambleSet].filter((unit) => {
      const readers = new Set<number>();
      for (const output of valueOutputs) {
        const cluster = clusterOf.get(output.id);
        if (cluster !== undefined && sliceOf(output).includes(unit)) readers.add(cluster);
      }
      return readers.size <= 1;
    });
    if (unshared.length === 0) break;
    for (const unit of unshared) preambleSet.delete(unit);
    clusters = clusterOutputs(valueOutputs, preambleSet, body, flowModel, thresholds);
  }
  const preamble = [...preambleSet].sort(ascending);
  return { clusters, preamble };
}

function sliceOf(output: SliceCohesionOutput): number[] {
  return output.slice ?? [];
}

function ascending(left: number, right: number): number {
  return left - right;
}

// ── Source model ────────────────────────────────────────────────────

/** The same parsed tree the flow program uses, retained per detector run so every callable in a file shares it. */
function parsedSourceFile(
  db: ScipDatabase,
  relativePath: string,
  cache: SourceFileCache,
): TypeScript.SourceFile | null {
  const cached = cache.files.get(relativePath);
  if (cached !== undefined) return cached;
  const parsed = typeScriptSourceFileForPath(db, relativePath);
  cache.files.set(relativePath, parsed);
  return parsed;
}

/** The outermost function-like body inside the definition's line range. */
function callableForDefinition(
  ts: TypeScriptModule,
  sourceFile: TypeScript.SourceFile,
  definition: IndexedDefinition,
): TypeScript.FunctionLikeDeclaration | null {
  let found: TypeScript.FunctionLikeDeclaration | null = null;
  const visit = (node: TypeScript.Node): void => {
    if (found) return;
    const startLine = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line;
    const endLine = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line;
    if (endLine < definition.startLine || startLine > definition.endLine) return;
    if (
      ts.isFunctionLike(node) &&
      'body' in node &&
      node.body !== undefined &&
      startLine >= definition.startLine &&
      endLine <= definition.endLine
    ) {
      found = node as TypeScript.FunctionLikeDeclaration;
      return;
    }
    node.forEachChild(visit);
  };
  sourceFile.forEachChild(visit);
  return found;
}

function modelBody(
  ts: TypeScriptModule,
  sourceFile: TypeScript.SourceFile,
  callable: TypeScript.FunctionLikeDeclaration,
  relativePath: string,
): BodyModel {
  const units: Unit[] = [];
  const guardNodes = new Set<TypeScript.Node>();
  const guardBranchNodes = new Set<TypeScript.Node>();
  const predicateStack: TypeScript.Node[] = [];
  const enclosingByNode = new Map<TypeScript.Node, TypeScript.Node[]>();
  const tryRegions: { tryNodes: TypeScript.Node[]; handlerNodes: TypeScript.Node[] }[] = [];
  const callableBody = callable.body!;
  const addUnit = (kind: SliceCohesionUnitKind, node: TypeScript.Node): void => {
    const start = node.getStart(sourceFile);
    const end = node.getEnd();
    units.push({
      index: 0,
      kind,
      node,
      start,
      end,
      startLine: sourceFile.getLineAndCharacterOfPosition(start).line,
      endLine: sourceFile.getLineAndCharacterOfPosition(end).line,
      label: unitLabel(sourceFile, node),
    });
    enclosingByNode.set(node, [...predicateStack]);
  };
  const underPredicate = (predicate: TypeScript.Node, visit: () => void): void => {
    predicateStack.push(predicate);
    visit();
    predicateStack.pop();
  };
  const visitStatement = (statement: TypeScript.Statement): void => {
    if (ts.isBlock(statement)) {
      for (const inner of statement.statements) visitStatement(inner);
    } else if (ts.isIfStatement(statement)) {
      addUnit('predicate', statement.expression);
      const exitOnly =
        !statement.elseStatement && isExitOnly(ts, statement.thenStatement, loopDeclaredNames(ts, statement));
      if (exitOnly) guardNodes.add(statement.expression);
      const branchStart = units.length;
      underPredicate(statement.expression, () => {
        visitStatement(statement.thenStatement);
        if (exitOnly) for (const unit of units.slice(branchStart)) guardBranchNodes.add(unit.node);
        if (statement.elseStatement) visitStatement(statement.elseStatement);
      });
    } else if (ts.isWhileStatement(statement) || ts.isDoStatement(statement)) {
      addUnit('predicate', statement.expression);
      underPredicate(statement.expression, () => visitStatement(statement.statement));
    } else if (ts.isForStatement(statement)) {
      if (statement.initializer) addUnit('statement', statement.initializer);
      if (statement.condition) addUnit('predicate', statement.condition);
      const predicate = statement.condition ?? statement;
      underPredicate(predicate, () => {
        if (statement.incrementor) addUnit('statement', statement.incrementor);
        visitStatement(statement.statement);
      });
    } else if (ts.isForInStatement(statement) || ts.isForOfStatement(statement)) {
      addUnit('predicate', statement.expression);
      underPredicate(statement.expression, () => {
        addUnit('statement', statement.initializer);
        visitStatement(statement.statement);
      });
    } else if (ts.isSwitchStatement(statement)) {
      addUnit('predicate', statement.expression);
      underPredicate(statement.expression, () => {
        for (const clause of statement.caseBlock.clauses) for (const inner of clause.statements) visitStatement(inner);
      });
    } else if (ts.isTryStatement(statement)) {
      const tryStart = units.length;
      visitStatement(statement.tryBlock);
      const handlerStart = units.length;
      if (statement.catchClause) {
        if (statement.catchClause.variableDeclaration) addUnit('statement', statement.catchClause.variableDeclaration);
        visitStatement(statement.catchClause.block);
      }
      if (statement.finallyBlock) visitStatement(statement.finallyBlock);
      tryRegions.push({
        tryNodes: units.slice(tryStart, handlerStart).map((unit) => unit.node),
        handlerNodes: units.slice(handlerStart).map((unit) => unit.node),
      });
    } else if (ts.isLabeledStatement(statement)) {
      visitStatement(statement.statement);
    } else if (ts.isReturnStatement(statement)) {
      addUnit('return', statement);
    } else if (ts.isThrowStatement(statement)) {
      addUnit('throw', statement);
    } else if (ts.isBreakOrContinueStatement(statement)) {
      addUnit('jump', statement);
    } else if (
      ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement)
    ) {
      addUnit('declaration', statement);
    } else if (!ts.isEmptyStatement(statement)) {
      addUnit('statement', statement);
    }
  };
  if (ts.isBlock(callableBody)) {
    for (const statement of callableBody.statements) visitStatement(statement);
  } else {
    addUnit('return', callableBody);
  }
  units.sort((left, right) => left.start - right.start);
  const indexOfNode = new Map<TypeScript.Node, number>();
  units.forEach((unit, index) => {
    unit.index = index;
    indexOfNode.set(unit.node, index);
  });
  const guardPredicates = new Set(units.filter((unit) => guardNodes.has(unit.node)).map((unit) => unit.index));
  const guardUnits = new Set(units.filter((unit) => guardBranchNodes.has(unit.node)).map((unit) => unit.index));
  const enclosingPredicates = units.map((unit) =>
    (enclosingByNode.get(unit.node) ?? [])
      .map((predicate) => indexOfNode.get(predicate))
      .filter((index): index is number => index !== undefined),
  );
  const awaitUnits = new Set(
    units.filter((unit) => COUNTED_KINDS.has(unit.kind) && containsAwait(ts, unit.node)).map((unit) => unit.index),
  );
  const handlerDeps = new Map<number, number[]>();
  for (const region of tryRegions) {
    const tryUnits = region.tryNodes
      .map((node) => indexOfNode.get(node)!)
      .filter((index) => COUNTED_KINDS.has(units[index]!.kind));
    for (const node of region.handlerNodes) {
      const index = indexOfNode.get(node)!;
      handlerDeps.set(index, [...(handlerDeps.get(index) ?? []), ...tryUnits]);
    }
  }

  const paramNames = new Set<string>();
  for (const parameter of callable.parameters)
    for (const name of bindingNames(ts, parameter.name)) paramNames.add(name);
  const localNames = new Set<string>();
  const calleeSpans = new Set<string>();
  const closureNodes = new Map<string, TypeScript.FunctionLikeDeclaration>();
  const containers = new Set<string>();
  const aliases = new Map<string, Set<string>>();
  const stateSetters = new Map<string, string>();
  const addAlias = (name: string, base: string | null): void => {
    if (!base || base === name) return;
    const bases = aliases.get(name) ?? new Set<string>();
    bases.add(base);
    aliases.set(name, bases);
  };
  const recordInitializer = (names: readonly string[], initializer: TypeScript.Expression): void => {
    const value = unwrapExpression(ts, initializer);
    if (isAggregate(ts, value)) {
      for (const name of names) containers.add(name);
      return;
    }
    for (const root of aliasRoots(ts, value)) for (const name of names) addAlias(name, root);
  };
  const visit = (node: TypeScript.Node): void => {
    if (ts.isVariableDeclaration(node)) {
      const names = bindingNames(ts, node.name);
      for (const name of names) localNames.add(name);
      const initializer = node.initializer ? unwrapExpression(ts, node.initializer) : null;
      const closure = initializer ? closureExpression(ts, initializer) : null;
      if (closure && ts.isIdentifier(node.name)) {
        closureNodes.set(node.name.text, closure);
      } else if (node.initializer) {
        recordInitializer(names, node.initializer);
        const setter = tupleStateSetter(ts, node);
        if (setter) stateSetters.set(setter.setter, setter.state);
      } else {
        const source = iterationSourceOf(ts, node);
        if (source)
          for (const root of aliasRoots(ts, unwrapExpression(ts, source)))
            for (const name of names) addAlias(name, root);
      }
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const left = unwrapExpression(ts, node.left);
      const right = unwrapExpression(ts, node.right);
      if (ts.isIdentifier(left)) {
        recordInitializer([left.text], node.right);
      } else if (ts.isIdentifier(right)) {
        // `target.set(...)` is below; `container.field = local` stores the local inside the container.
        addAlias(right.text, baseName(ts, left));
      }
    } else if (ts.isCallExpression(node)) {
      const callee = unwrapExpression(ts, node.expression);
      const mutating =
        ts.isElementAccessExpression(callee) ||
        (ts.isPropertyAccessExpression(callee) && !READ_ONLY_METHODS.has(callee.name.text));
      if (mutating && (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee))) {
        const receiver = baseName(ts, callee);
        for (const argument of node.arguments) {
          const value = unwrapExpression(ts, argument);
          if (ts.isIdentifier(value)) addAlias(value.text, receiver);
        }
      }
    } else if (ts.isParameter(node) && node.parent !== callable) {
      for (const name of bindingNames(ts, node.name)) localNames.add(name);
    } else if (ts.isFunctionDeclaration(node) && node.name) {
      localNames.add(node.name.text);
      if (node.body) closureNodes.set(node.name.text, node);
    } else if (ts.isClassDeclaration(node) && node.name) {
      localNames.add(node.name.text);
    } else if (ts.isCatchClause(node) && node.variableDeclaration) {
      for (const name of bindingNames(ts, node.variableDeclaration.name)) localNames.add(name);
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      calleeSpans.add(`${node.expression.getStart(sourceFile)}:${node.expression.getEnd()}`);
    } else if (ts.isTaggedTemplateExpression(node)) {
      calleeSpans.add(`${node.tag.getStart(sourceFile)}:${node.tag.getEnd()}`);
    }
    node.forEachChild(visit);
  };
  visit(callableBody);
  const enclosingRanges: SourceRange[] = [];
  for (let current = callable.parent; current; current = current.parent) {
    if (ts.isFunctionLike(current))
      enclosingRanges.push({ start: current.getStart(sourceFile), end: current.getEnd() });
  }
  const hookCalls = new Map<number, string[]>();
  for (const unit of units) {
    if (!COUNTED_KINDS.has(unit.kind)) continue;
    const names = topLevelHookCalls(ts, unit.node);
    if (names.length > 0) hookCalls.set(unit.index, names);
  }
  const name = callable.name && 'text' in callable.name ? String(callable.name.text) : '';
  const react = hookCalls.size > 0 && (/\.[jt]sx$/iu.test(relativePath) || HOOK_NAME.test(name));
  const model: BodyModel = {
    ts,
    sourceFile,
    callable,
    units,
    paramNames,
    localNames,
    guardPredicates,
    guardUnits,
    enclosingPredicates,
    awaitUnits,
    calleeSpans,
    closures: new Map(),
    containers,
    aliases,
    enclosingRanges,
    handlerDeps,
    stateSetters,
    hookCalls,
    react,
  };
  model.closures = summarizeClosures(model, closureNodes);
  return model;
}

/** A function expression bound to a name, directly or through `useCallback(fn, deps)`. */
function closureExpression(
  ts: TypeScriptModule,
  initializer: TypeScript.Expression,
): TypeScript.FunctionLikeDeclaration | null {
  if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) return initializer;
  if (ts.isCallExpression(initializer)) {
    const leaf = calleeLeafName(ts, unwrapExpression(ts, initializer.expression));
    if (leaf === 'useCallback' && initializer.arguments.length > 0) {
      const wrapped = unwrapExpression(ts, initializer.arguments[0]!);
      if (ts.isArrowFunction(wrapped) || ts.isFunctionExpression(wrapped)) return wrapped;
    }
  }
  return null;
}

/**
 * `const [value, setValue] = useX(...)`: a tuple state hook whose second
 * binding writes the first. Calling the setter is a write to the state the
 * body owns, so later reads of the state depend on it.
 */
function tupleStateSetter(
  ts: TypeScriptModule,
  node: TypeScript.VariableDeclaration,
): { state: string; setter: string } | null {
  if (!ts.isArrayBindingPattern(node.name) || !node.initializer) return null;
  const initializer = unwrapExpression(ts, node.initializer);
  if (!ts.isCallExpression(initializer)) return null;
  const leaf = calleeLeafName(ts, unwrapExpression(ts, initializer.expression));
  if (!leaf || !HOOK_NAME.test(leaf)) return null;
  const [first, second] = node.name.elements;
  if (!first || !second || ts.isOmittedExpression(first) || ts.isOmittedExpression(second)) return null;
  if (!ts.isIdentifier(first.name) || !ts.isIdentifier(second.name)) return null;
  return { state: first.name.text, setter: second.name.text };
}

function calleeLeafName(ts: TypeScriptModule, callee: TypeScript.Expression): string | null {
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return null;
}

/** Hook calls at the top level of a unit: a call statement, a declaration initializer, or a returned call. */
function topLevelHookCalls(ts: TypeScriptModule, node: TypeScript.Node): string[] {
  const names: string[] = [];
  const visit = (inner: TypeScript.Node): void => {
    if (ts.isFunctionLike(inner)) return;
    if (ts.isCallExpression(inner)) {
      const leaf = calleeLeafName(ts, unwrapExpression(ts, inner.expression));
      if (leaf && HOOK_NAME.test(leaf)) names.push(leaf);
    }
    inner.forEachChild(visit);
  };
  visit(node);
  return names;
}

/** A fresh aggregate value: an array or object literal, a constructed instance, or a fallback to one. */
function isAggregate(ts: TypeScriptModule, expression: TypeScript.Expression): boolean {
  if (ts.isArrayLiteralExpression(expression) || ts.isObjectLiteralExpression(expression)) return true;
  if (ts.isNewExpression(expression)) return true;
  if (ts.isBinaryExpression(expression)) {
    const kind = expression.operatorToken.kind;
    if (kind === ts.SyntaxKind.QuestionQuestionToken || kind === ts.SyntaxKind.BarBarToken) {
      return isAggregate(ts, unwrapExpression(ts, expression.right));
    }
  }
  if (ts.isConditionalExpression(expression)) {
    return (
      isAggregate(ts, unwrapExpression(ts, expression.whenTrue)) ||
      isAggregate(ts, unwrapExpression(ts, expression.whenFalse))
    );
  }
  return false;
}

/**
 * The names whose contents an expression may expose: `map.get(k)` exposes
 * part of `map`, `list[0]` part of `list`, `a ?? b` part of either. Methods
 * that build a new value expose nothing.
 */
function aliasRoots(ts: TypeScriptModule, expression: TypeScript.Expression): string[] {
  const value = unwrapExpression(ts, expression);
  if (ts.isIdentifier(value)) return [value.text];
  if (value.kind === ts.SyntaxKind.ThisKeyword) return ['this'];
  if (ts.isBinaryExpression(value)) {
    const kind = value.operatorToken.kind;
    if (kind === ts.SyntaxKind.QuestionQuestionToken || kind === ts.SyntaxKind.BarBarToken) {
      return [...aliasRoots(ts, value.left), ...aliasRoots(ts, value.right)];
    }
    return [];
  }
  if (ts.isConditionalExpression(value)) return [...aliasRoots(ts, value.whenTrue), ...aliasRoots(ts, value.whenFalse)];
  if (ts.isPropertyAccessExpression(value)) {
    return NON_ALIASING_MEMBERS.has(value.name.text) ? [] : aliasRoots(ts, value.expression);
  }
  if (ts.isElementAccessExpression(value)) return aliasRoots(ts, value.expression);
  if (ts.isCallExpression(value)) {
    const callee = unwrapExpression(ts, value.expression);
    if (ts.isPropertyAccessExpression(callee)) {
      return NON_ALIASING_MEMBERS.has(callee.name.text) ? [] : aliasRoots(ts, callee.expression);
    }
    return [];
  }
  return [];
}

function iterationSourceOf(ts: TypeScriptModule, node: TypeScript.VariableDeclaration): TypeScript.Expression | null {
  const list = node.parent;
  if (!list || !ts.isVariableDeclarationList(list)) return null;
  const loop = list.parent;
  if (loop && (ts.isForOfStatement(loop) || ts.isForInStatement(loop)) && loop.initializer === list)
    return loop.expression;
  return null;
}

/** Every base a written local may stand for, itself included, following stored-into and read-from aliases. */
function resolveBases(body: BodyModel, base: string): Set<string> {
  const resolved = new Set<string>([base]);
  const stack = [base];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (!isLocalBase(body, current)) continue;
    for (const target of body.aliases.get(current) ?? []) {
      if (resolved.has(target)) continue;
      resolved.add(target);
      stack.push(target);
    }
  }
  return resolved;
}

/**
 * A then-branch that only leaves the function: statements that prepare or
 * report the exit (calls, local bindings) followed by a return or throw
 * whose value is not computed in the branch or in an enclosing loop. A
 * `return empty` after `const empty = ...` at the top, a log line before
 * `return null`, or a delegation such as `return suppress(params)` is an
 * exit; `const detail = ...; return detail;` is an alternate result, and a
 * `return item` from inside a search loop is the loop's result. A
 * `continue` or `break` guard inside a loop filters the elements a
 * computation sees, so it stays an ordinary predicate.
 */
function isExitOnly(
  ts: TypeScriptModule,
  statement: TypeScript.Statement,
  outerDeclared: ReadonlySet<string>,
): boolean {
  const statements = ts.isBlock(statement) ? statement.statements : [statement];
  if (statements.length === 0) return false;
  const last = statements[statements.length - 1]!;
  if (!ts.isReturnStatement(last) && !ts.isThrowStatement(last)) return false;
  const declared = new Set(outerDeclared);
  for (const inner of statements.slice(0, -1)) {
    if (ts.isVariableStatement(inner)) {
      for (const declaration of inner.declarationList.declarations)
        for (const name of bindingNames(ts, declaration.name)) declared.add(name);
    } else if (!ts.isExpressionStatement(inner)) {
      return false;
    }
  }
  if (!ts.isReturnStatement(last) || !last.expression) return true;
  let computedHere = false;
  const visit = (node: TypeScript.Node): void => {
    if (computedHere) return;
    if (ts.isIdentifier(node) && isReadIdentifier(ts, node) && declared.has(node.text)) computedHere = true;
    else node.forEachChild(visit);
  };
  visit(last.expression);
  return !computedHere;
}

/** Names bound inside the loops that enclose a statement: a value from one of them is the loop's result, not a guard's. */
function loopDeclaredNames(ts: TypeScriptModule, statement: TypeScript.Statement): Set<string> {
  const names = new Set<string>();
  for (let current = statement.parent; current && !ts.isFunctionLike(current); current = current.parent) {
    if (!ts.isIterationStatement(current, false)) continue;
    const visit = (node: TypeScript.Node): void => {
      if (ts.isVariableDeclaration(node)) for (const name of bindingNames(ts, node.name)) names.add(name);
      node.forEachChild(visit);
    };
    visit(current);
  }
  return names;
}

/** Whether a unit awaits outside any nested function: it waits on the outside world rather than computing. */
function containsAwait(ts: TypeScriptModule, node: TypeScript.Node): boolean {
  let found = false;
  const visit = (inner: TypeScript.Node): void => {
    if (found || (ts.isFunctionLike(inner) && inner !== node)) return;
    if (ts.isAwaitExpression(inner) || (ts.isForOfStatement(inner) && inner.awaitModifier !== undefined)) {
      found = true;
      return;
    }
    inner.forEachChild(visit);
  };
  visit(node);
  return found;
}

function bindingNames(ts: TypeScriptModule, name: TypeScript.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  const names: string[] = [];
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue;
    names.push(...bindingNames(ts, element.name));
  }
  return names;
}

function unitLabel(sourceFile: TypeScript.SourceFile, node: TypeScript.Node): string {
  const text = node.getText(sourceFile).replace(/\s+/gu, ' ').trim();
  return text.length > LABEL_LENGTH ? `${text.slice(0, LABEL_LENGTH - 3)}...` : text;
}

/**
 * What each local closure reads and writes outside its own scope. A call to
 * `union(a, b)` that writes the captured `parents` map is a write to
 * `parents` at the call site; a closure that writes a parameter or outer
 * state makes its call sites effects; a closure that calls a tuple state
 * setter writes that state. Summaries close over the closures they call.
 */
function summarizeClosures(
  body: BodyModel,
  closureNodes: ReadonlyMap<string, TypeScript.FunctionLikeDeclaration>,
): Map<string, ClosureSummary> {
  const { ts } = body;
  const summaries = new Map<string, ClosureSummary>();
  for (const [name, node] of closureNodes) {
    const declared = new Set<string>();
    const summary: ClosureSummary = { reads: new Set(), writes: new Set(), stateWrites: new Set(), calls: new Set() };
    for (const parameter of node.parameters) for (const bound of bindingNames(ts, parameter.name)) declared.add(bound);
    const declare = (inner: TypeScript.Node): void => {
      if (ts.isVariableDeclaration(inner)) for (const bound of bindingNames(ts, inner.name)) declared.add(bound);
      else if (ts.isParameter(inner)) for (const bound of bindingNames(ts, inner.name)) declared.add(bound);
      else if ((ts.isFunctionDeclaration(inner) || ts.isClassDeclaration(inner)) && inner.name)
        declared.add(inner.name.text);
      inner.forEachChild(declare);
    };
    if (node.body) declare(node.body);
    const visit = (inner: TypeScript.Node): void => {
      if (ts.isTypeNode(inner)) return;
      const written = writtenBase(body, inner as TypeScript.Expression);
      if (written && !declared.has(written)) summary.writes.add(written);
      if (ts.isCallExpression(inner)) {
        const callee = unwrapExpression(ts, inner.expression);
        if (ts.isIdentifier(callee) && !declared.has(callee.text)) {
          if (closureNodes.has(callee.text)) summary.calls.add(callee.text);
          const state = body.stateSetters.get(callee.text);
          if (state) summary.stateWrites.add(state);
        }
      }
      if (ts.isIdentifier(inner) && isReadIdentifier(ts, inner) && !declared.has(inner.text))
        summary.reads.add(inner.text);
      if (inner.kind === ts.SyntaxKind.ThisKeyword) summary.reads.add('this');
      inner.forEachChild(visit);
    };
    if (node.body) visit(node.body);
    summaries.set(name, summary);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const summary of summaries.values()) {
      for (const callee of summary.calls) {
        const target = summaries.get(callee);
        if (!target) continue;
        const merges: readonly [ReadonlySet<string>, Set<string>][] = [
          [target.reads, summary.reads],
          [target.writes, summary.writes],
          [target.stateWrites, summary.stateWrites],
        ];
        for (const [from, to] of merges) {
          for (const name of from) {
            if (to.has(name)) continue;
            to.add(name);
            changed = true;
          }
        }
      }
    }
  }
  return summaries;
}

function isReadIdentifier(ts: TypeScriptModule, node: TypeScript.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
  if (ts.isBindingElement(parent) && parent.propertyName === node) return false;
  if ('name' in parent && parent.name === node && !ts.isShorthandPropertyAssignment(parent)) return false;
  if (ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent)) return false;
  return true;
}

// ── Flow projection ─────────────────────────────────────────────────

function projectFlow(body: BodyModel, flow: TypeScriptLocalFlowResult, relativePath: string): FlowModel {
  const { units } = body;
  const callableStart = body.callable.getStart(body.sourceFile);
  const callableEnd = body.callable.getEnd();
  const bodyStart = body.callable.body!.getStart(body.sourceFile);
  const pointById = new Map<string, TypeScriptLocalFlowPoint>();
  const unitOfPoint = new Map<string, number>();
  for (const point of flow.points) {
    if (point.start < callableStart || point.end > callableEnd) continue;
    pointById.set(point.id, point);
    if (point.start < bodyStart) {
      unitOfPoint.set(point.id, -1);
      continue;
    }
    const unit = unitAt(units, point.start);
    if (unit !== null) unitOfPoint.set(point.id, unit);
  }

  const dataDeps = units.map(() => new Set<number>());
  const controlDeps = units.map(() => new Set<number>());
  const pointDeps = new Map<string, Set<number>>();
  const paramReads = units.map(() => new Set<string>());
  const outerReads = units.map(() => new Set<string>());
  const definedNames = units.map(() => new Set<string>());
  const reachedUses = new Set<string>();
  let candidateEdges = 0;

  const addPointDep = (pointId: string, unit: number): void => {
    let deps = pointDeps.get(pointId);
    if (!deps) {
      deps = new Set();
      pointDeps.set(pointId, deps);
    }
    deps.add(unit);
  };

  for (const edge of flow.edges) {
    const from = pointById.get(edge.fromPointId);
    const to = pointById.get(edge.toPointId);
    if (!from || !to) continue;
    const fromUnit = unitOfPoint.get(from.id);
    const toUnit = unitOfPoint.get(to.id);
    if (fromUnit === undefined || toUnit === undefined || toUnit === -1) continue;
    if (edge.kind !== 'control-dependence') reachedUses.add(to.id);
    if (fromUnit === -1) {
      if (edge.kind !== 'control-dependence') paramReads[toUnit]!.add(rootName(from.name));
      continue;
    }
    if (fromUnit === toUnit) continue;
    if (edge.strength === 'candidate') candidateEdges += 1;
    if (edge.kind === 'control-dependence') {
      controlDeps[toUnit]!.add(fromUnit);
    } else {
      dataDeps[toUnit]!.add(fromUnit);
      addPointDep(to.id, fromUnit);
    }
  }

  body.enclosingPredicates.forEach((predicates, unit) => {
    for (const predicate of predicates) if (predicate !== unit) controlDeps[unit]!.add(predicate);
  });

  const definitionsByUnitName = new Map<string, TypeScriptLocalFlowPoint>();
  for (const point of pointById.values()) {
    const unit = unitOfPoint.get(point.id);
    if (unit === undefined || unit === -1) continue;
    if (point.kind === 'definition') {
      definedNames[unit]!.add(rootName(point.name));
      const key = `${unit}\0${point.name}`;
      if (!definitionsByUnitName.has(key)) definitionsByUnitName.set(key, point);
      continue;
    }
    if (point.kind !== 'use' || reachedUses.has(point.id)) continue;
    if (body.calleeSpans.has(`${point.start}:${point.end}`)) continue;
    if (point.name.includes('(')) continue;
    const root = rootName(point.name);
    if (body.paramNames.has(root)) {
      paramReads[unit]!.add(root);
      continue;
    }
    if (body.localNames.has(root)) continue;
    if (root === 'this') {
      outerReads[unit]!.add('this');
      continue;
    }
    // Only a local of an enclosing function would become a parameter. An
    // import, a module-level name, a global, or a JSX tag stays what it is.
    if (!declaredInEnclosingCallable(point.symbolKey, relativePath, body.enclosingRanges)) continue;
    outerReads[unit]!.add(root);
  }

  // Writes to containers the function owns, directly or through a local
  // closure, are ordered dependencies: a later read of the container
  // depends on the write. Reads through a closure depend on earlier writes.
  const { writes, reads, byUnit, stateWritesByUnit } = containerAccesses(body);
  const usesByRoot = new Map<string, { id: string; start: number; unit: number }[]>();
  for (const point of pointById.values()) {
    if (point.kind !== 'use') continue;
    const unit = unitOfPoint.get(point.id);
    if (unit === undefined || unit === -1) continue;
    const root = rootName(point.name);
    const rows = usesByRoot.get(root) ?? [];
    rows.push({ id: point.id, start: point.start, unit });
    usesByRoot.set(root, rows);
  }
  for (const write of writes) {
    const writeStart = units[write.unit]!.start;
    for (const use of usesByRoot.get(write.base) ?? []) {
      if (use.unit === write.unit || use.start <= writeStart) continue;
      dataDeps[use.unit]!.add(write.unit);
      addPointDep(use.id, write.unit);
    }
    for (const read of reads) {
      if (read.unit === write.unit || read.base !== write.base) continue;
      if (units[read.unit]!.start <= writeStart) continue;
      dataDeps[read.unit]!.add(write.unit);
    }
  }

  return {
    pointById,
    unitOfPoint,
    definitionsByUnitName,
    dataDeps,
    controlDeps,
    pointDeps,
    paramReads,
    outerReads,
    definedNames,
    candidateEdges,
    writesByUnit: byUnit,
    stateWritesByUnit,
  };
}

function unitAt(units: readonly Unit[], offset: number): number | null {
  let low = 0;
  let high = units.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (units[middle]!.start <= offset) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (found < 0) return null;
  return offset < units[found]!.end ? found : null;
}

function rootName(name: string): string {
  const stop = name.search(/[.[?!(]/u);
  return stop < 0 ? name : name.slice(0, stop);
}

function symbolKeyParts(symbolKey: string | null): { fileName: string; offset: number } | null {
  if (!symbolKey) return null;
  const parts = symbolKey.split(':');
  if (parts.length < 4) return null;
  const offset = Number(parts[2]);
  if (!Number.isSafeInteger(offset)) return null;
  try {
    return { fileName: decodeURIComponent(parts[1]!).replace(/\\/gu, '/'), offset };
  } catch {
    return null;
  }
}

/** Whether a compiler symbol key names a declaration inside the callable's own offsets in the same file. */
function declaredInside(symbolKey: string | null, relativePath: string, start: number, end: number): boolean {
  const parts = symbolKeyParts(symbolKey);
  if (!parts) return false;
  return parts.fileName.endsWith(relativePath.replace(/\\/gu, '/')) && parts.offset >= start && parts.offset < end;
}

/** Whether a compiler symbol key names a declaration inside one of the enclosing functions in the same file. */
function declaredInEnclosingCallable(
  symbolKey: string | null,
  relativePath: string,
  ranges: readonly SourceRange[],
): boolean {
  return ranges.some((range) => declaredInside(symbolKey, relativePath, range.start, range.end));
}

/**
 * Container writes and closure-mediated reads per unit: `items.push(x)`,
 * `acc.total = n`, `cache[key] = v` on a local binding, a fresh aggregate
 * passed to a call, calls to local closures that write or read captured
 * locals, and tuple state setters that run at render time or inside an
 * effect callback. Writes follow aliases, so `bucket.push(x)` after
 * `map.set(k, bucket)` is a write to `map`, and a write that reaches a
 * parameter or `this` is recorded as external.
 */
function containerAccesses(body: BodyModel): {
  writes: BaseAccess[];
  reads: BaseAccess[];
  byUnit: Map<number, UnitWrites>;
  stateWritesByUnit: Map<number, string[]>;
} {
  const { ts } = body;
  const writes: BaseAccess[] = [];
  const reads: BaseAccess[] = [];
  const byUnit = new Map<number, UnitWrites>();
  const stateWritesByUnit = new Map<number, string[]>();
  const record = (unit: number, rawBase: string, containerWrite: boolean): void => {
    let entry = byUnit.get(unit);
    if (!entry) {
      entry = { local: new Set(), external: new Set() };
      byUnit.set(unit, entry);
    }
    const bases = containerWrite ? resolveBases(body, rawBase) : new Set([rawBase]);
    for (const base of bases) {
      if (isLocalBase(body, base)) {
        entry.local.add(base);
        writes.push({ unit, base });
      } else if (containerWrite || base !== rawBase) {
        entry.external.add(base);
        // A later read of the same parameter or field sees this write too. A
        // module-level service (`logger`, `db`) is not ordered by the local
        // model: that is a runtime concern, and chaining every call on it
        // would fold unrelated operations into one computation.
        if (containerWrite && (base === 'this' || body.paramNames.has(base))) writes.push({ unit, base });
      }
    }
  };
  for (const unit of body.units) {
    if (!COUNTED_KINDS.has(unit.kind)) continue;
    const expression = statementExpression(ts, unit.node);
    if (expression) {
      const written = writtenBase(body, expression);
      if (written) record(unit.index, written, isContainerWrite(body, expression));
    }
    for (const summary of closureCallsIn(body, unit.node)) {
      for (const base of summary.writes) record(unit.index, base, true);
      for (const base of summary.reads) if (isLocalBase(body, base)) reads.push({ unit: unit.index, base });
    }
    for (const passed of containersPassedIn(body, unit.node)) record(unit.index, passed, true);
    const stateWrites = renderTimeStateWrites(body, unit.node);
    if (stateWrites.length > 0) {
      stateWritesByUnit.set(unit.index, stateWrites);
      for (const state of stateWrites) record(unit.index, state, true);
    }
  }
  return { writes, reads, byUnit, stateWritesByUnit };
}

/**
 * Tuple state written while the unit runs: setter calls outside nested
 * functions, setter calls anywhere inside a callback passed directly to an
 * effect hook (its promise continuations, timers, and subscriptions run as
 * part of the effect), and the state writes of local closures called from
 * those places. A handler declared here and passed away writes nothing
 * until it is invoked, so its setter calls are not attributed to this unit.
 */
function renderTimeStateWrites(body: BodyModel, node: TypeScript.Node): string[] {
  const { ts } = body;
  const states = new Set<string>();
  const visit = (inner: TypeScript.Node, insideEffect: boolean): void => {
    if (ts.isFunctionLike(inner) && inner !== node && !insideEffect) return;
    if (ts.isCallExpression(inner)) {
      const callee = unwrapExpression(ts, inner.expression);
      if (ts.isIdentifier(callee)) {
        const state = body.stateSetters.get(callee.text);
        if (state) states.add(state);
        const summary = body.closures.get(callee.text);
        if (summary) for (const written of summary.stateWrites) states.add(written);
      }
      const leaf = calleeLeafName(ts, callee);
      if (leaf && EFFECT_HOOK_NAME.test(leaf)) {
        for (const argument of inner.arguments) {
          const value = unwrapExpression(ts, argument);
          const callback = ts.isArrowFunction(value) || ts.isFunctionExpression(value);
          if (callback && value.body) visit(value.body, true);
          else visit(argument, insideEffect);
        }
        return;
      }
    }
    inner.forEachChild((child) => visit(child, insideEffect));
  };
  visit(node, false);
  return [...states];
}

/** A write through a member or element, or a mutating method call, as opposed to rebinding a bare identifier. */
function isContainerWrite(body: BodyModel, expression: TypeScript.Expression): boolean {
  const { ts } = body;
  if (ts.isCallExpression(expression) || ts.isDeleteExpression(expression)) return true;
  const target = ts.isBinaryExpression(expression)
    ? expression.left
    : ts.isPrefixUnaryExpression(expression) || ts.isPostfixUnaryExpression(expression)
      ? expression.operand
      : null;
  return target !== null && !ts.isIdentifier(unwrapExpression(ts, target));
}

/** Fresh local aggregates handed to a call inside the unit: the callee may fill them. */
function containersPassedIn(body: BodyModel, node: TypeScript.Node): string[] {
  const { ts } = body;
  const passed: string[] = [];
  const visit = (inner: TypeScript.Node): void => {
    if (ts.isCallExpression(inner) || ts.isNewExpression(inner)) {
      for (const argument of inner.arguments ?? []) {
        const value = unwrapExpression(ts, argument);
        if (ts.isIdentifier(value) && body.containers.has(value.text)) passed.push(value.text);
      }
    }
    inner.forEachChild(visit);
  };
  visit(node);
  return passed;
}

/** Summaries of every local closure a unit calls, including calls inside callbacks the unit passes along. */
function closureCallsIn(body: BodyModel, node: TypeScript.Node): ClosureSummary[] {
  const { ts } = body;
  const found: ClosureSummary[] = [];
  const visit = (inner: TypeScript.Node): void => {
    if (ts.isCallExpression(inner)) {
      const callee = unwrapExpression(ts, inner.expression);
      if (ts.isIdentifier(callee)) {
        const summary = body.closures.get(callee.text);
        if (summary) found.push(summary);
      }
    }
    inner.forEachChild(visit);
  };
  visit(node);
  return found;
}

function statementExpression(ts: TypeScriptModule, node: TypeScript.Node): TypeScript.Expression | null {
  const expression = ts.isExpressionStatement(node) ? node.expression : ts.isExpression(node) ? node : null;
  return expression ? unwrapExpression(ts, expression) : null;
}

function unwrapExpression(ts: TypeScriptModule, expression: TypeScript.Expression): TypeScript.Expression {
  let current = expression;
  for (;;) {
    if (ts.isParenthesizedExpression(current) || ts.isAwaitExpression(current) || ts.isVoidExpression(current)) {
      current = current.expression;
    } else if (
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isTypeAssertionExpression(current)
    ) {
      current = current.expression;
    } else {
      return current;
    }
  }
}

/** The root name an expression writes through, or null when it writes nothing. */
function writtenBase(body: BodyModel, expression: TypeScript.Node): string | null {
  const { ts } = body;
  if (ts.isBinaryExpression(expression) && isAssignmentOperator(ts, expression.operatorToken.kind)) {
    return baseName(ts, expression.left);
  }
  if (ts.isPrefixUnaryExpression(expression) || ts.isPostfixUnaryExpression(expression)) {
    if (expression.operator === ts.SyntaxKind.PlusPlusToken || expression.operator === ts.SyntaxKind.MinusMinusToken)
      return baseName(ts, expression.operand);
    return null;
  }
  if (ts.isDeleteExpression(expression)) return baseName(ts, expression.expression);
  if (ts.isCallExpression(expression)) {
    const callee = unwrapExpression(ts, expression.expression);
    if (ts.isPropertyAccessExpression(callee)) {
      return READ_ONLY_METHODS.has(callee.name.text) ? null : baseName(ts, callee);
    }
    if (ts.isElementAccessExpression(callee)) return baseName(ts, callee);
    return null;
  }
  return null;
}

function isAssignmentOperator(ts: TypeScriptModule, kind: TypeScript.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

/** The leftmost name of an access chain: `this` for `this.x.y`, `acc` for `acc[i].z`. Null for anything else. */
function baseName(ts: TypeScriptModule, expression: TypeScript.Expression): string | null {
  let current = unwrapExpression(ts, expression);
  for (;;) {
    if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
      current = unwrapExpression(ts, current.expression);
    } else if (ts.isIdentifier(current)) {
      return current.text;
    } else if (current.kind === ts.SyntaxKind.ThisKeyword) {
      return 'this';
    } else if (ts.isCallExpression(current)) {
      current = unwrapExpression(ts, current.expression);
    } else {
      return null;
    }
  }
}

function isLocalBase(body: BodyModel, base: string): boolean {
  return base !== 'this' && !body.paramNames.has(base) && body.localNames.has(base);
}

// ── Outputs ─────────────────────────────────────────────────────────

function collectOutputs(body: BodyModel, flow: FlowModel): OutputSeed[] {
  const { ts, sourceFile } = body;
  const outputs: OutputSeed[] = [];
  const usePoints = [...flow.pointById.values()].filter((point) => point.kind === 'use');
  const pointsInRange = (start: number, end: number): TypeScriptLocalFlowPoint[] =>
    usePoints.filter((point) => point.start >= start && point.end <= end);
  for (const unit of body.units) {
    const line = unit.startLine;
    if (unit.kind === 'return') {
      const expression = ts.isReturnStatement(unit.node) ? unit.node.expression : (unit.node as TypeScript.Expression);
      if (!expression) continue;
      const literal = unwrapExpression(ts, expression);
      if (ts.isObjectLiteralExpression(literal) && literal.properties.length >= 2) {
        // Each returned field is one output; the same field on another return statement is the same output.
        for (const property of literal.properties) {
          const name = propertyLabel(ts, sourceFile, property);
          outputs.push({
            id: `return.${name}@${line + 1}`,
            kind: 'return-property',
            label: `return.${name}`,
            line,
            unit: unit.index,
            group: `return.${name}`,
            hook: false,
            seedPoints: pointsInRange(property.getStart(sourceFile), property.getEnd()),
          });
        }
        continue;
      }
      // A function has one return value; every return statement produces it.
      outputs.push({
        id: `return@${line + 1}`,
        kind: 'return',
        label: 'return',
        line,
        unit: unit.index,
        group: 'return',
        hook: false,
        seedPoints: null,
      });
      continue;
    }
    if (unit.kind === 'throw') {
      outputs.push({
        id: `throw@${line + 1}`,
        kind: 'throw',
        label: unit.label,
        line,
        unit: unit.index,
        group: `throw@${line + 1}`,
        hook: false,
        seedPoints: null,
      });
      continue;
    }
    if (unit.kind !== 'statement') continue;
    const expression = statementExpression(ts, unit.node);
    if (!expression) continue;
    const written = writtenBase(body, expression);
    const unitWrites = flow.writesByUnit.get(unit.index);
    const external = unitWrites ? [...unitWrites.external] : [];
    const isCall =
      ts.isCallExpression(expression) || ts.isNewExpression(expression) || ts.isTaggedTemplateExpression(expression);
    if (written !== null && isLocalBase(body, written)) {
      // A write to something the function owns; an output only when an alias makes it someone else's.
      if (external.length > 0) {
        outputs.push({
          id: `write:${external[0]}@${line + 1}`,
          kind: 'mutation',
          label: unit.label,
          line,
          unit: unit.index,
          group: `write:${external[0]}@${line + 1}`,
          hook: false,
          seedPoints: null,
        });
      }
      continue;
    }
    if (isCall) {
      const callee = ts.isTaggedTemplateExpression(expression)
        ? expression.tag
        : unwrapExpression(ts, expression.expression);
      if (written === null) {
        if (ts.isIdentifier(callee)) {
          const summary = body.closures.get(callee.text);
          if (summary && ![...summary.writes].some((base) => !isLocalBase(body, base))) continue;
        }
        // A call that receives a fresh local aggregate fills it, and a state
        // write is the function's own work; neither is an effect on the outside.
        if (unitWrites && unitWrites.local.size > 0 && external.length === 0) continue;
      }
      const calleeText = compact(callee.getText(sourceFile));
      const leaf = ts.isTaggedTemplateExpression(expression) ? null : calleeLeafName(ts, callee);
      outputs.push({
        id: `call:${calleeText}@${line + 1}`,
        kind: 'effect-call',
        label: `${calleeText}(…)`,
        line,
        unit: unit.index,
        group: `call:${calleeText}@${line + 1}`,
        hook: leaf !== null && HOOK_NAME.test(leaf),
        seedPoints: null,
      });
      continue;
    }
    if (written === null) continue;
    if (written !== 'this' && !body.paramNames.has(written) && isLocalIdentifierWrite(body, expression, flow, unit))
      continue;
    outputs.push({
      id: `write:${written}@${line + 1}`,
      kind: 'mutation',
      label: unit.label,
      line,
      unit: unit.index,
      group: `write:${written}@${line + 1}`,
      hook: false,
      seedPoints: null,
    });
  }
  return outputs;
}

/** An assignment to a bare identifier the function itself declared is local state, not a write to the outside. */
function isLocalIdentifierWrite(
  body: BodyModel,
  expression: TypeScript.Expression,
  flow: FlowModel,
  unit: Unit,
): boolean {
  const { ts } = body;
  const target = ts.isBinaryExpression(expression)
    ? expression.left
    : ts.isPrefixUnaryExpression(expression) || ts.isPostfixUnaryExpression(expression)
      ? expression.operand
      : null;
  if (!target) return false;
  const identifier = unwrapExpression(ts, target);
  if (!ts.isIdentifier(identifier) || !body.localNames.has(identifier.text)) return false;
  const point = flow.definitionsByUnitName.get(`${unit.index}\0${identifier.text}`);
  if (!point) return true;
  const callableStart = body.callable.getStart(body.sourceFile);
  const callableEnd = body.callable.getEnd();
  return declaredInside(point.symbolKey, body.sourceFile.fileName, callableStart, callableEnd);
}

function propertyLabel(
  ts: TypeScriptModule,
  sourceFile: TypeScript.SourceFile,
  property: TypeScript.ObjectLiteralElementLike,
): string {
  if (ts.isSpreadAssignment(property)) return `...${compact(property.expression.getText(sourceFile))}`;
  const name = property.name;
  if (!name) return compact(property.getText(sourceFile));
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return compact(name.getText(sourceFile));
}

function compact(text: string): string {
  const collapsed = text.replace(/\s+/gu, ' ').trim();
  return collapsed.length > 40 ? `${collapsed.slice(0, 37)}...` : collapsed;
}

// ── Slicing ─────────────────────────────────────────────────────────

function seedUnits(output: OutputSeed, flow: FlowModel): number[] {
  if (output.seedPoints === null) return [output.unit];
  const seeds = new Set<number>();
  for (const point of output.seedPoints) for (const unit of flow.pointDeps.get(point.id) ?? []) seeds.add(unit);
  return [...seeds];
}

function backwardSlice(seeds: readonly number[], dependencies: (unit: number) => Iterable<number>): Set<number> {
  const visited = new Set<number>(seeds);
  const stack = [...seeds];
  while (stack.length > 0) {
    const unit = stack.pop()!;
    for (const dependency of dependencies(unit)) {
      if (visited.has(dependency)) continue;
      visited.add(dependency);
      stack.push(dependency);
    }
  }
  return visited;
}

interface SlicedSeed {
  seed: OutputSeed;
  guard: boolean;
  slice: Set<number>;
  fullSlice: Set<number>;
}

/**
 * Seeds in one group are one output: a function's return value, or one
 * field of it, no matter how many return statements produce it. Guard
 * exits stay separate so that `if (!x) return null;` is reported as a
 * guard rather than folded into the value.
 */
function mergeOutputs(sliced: readonly SlicedSeed[]): SliceCohesionOutput[] {
  const groups = new Map<string, SlicedSeed[]>();
  const guards: SlicedSeed[] = [];
  for (const entry of sliced) {
    if (entry.guard) {
      guards.push(entry);
      continue;
    }
    const members = groups.get(entry.seed.group) ?? [];
    members.push(entry);
    groups.set(entry.seed.group, members);
  }
  const order = new Map<string, number>();
  sliced.forEach((entry, index) => order.set(entry.seed.id, index));
  const outputs: { output: SliceCohesionOutput; order: number }[] = [];
  for (const entry of guards) outputs.push({ output: outputFrom([entry], true), order: order.get(entry.seed.id)! });
  for (const members of groups.values()) {
    outputs.push({
      output: outputFrom(members, false),
      order: Math.min(...members.map((member) => order.get(member.seed.id)!)),
    });
  }
  return outputs.sort((left, right) => left.order - right.order).map((entry) => entry.output);
}

function outputFrom(members: readonly SlicedSeed[], guard: boolean): SliceCohesionOutput {
  const first = [...members].sort((left, right) => left.seed.line - right.seed.line)[0]!;
  const slice = [...new Set(members.flatMap((member) => [...member.slice]))].sort(ascending);
  const fullSlice = [...new Set(members.flatMap((member) => [...member.fullSlice]))].sort(ascending);
  const units = [...new Set(members.map((member) => member.seed.unit))].sort(ascending);
  return {
    id: members.length === 1 ? first.seed.id : `${first.seed.label}@${first.seed.line + 1}`,
    kind: first.seed.kind,
    label: first.seed.label,
    line: first.seed.line,
    units,
    guard,
    hook: members.some((member) => member.seed.hook),
    sliceSize: slice.length,
    fullSliceSize: fullSlice.length,
    slice,
    fullSlice,
  };
}

function cohesionMetrics(outputs: readonly SliceCohesionOutput[], statementCount: number): SliceCohesionMetrics {
  if (outputs.length === 0 || statementCount === 0) {
    return { tightness: 0, fullTightness: 0, sliceShare: 0, fullSliceShare: 0, overlap: 0, superglue: 0, glue: 0 };
  }
  const intersection = intersectAll(outputs.map(sliceOf));
  const fullIntersection = intersectAll(outputs.map((output) => output.fullSlice ?? []));
  const fullCounts = new Map<number, number>();
  for (const output of outputs)
    for (const unit of output.fullSlice ?? []) fullCounts.set(unit, (fullCounts.get(unit) ?? 0) + 1);
  const mean = (values: number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    tightness: round(intersection.size / statementCount),
    fullTightness: round(fullIntersection.size / statementCount),
    sliceShare: round(mean(outputs.map((output) => output.sliceSize)) / statementCount),
    fullSliceShare: round(mean(outputs.map((output) => output.fullSliceSize)) / statementCount),
    overlap: round(mean(outputs.map((output) => (output.sliceSize === 0 ? 0 : intersection.size / output.sliceSize)))),
    superglue: fullIntersection.size,
    glue: [...fullCounts.values()].filter((count) => count >= 2).length,
  };
}

function intersectAll(slices: readonly (readonly number[])[]): Set<number> {
  if (slices.length === 0) return new Set();
  let result = new Set(slices[0]);
  for (const slice of slices.slice(1)) {
    const next = new Set(slice);
    result = new Set([...result].filter((unit) => next.has(unit)));
  }
  return result;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Shared setup: counted units that several value outputs read, that sit on
 * the straight-line path (under guard predicates at most), that are derived
 * only from the function's inputs and other shared setup, and that either
 * read nothing but inputs or feed at least half of the value outputs. They
 * are what an extraction would take as parameters. A predicate, a unit
 * inside a loop or branch, a container or state the body later writes, or
 * a unit that feeds only a few outputs is part of a computation instead,
 * so it keeps those outputs in one cluster.
 */
function sharedPreamble(
  outputs: readonly SliceCohesionOutput[],
  outputUnits: ReadonlySet<number>,
  body: BodyModel,
  flow: FlowModel,
): number[] {
  const counts = new Map<number, number>();
  for (const output of outputs) for (const unit of sliceOf(output)) counts.set(unit, (counts.get(unit) ?? 0) + 1);
  // A container the body fills (`const totals = []` before `totals.push`) is the computation's accumulator, not setup.
  const writtenLocals = new Set<string>();
  for (const writes of flow.writesByUnit.values()) for (const base of writes.local) writtenLocals.add(base);
  const candidates = new Set(
    [...counts]
      .filter(
        ([unit, count]) =>
          count >= 2 &&
          !outputUnits.has(unit) &&
          body.units[unit]!.kind !== 'predicate' &&
          ![...flow.definedNames[unit]!].some((name) => writtenLocals.has(name)) &&
          [...flow.controlDeps[unit]!].every((predicate) => body.guardPredicates.has(predicate)) &&
          (flow.dataDeps[unit]!.size === 0 || count >= outputs.length * PREAMBLE_OUTPUT_SHARE),
      )
      .map(([unit]) => unit),
  );
  const preamble = new Set<number>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const unit of candidates) {
      if (preamble.has(unit)) continue;
      if ([...flow.dataDeps[unit]!].every((dependency) => preamble.has(dependency))) {
        preamble.add(unit);
        changed = true;
      }
    }
  }
  return [...preamble].sort(ascending);
}

function clusterOutputs(
  outputs: readonly SliceCohesionOutput[],
  preamble: ReadonlySet<number>,
  body: BodyModel,
  flow: FlowModel,
  thresholds: Thresholds,
): SliceCohesionCluster[] {
  const reduced = outputs.map((output) => sliceOf(output).filter((unit) => !preamble.has(unit)));
  const parent = outputs.map((_output, index) => index);
  const find = (index: number): number => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]!]!;
      index = parent[index]!;
    }
    return index;
  };
  const owner = new Map<number, number>();
  reduced.forEach((slice, index) => {
    for (const unit of slice) {
      const existing = owner.get(unit);
      if (existing === undefined) owner.set(unit, index);
      else parent[find(index)] = find(existing);
    }
  });
  const groups = new Map<number, number[]>();
  outputs.forEach((_output, index) => {
    const root = find(index);
    const members = groups.get(root) ?? [];
    members.push(index);
    groups.set(root, members);
  });
  const clusters: SliceCohesionCluster[] = [];
  for (const members of groups.values()) {
    const units = [...new Set(members.flatMap((index) => reduced[index]!))].sort(ascending);
    if (units.length === 0) continue;
    const inputs = new Set<string>();
    const hooks: string[] = [];
    for (const unit of units) {
      for (const name of flow.paramReads[unit]!) inputs.add(name);
      for (const name of flow.outerReads[unit]!) inputs.add(name);
      for (const dependency of flow.dataDeps[unit]!) {
        if (preamble.has(dependency)) for (const name of flow.definedNames[dependency]!) inputs.add(name);
      }
      for (const hook of body.hookCalls.get(unit) ?? []) hooks.push(`${hook}@${body.units[unit]!.startLine + 1}`);
    }
    const clusterOutputRows = members.map((index) => outputs[index]!);
    const guardOnly = clusterOutputRows.every((output) => output.kind === 'throw');
    const lineRangeList = lineRanges(units.map((unit) => body.units[unit]!));
    const lines = lineRangeList.reduce((sum, range) => sum + range.endLine - range.startLine + 1, 0);
    const qualifying = units.length >= thresholds.minClusterUnits && !guardOnly && lines >= MIN_CLUSTER_LINES;
    clusters.push({
      outputs: clusterOutputRows.map((output) => output.id),
      units,
      lineRanges: lineRangeList,
      inputs: [...inputs].sort(),
      kind: clusterKind(
        clusterOutputRows,
        hooks,
        units.some((unit) => body.awaitUnits.has(unit)),
      ),
      role: qualifying ? 'extraction' : 'below-threshold',
      narrow: inputs.size <= MAX_SIGNAL_CLUSTER_INPUTS,
      hooks,
      guardOnly,
    });
  }
  clusters.sort((left, right) => right.units.length - left.units.length || compareFirstLine(left, right));
  const remainder = clusters.find((cluster) => cluster.role === 'extraction');
  if (remainder) remainder.role = 'remainder';
  return clusters;
}

function clusterKind(
  outputs: readonly SliceCohesionOutput[],
  hooks: readonly string[],
  awaits: boolean,
): SliceCohesionClusterKind {
  if (hooks.length > 0 || outputs.some((output) => output.hook)) return 'hook';
  const value = outputs.some((output) => output.kind === 'return' || output.kind === 'return-property');
  const effects = awaits || outputs.some((output) => output.kind === 'effect-call' || output.kind === 'mutation');
  if (!value) return 'effects';
  return effects ? 'operation' : 'calculation';
}

function compareFirstLine(left: SliceCohesionCluster, right: SliceCohesionCluster): number {
  return (left.lineRanges[0]?.startLine ?? 0) - (right.lineRanges[0]?.startLine ?? 0);
}

function lineRanges(units: readonly Unit[]): SliceCohesionLineRange[] {
  const ranges: SliceCohesionLineRange[] = [];
  for (const unit of [...units].sort((left, right) => left.startLine - right.startLine)) {
    const last = ranges[ranges.length - 1];
    if (last && unit.startLine <= last.endLine + 1) {
      last.endLine = Math.max(last.endLine, unit.endLine);
    } else {
      ranges.push({ startLine: unit.startLine, endLine: unit.endLine });
    }
  }
  return ranges;
}

// ── Reporting ───────────────────────────────────────────────────────

interface ReportContext {
  body: BodyModel;
  flow: FlowModel;
  thresholds: Thresholds;
  archetype: SliceCohesionArchetype;
  clusters: readonly SliceCohesionCluster[];
  preamble: readonly number[];
  orphans: readonly number[];
  guards: number;
  coverage: SliceCohesionCoverage;
}

function archetypeFor(body: BodyModel, valueOutputs: readonly SliceCohesionOutput[]): SliceCohesionArchetype {
  const name = callableLabel(body);
  if (body.react) return HOOK_NAME.test(name) ? 'react-hook' : 'react-component';
  if (
    valueOutputs.length >= MIN_ORCHESTRATION_OUTPUTS &&
    valueOutputs.every((output) => output.kind === 'effect-call')
  ) {
    return 'orchestration';
  }
  return 'calculation';
}

function tierFor(
  splitCandidate: boolean,
  archetype: SliceCohesionArchetype,
  clusters: readonly SliceCohesionCluster[],
  coverage: SliceCohesionCoverage,
): { tier: SliceCohesionActionTier; reason: string } {
  if (!splitCandidate)
    return { tier: 'support', reason: 'No split meets the selected output and statement thresholds.' };
  if (coverage.status !== 'complete') {
    return {
      tier: 'support',
      reason: `${archetype === 'orchestration' ? 'Orchestration root: disjoint slices are expected. ' : ''}Local flow is partial (${coverageGap(coverage)}), so a dropped dependency could join the clusters; the seam is unproven.`,
    };
  }
  if (archetype === 'orchestration') {
    return {
      tier: 'support',
      reason: 'The body matches an operation-sequencing pattern; disjoint slices alone do not justify splitting it.',
    };
  }
  const extractions = clusters.filter((cluster) => cluster.role === 'extraction');
  const narrow = extractions.filter((cluster) => cluster.narrow);
  if (narrow.length === 0) {
    return {
      tier: 'support',
      reason: `Local slices are disjoint, but each of the ${extractions.length} extraction(s) has more than ${MAX_SIGNAL_CLUSTER_INPUTS} observed input names.`,
    };
  }
  return {
    tier: 'signal',
    reason: `Local flow model complete; ${narrow.length} extraction(s) with at most ${MAX_SIGNAL_CLUSTER_INPUTS} observed input names; review captured state and ordering before planning an extraction.`,
  };
}

function coverageGap(coverage: SliceCohesionCoverage): string {
  return coverage.unsupported[0] ?? 'candidate dependencies or unsupported constructs present';
}

function evidenceReasons(
  statementCount: number,
  outputs: readonly SliceCohesionOutput[],
  metrics: SliceCohesionMetrics,
  context: ReportContext,
): string[] {
  const { body, flow, clusters, preamble, orphans, coverage } = context;
  const guards = outputs.filter((output) => output.guard).length;
  const reasons = [
    `${statementCount} statements, ${outputs.length - guards} value output(s), ${guards} guard exit(s); ${context.archetype}`,
    `tightness ${metrics.tightness.toFixed(2)} (with guards ${metrics.fullTightness.toFixed(2)}); overlap ${metrics.overlap.toFixed(2)}; local model only`,
  ];
  clusters
    .filter((cluster) => cluster.role !== 'below-threshold')
    .forEach((cluster, index) => {
      reasons.push(
        `cluster ${index + 1} (${cluster.kind}, ${cluster.role}): ${cluster.units.length} statements at ${describeRanges(cluster.lineRanges)} produce ${cluster.outputs.join(', ')}` +
          (cluster.role === 'extraction'
            ? cluster.inputs.length > 0
              ? `; takes ${listNames(cluster.inputs)}`
              : '; takes no parameters'
            : ''),
      );
    });
  const below = clusters.filter((cluster) => cluster.role === 'below-threshold' && !cluster.guardOnly);
  if (below.length > 0) {
    reasons.push(
      `${below.length} cluster(s) below --min-cluster ${context.thresholds.minClusterUnits} stay in place: ${below
        .map((cluster) => `${describeRanges(cluster.lineRanges)} (${cluster.outputs.join(', ')})`)
        .join('; ')}`,
    );
  }
  if (preamble.length > 0) {
    const names = [...new Set(preamble.flatMap((unit) => [...flow.definedNames[unit]!]))];
    reasons.push(
      `${preamble.length} shared setup statement(s) derived only from inputs` +
        (names.length > 0 ? `: ${listNames(names)}` : ''),
    );
  }
  if (orphans.length > 0) {
    const lines = [...new Set(orphans.map((unit) => body.units[unit]!.startLine + 1))];
    reasons.push(`${orphans.length} statement(s) reach no output: ${lines.map((line) => `line ${line}`).join(', ')}`);
  }
  const handled = [...body.handlerDeps.keys()].filter((unit) => COUNTED_KINDS.has(body.units[unit]!.kind)).length;
  if (handled > 0) reasons.push(`${handled} catch/finally statement(s) were kept with the try block they handle`);
  const stateWrites = [...new Set([...flow.stateWritesByUnit.values()].flat())];
  if (stateWrites.length > 0) {
    reasons.push(
      `state written at render time or in effects was treated as a dependency of later reads: ${listNames(stateWrites)}`,
    );
  }
  if (coverage.status !== 'complete') reasons.push(`local flow partial: ${coverageGap(coverage)}`);
  if (coverage.candidateEdges > 0) {
    reasons.push(
      `${coverage.candidateEdges} candidate flow edge(s) (closure capture or field flow) were treated as dependencies; they can merge clusters but never separate them`,
    );
  }
  return reasons;
}

function listNames(names: readonly string[], limit = 8): string {
  return names.length > limit ? `${names.slice(0, limit).join(', ')}, +${names.length - limit} more` : names.join(', ');
}

function describeRanges(ranges: readonly SliceCohesionLineRange[], limit = 6): string {
  const parts = ranges.map((range) =>
    range.startLine === range.endLine
      ? `line ${range.startLine + 1}`
      : `lines ${range.startLine + 1}-${range.endLine + 1}`,
  );
  return parts.length > limit
    ? `${parts.slice(0, limit).join(', ')}, +${parts.length - limit} more ranges`
    : parts.join(', ');
}

function recommendation(
  splitCandidate: boolean,
  outputs: readonly SliceCohesionOutput[],
  metrics: SliceCohesionMetrics,
  context: ReportContext,
): string {
  const { body, clusters, coverage, archetype } = context;
  const name = callableLabel(body);
  if (!splitCandidate) return wholeFunctionRecommendation(outputs, metrics, context);
  const extractions = clusters.filter((cluster) => cluster.role === 'extraction');
  const remainder = clusters.find((cluster) => cluster.role === 'remainder');
  const describeExtraction = (cluster: SliceCohesionCluster, index: number): string =>
    `${index + 1}) ${clusterKindLabel(cluster)}: ${describeRanges(cluster.lineRanges)} producing ${outputNames(cluster.outputs)}` +
    (cluster.inputs.length > 0 ? ` from (${listNames(cluster.inputs, 6)})` : ' from no parameters') +
    (cluster.narrow ? '' : ` [wide interface: ${cluster.inputs.length} parameters]`) +
    (cluster.hooks.length > 0 ? ` [hooks: ${listNames(cluster.hooks, 4)}]` : '');
  const seams = extractions.map(describeExtraction).join('; ');
  const stays = staysInPlace(context, remainder);
  if (coverage.status !== 'complete') {
    return `${archetype === 'orchestration' ? 'Preserve sequencing and treat it as an orchestration root. ' : ''}Inspect before extracting: local flow is partial (${coverageGap(coverage)}). Candidate seam(s): ${seams}. ${stays}`.trim();
  }
  if (archetype === 'orchestration') {
    return `${name} sequences ${extractions.length + 1} independent operations (${seams}); treat it as an orchestration root, not a cohesion defect, unless the steps serve unrelated purposes.`;
  }
  const advisory = extractions.every((cluster) => cluster.kind === 'effects')
    ? ' Advisory: an effect sequence may be intentional orchestration; confirm the steps serve a separate purpose before moving them.'
    : '';
  return `Review a possible extraction from ${name}: ${seams}. ${stays}${advisory}`.trim();
}

function wholeFunctionRecommendation(
  outputs: readonly SliceCohesionOutput[],
  metrics: SliceCohesionMetrics,
  context: ReportContext,
): string {
  const { clusters } = context;
  if (outputs.length === 0) return 'No value output was found; the body has nothing to slice.';
  if (outputs.length === 1) return 'One value output; cohesion is trivially complete.';
  const clustered = new Set(clusters.flatMap((cluster) => cluster.outputs));
  const setupOnly = outputs.filter((output) => !clustered.has(output.id)).length;
  const below = clusters.filter((cluster) => cluster.role === 'below-threshold' && !cluster.guardOnly);
  const parts: string[] = [];
  if (clusters.length === 0) {
    return (
      `The ${outputs.length} value outputs read only shared setup derived from the inputs (${context.preamble.length} statement(s)); nothing separates them` +
      '; keep the function whole.'
    );
  }
  parts.push(
    `The ${outputs.length} value outputs form ${clusters.length} cluster(s)` +
      (setupOnly > 0 ? `, and ${setupOnly} of them read only shared setup` : ''),
  );
  const whole = clusters.length === 1 ? clusters[0]! : null;
  if (whole && whole.outputs.length > 1) {
    parts.push(
      `${metrics.superglue} statement(s) feed every output and ${metrics.glue} feed more than one` +
        (metrics.superglue === 0
          ? '; the outputs are chained through shared statements, branch predicates, or state writes rather than one common root'
          : ''),
    );
  }
  if (below.length > 0) {
    parts.push(
      `${below.length} cluster(s) stay below --min-cluster ${context.thresholds.minClusterUnits}: ${below
        .map((cluster) => describeRanges(cluster.lineRanges, 2))
        .join('; ')}`,
    );
  }
  return `${parts.join('; ')}; keep the function whole.`;
}

function outputNames(ids: readonly string[], limit = 4): string {
  const names = ids.map((id) => id.replace(/@\d+$/u, ''));
  return names.length > limit ? `${names.slice(0, limit).join(', ')}, +${names.length - limit} more` : names.join(', ');
}

function staysInPlace(context: ReportContext, remainder: SliceCohesionCluster | undefined): string {
  const { flow, clusters, preamble, guards, thresholds } = context;
  const parts: string[] = [];
  if (remainder) {
    parts.push(
      `the largest computation (${describeRanges(remainder.lineRanges, 4)} producing ${outputNames(remainder.outputs)})`,
    );
  }
  if (preamble.length > 0) {
    const names = [...new Set(preamble.flatMap((unit) => [...flow.definedNames[unit]!]))];
    parts.push(`${preamble.length} shared setup statement(s)${names.length > 0 ? ` (${listNames(names, 4)})` : ''}`);
  }
  const below = clusters.filter((cluster) => cluster.role === 'below-threshold' && !cluster.guardOnly);
  if (below.length > 0)
    parts.push(`${below.length} smaller cluster(s) below --min-cluster ${thresholds.minClusterUnits}`);
  if (guards > 0) parts.push(`${guards} guard exit(s)`);
  return parts.length > 0 ? `Stays in place: ${parts.join(', ')}.` : '';
}

function clusterKindLabel(cluster: SliceCohesionCluster): string {
  switch (cluster.kind) {
    case 'calculation':
      return 'pure calculation candidate';
    case 'operation':
      return 'operation candidate (awaits or effects inside; not pure)';
    case 'hook':
      return 'custom hook candidate (hooks stay unconditional and in order)';
    case 'effects':
      return 'effect sequence candidate';
  }
}

function callableLabel(body: BodyModel): string {
  const name = body.callable.name;
  return name && 'text' in name ? String(name.text) : 'this function';
}
