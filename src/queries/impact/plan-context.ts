import type { ScipDatabase } from '../../storage/db.js';
import { getFileChurn } from '../../analysis/git-history.js';
import { getSuppressionInventory } from '../../analysis/suppressions.js';
import { affected, type AffectedResult } from '../graph/affected.js';
import { callGraph, type CallGraphResult } from '../navigation/call-graph.js';
import { changeSurface, type ChangeSurfaceResult } from './change-surface.js';
import { coChange } from './co-change.js';
import { complexity, type ComplexityResult } from '../quality/complexity.js';
import { dataflow, type DataflowResult } from '../navigation/dataflow.js';
import { deps, rdeps, type DepResult } from '../navigation/deps.js';
import { slice, type SliceResult } from '../navigation/slice.js';
import { surface, type SurfaceResult } from '../navigation/surface.js';
import { system, type SystemResult } from '../navigation/system.js';
import { trace, type TraceResult } from '../navigation/trace.js';

export interface PlanContextOptions {
  semantic?: boolean;
  impactDepth?: number;
  sliceDepth?: number;
  scope?: string;
}

/** Decision-time history risk for the target's file, from the change graph. */
export interface PlanContextHistory {
  /** False when git history is unavailable or no file could be resolved. */
  available: boolean;
  file: string | null;
  churn: { changes: number; fixChanges: number; lastChangedAt: number } | null;
  /** Files that usually change together with this one — edit checklist. */
  coChangePartners: Array<{ file: string; together: number; confidence: number }>;
  /** Detector suppressions present in the file — known accepted findings. */
  suppressionsInFile: number;
}

export interface PlanContextResult {
  target: string;
  matched: {
    symbol: boolean;
    file: boolean;
    module: boolean;
  };
  history: PlanContextHistory;
  trace: TraceResult;
  callGraph: CallGraphResult | null;
  complexity: ComplexityResult | null;
  dataflow: DataflowResult | null;
  backwardSlice: SliceResult | null;
  forwardSlice: SliceResult | null;
  affected: AffectedResult[];
  changeSurface: ChangeSurfaceResult | null;
  deps: DepResult[];
  rdeps: DepResult[];
  system: SystemResult;
  surface: SurfaceResult[];
  warnings: string[];
}

export function planContext(db: ScipDatabase, target: string, opts: PlanContextOptions = {}): PlanContextResult {
  const impactDepth = opts.impactDepth ?? 3;
  const sliceDepth = opts.sliceDepth ?? 3;
  const semantic = opts.semantic;
  const symbolTarget = !looksLikePathTarget(target);

  const traceResult = symbolTarget ? trace(db, target, { semantic }) : { definitions: [], referencedBy: [] };
  const callGraphResult = symbolTarget ? callGraph(db, target, { semantic }) : null;
  const complexityResult = symbolTarget ? complexity(db, target, { semantic }) : null;
  const dataflowResult = symbolTarget ? dataflow(db, target, { semantic }) : null;
  const backwardSliceResult = symbolTarget
    ? slice(db, target, {
        direction: 'backward',
        maxDepth: sliceDepth,
        semantic,
      })
    : null;
  const forwardSliceResult = symbolTarget
    ? slice(db, target, {
        direction: 'forward',
        maxDepth: sliceDepth,
        semantic,
      })
    : null;
  const affectedResults = symbolTarget
    ? affected(db, target, {
        maxDepth: impactDepth,
        scope: opts.scope,
      })
    : [];

  const changeSurfaceResult = changeSurface(db, target, { semantic });
  const depsResults = deps(db, target);
  const rdepsResults = rdeps(db, target);
  const systemResult = system(db, target);
  const surfaceResults = surface(db, target);

  const matched = {
    symbol:
      traceResult.definitions.length > 0 ||
      traceResult.referencedBy.length > 0 ||
      callGraphResult !== null ||
      complexityResult !== null ||
      dataflowResult !== null ||
      backwardSliceResult !== null ||
      forwardSliceResult !== null ||
      affectedResults.length > 0,
    file: changeSurfaceResult !== null || depsResults.length > 0 || rdepsResults.length > 0,
    module: systemResult.files.length > 0 || systemResult.symbols.length > 0 || surfaceResults.length > 0,
  };

  const warnings: string[] = [];
  if (!matched.symbol && !matched.file && !matched.module) {
    warnings.push('No symbol, file, or module matched target.');
  }

  const historyFile = changeSurfaceResult?.file ?? traceResult.definitions[0]?.relativePath ?? null;

  return {
    target,
    matched,
    history: buildPlanContextHistory(db, historyFile),
    trace: traceResult,
    callGraph: callGraphResult,
    complexity: complexityResult,
    dataflow: dataflowResult,
    backwardSlice: backwardSliceResult,
    forwardSlice: forwardSliceResult,
    affected: affectedResults,
    changeSurface: changeSurfaceResult,
    deps: depsResults,
    rdeps: rdepsResults,
    system: systemResult,
    surface: surfaceResults,
    warnings,
  };
}

function buildPlanContextHistory(db: ScipDatabase, file: string | null): PlanContextHistory {
  const unavailable: PlanContextHistory = {
    available: false,
    file,
    churn: null,
    coChangePartners: [],
    suppressionsInFile: 0,
  };
  if (!file) return unavailable;
  const churn = getFileChurn(db);
  if (!churn) return unavailable;

  const partners = coChange(db, file, { limit: 5 });
  return {
    available: true,
    file,
    churn: churn.get(file) ?? { changes: 0, fixChanges: 0, lastChangedAt: 0 },
    coChangePartners: partners.findings.map((finding) => ({
      file: finding.fileA === file ? finding.fileB : finding.fileA,
      together: finding.together,
      confidence: finding.confidence,
    })),
    suppressionsInFile: getSuppressionInventory(db).byFile.get(file) ?? 0,
  };
}

function looksLikePathTarget(target: string): boolean {
  return target.includes('/') || target.includes('\\') || /\.[A-Za-z0-9]+(?::\d+(?:-\d+)?)?$/.test(target);
}
