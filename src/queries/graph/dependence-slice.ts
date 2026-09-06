import type { ScipDatabase } from '../../storage/db.js';
import { semanticLocalFlowForRange } from '../../semantic/local-flow.js';
import type {
  TypeScriptLocalFlowCoverage,
  TypeScriptLocalFlowEdge,
  TypeScriptLocalFlowPoint,
} from '../../semantic/local-flow.js';

export type DependenceSliceDirection = 'backward' | 'forward';
export interface DependenceSliceEdge extends TypeScriptLocalFlowEdge {
  traversalDepth: number;
}
export interface DependenceSliceCoverage {
  status: 'complete' | 'bounded' | 'incomplete';
  basis: 'function-local-dependence';
  model: TypeScriptLocalFlowCoverage;
  omittedEdges: number;
  omittedPoints: number;
  depthLimited: boolean;
  candidateEdges: number;
}
export interface DependenceSliceResult {
  kind: 'dependence-slice';
  direction: DependenceSliceDirection;
  criterion: string;
  variable?: string;
  resolution: 'matched' | 'ambiguous' | 'missing' | 'unsupported';
  /** Exact source candidates; narrow an ambiguous read with --variable and --column. */
  candidates: TypeScriptLocalFlowPoint[];
  /** Offsets, lines, and columns use the compiler's zero-based source coordinates. */
  points: TypeScriptLocalFlowPoint[];
  edges: DependenceSliceEdge[];
  coverage: DependenceSliceCoverage;
}

/**
 * Slice one variable occurrence through compiler-local value and control dependencies.
 * The public location and optional column are one-based. Calls are not traversed;
 * closure ordering, heap effects, and every provider limitation remain unproved.
 */
export function dependenceSlice(
  db: ScipDatabase,
  criterion: string,
  options: {
    variable?: string;
    column?: number;
    direction?: DependenceSliceDirection;
    maxDepth?: number;
    maxEdges?: number;
  } = {},
): DependenceSliceResult {
  const { file, line, maxDepth, maxEdges, direction } = parseSliceRequest(criterion, options);
  const flow = semanticLocalFlowForRange(db, file, line - 1, line - 1);
  const model: TypeScriptLocalFlowCoverage = flow?.coverage ?? {
    status: 'unsupported',
    basis: 'typescript-compiler-cfg-reaching-definitions',
    unsupported: ['Function-local slicing currently requires TypeScript or JavaScript source.'],
  };
  const candidates = selectSliceCriteria(flow?.points ?? [], line, options);
  const resolution =
    model.status === 'unsupported'
      ? 'unsupported'
      : candidates.length === 1
        ? 'matched'
        : candidates.length > 1
          ? 'ambiguous'
          : 'missing';
  const result: DependenceSliceResult = {
    kind: 'dependence-slice',
    direction,
    criterion,
    ...(options.variable !== undefined ? { variable: options.variable } : {}),
    resolution,
    candidates,
    points: [],
    edges: [],
    coverage: {
      status: 'incomplete',
      basis: 'function-local-dependence',
      model,
      omittedEdges: 0,
      omittedPoints: 0,
      depthLimited: false,
      candidateEdges: 0,
    },
  };
  const root = candidates[0];
  if (resolution !== 'matched' || !root || !flow) return result;
  const points = new Map(flow.points.map((point) => [point.id, point]));
  const adjacent = exactLocalAdjacency(flow, points, root.callableId, direction);
  const { selected, reached, depthFrontier } = traverseDependenceSlice(adjacent, root.id, direction, maxDepth);
  result.edges = [...selected.values()].slice(0, maxEdges);
  const rendered = new Set([root.id, ...result.edges.flatMap((edge) => [edge.fromPointId, edge.toPointId])]);
  result.points = [...rendered]
    .map((id) => points.get(id)!)
    .sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
  const omittedEdges = selected.size - result.edges.length;
  const depthLimited = depthFrontier.size > 0;
  result.coverage = {
    status: model.status !== 'complete' ? 'incomplete' : omittedEdges > 0 || depthLimited ? 'bounded' : 'complete',
    basis: 'function-local-dependence',
    model,
    omittedEdges,
    omittedPoints: reached.size - rendered.size,
    depthLimited,
    candidateEdges: flow.edges.filter(
      (edge) => edge.strength === 'candidate' && (reached.has(edge.fromPointId) || reached.has(edge.toPointId)),
    ).length,
  };
  return result;
}

type SliceOptions = NonNullable<Parameters<typeof dependenceSlice>[2]>;

function parseSliceRequest(criterion: string, options: SliceOptions) {
  const location = /^(.*):([1-9]\d*)$/u.exec(criterion);
  if (!location)
    throw new Error(
      'A dependence slice requires an exact file:line, with --variable or --column when ambiguous. Use evidence for symbol relationships.',
    );
  const line = Number(location[2]);
  const maxDepth = options.maxDepth ?? Number.MAX_SAFE_INTEGER;
  const maxEdges = options.maxEdges ?? 200;
  validateSliceNumbers(line, options.column, maxDepth, maxEdges);
  const direction = options.direction ?? 'backward';
  if (direction !== 'backward' && direction !== 'forward')
    throw new Error('Slice direction must be backward or forward.');
  return { file: location[1]!, line, maxDepth, maxEdges, direction };
}

function validateSliceNumbers(line: number, column: number | undefined, maxDepth: number, maxEdges: number): void {
  for (const [name, value] of [
    ['line', line],
    ['depth', maxDepth],
    ['max-edges', maxEdges],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < (name === 'line' ? 1 : 0))
      throw new RangeError(`Invalid slice ${name}: ${value}.`);
  }
  if (column !== undefined && (!Number.isSafeInteger(column) || column < 1))
    throw new RangeError('Slice column must be a positive safe integer.');
}

function selectSliceCriteria(
  points: readonly TypeScriptLocalFlowPoint[],
  line: number,
  options: SliceOptions,
): TypeScriptLocalFlowPoint[] {
  let candidates = points.filter(
    (point) =>
      point.line === line - 1 &&
      ['use', 'definition', 'parameter-definition'].includes(point.kind) &&
      (options.variable === undefined || point.name === options.variable),
  );
  if (options.column !== undefined) {
    const column = options.column - 1;
    candidates = candidates.filter(
      (point) => column >= point.column && column < point.column + point.end - point.start,
    );
    const smallest = Math.min(...candidates.map((point) => point.end - point.start));
    candidates = candidates.filter((point) => point.end - point.start === smallest);
  }
  return candidates;
}

function exactLocalAdjacency(
  flow: NonNullable<ReturnType<typeof semanticLocalFlowForRange>>,
  points: ReadonlyMap<string, TypeScriptLocalFlowPoint>,
  callableId: string,
  direction: DependenceSliceDirection,
): Map<string, TypeScriptLocalFlowEdge[]> {
  const adjacent = new Map<string, TypeScriptLocalFlowEdge[]>();
  for (const edge of flow.edges) {
    if (
      edge.strength !== 'exact' ||
      points.get(edge.fromPointId)?.callableId !== callableId ||
      points.get(edge.toPointId)?.callableId !== callableId
    )
      continue;
    const id = direction === 'backward' ? edge.toPointId : edge.fromPointId;
    const rows = adjacent.get(id) ?? [];
    rows.push(edge);
    adjacent.set(id, rows);
  }
  return adjacent;
}

function traverseDependenceSlice(
  adjacent: ReadonlyMap<string, readonly TypeScriptLocalFlowEdge[]>,
  rootId: string,
  direction: DependenceSliceDirection,
  maxDepth: number,
) {
  const reached = new Set([rootId]);
  const selected = new Map<string, DependenceSliceEdge>();
  const queue = [{ id: rootId, depth: 0 }];
  const depthFrontier = new Set<string>();
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index]!;
    const edges = adjacent.get(current.id) ?? [];
    if (current.depth >= maxDepth) {
      for (const edge of edges) depthFrontier.add(edge.id);
      continue;
    }
    for (const edge of edges) {
      // Each edge belongs to one traversal source, and each source is queued once.
      selected.set(edge.id, { ...edge, traversalDepth: current.depth + 1 });
      const next = direction === 'backward' ? edge.fromPointId : edge.toPointId;
      if (!reached.has(next)) {
        reached.add(next);
        queue.push({ id: next, depth: current.depth + 1 });
      }
    }
  }
  for (const id of selected.keys()) depthFrontier.delete(id);
  return { selected, reached, depthFrontier };
}
