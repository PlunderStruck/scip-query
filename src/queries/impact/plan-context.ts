import type { ScipDatabase } from '../../storage/db.js';
import { profileSpan } from '../../instrumentation/profile.js';
import { gitEvidenceProduct } from '../../analysis/git-history.js';
import type { CoChangeSubjectContext } from '../../analysis/git-history.js';
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
  /** Already-resolved invocation HEAD for snapshot-consistent history evidence. */
  gitHead?: string;
}

/** Decision-time history risk for the target's file, from the change graph. */
export interface PlanContextHistory {
  /** False when git history is unavailable or no file could be resolved. */
  available: boolean;
  file: string | null;
  churn: { changes: number; fixChanges: number; lastChangedAt: number } | null;
  /** Files that usually change together with this one — edit checklist. */
  coChangePartners: Array<{
    file: string;
    together: number;
    confidence: number;
    subjectContext: CoChangeSubjectContext;
  }>;
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

  const traceResult = symbolTarget
    ? profilePlanContextComponent(
        'trace',
        target,
        () => trace(db, target, { semantic }),
        (result) => ({
          definitions: result.definitions.length,
          references: result.referencedBy.length,
        }),
      )
    : { definitions: [], referencedBy: [] };
  const callGraphResult = symbolTarget
    ? profilePlanContextComponent(
        'call-graph',
        target,
        () => callGraph(db, target, { semantic }),
        (result) => ({
          callers: result?.callers.length ?? 0,
          callees: result?.callees.length ?? 0,
        }),
      )
    : null;
  const complexityResult = symbolTarget
    ? profilePlanContextComponent(
        'complexity',
        target,
        () => complexity(db, target, { semantic }),
        (result) => ({
          callees: result?.calleeCount ?? 0,
        }),
      )
    : null;
  const dataflowResult = symbolTarget
    ? profilePlanContextComponent(
        'dataflow',
        target,
        () => dataflow(db, target, { semantic }),
        (result) => ({
          references: result?.usageSites.length ?? 0,
          producers: result?.producers.length ?? 0,
          consumers: result?.consumers.length ?? 0,
        }),
      )
    : null;
  const backwardSliceResult = symbolTarget
    ? profilePlanContextComponent(
        'backward-slice',
        target,
        () =>
          slice(db, target, {
            direction: 'backward',
            maxDepth: sliceDepth,
            semantic,
          }),
        (result) => ({ maxDepth: sliceDepth, connectedSymbols: result?.connectedSymbols.length ?? 0 }),
      )
    : null;
  const forwardSliceResult = symbolTarget
    ? profilePlanContextComponent(
        'forward-slice',
        target,
        () =>
          slice(db, target, {
            direction: 'forward',
            maxDepth: sliceDepth,
            semantic,
          }),
        (result) => ({ maxDepth: sliceDepth, connectedSymbols: result?.connectedSymbols.length ?? 0 }),
      )
    : null;
  const affectedResults = symbolTarget
    ? profilePlanContextComponent(
        'affected',
        target,
        () =>
          affected(db, target, {
            maxDepth: impactDepth,
            scope: opts.scope,
          }),
        (result) => ({ maxDepth: impactDepth, affectedSymbols: result.length }),
      )
    : [];

  const changeSurfaceResult = profilePlanContextComponent(
    'change-surface',
    target,
    () => changeSurface(db, target, { semantic }),
    (result) => ({ symbols: result?.symbols.length ?? 0, externalConsumers: result?.totalExternalConsumers ?? 0 }),
  );
  const systemResult = profilePlanContextComponent(
    'system',
    target,
    () => system(db, target),
    (result) => ({
      files: result.files.length,
      symbols: result.symbols.length,
    }),
  );
  const reuseSystemEdges = systemResult.files.length === 1;
  const depsResults = profilePlanContextComponent(
    'deps',
    target,
    () => (reuseSystemEdges ? systemResult.dependsOn.map((relativePath) => ({ relativePath })) : deps(db, target)),
    (result) => ({
      files: result.length,
      reusedSystem: reuseSystemEdges,
    }),
  );
  const rdepsResults = profilePlanContextComponent(
    'rdeps',
    target,
    () => (reuseSystemEdges ? systemResult.dependedOnBy.map((relativePath) => ({ relativePath })) : rdeps(db, target)),
    (result) => ({
      files: result.length,
      reusedSystem: reuseSystemEdges,
    }),
  );
  const surfaceResults = profilePlanContextComponent(
    'surface',
    target,
    () => surface(db, target),
    (result) => ({
      consumers: result.length,
    }),
  );

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
    history: profilePlanContextComponent('history', historyFile ?? target, () =>
      buildPlanContextHistory(db, historyFile, opts.gitHead),
    ),
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

function profilePlanContextComponent<T>(
  component: string,
  target: string,
  run: () => T,
  cardinality: (result: T) => Record<string, unknown> = () => ({}),
): T {
  let result: T;
  return profileSpan(
    `plan-context.${component}`,
    () => {
      result = run();
      return result;
    },
    () => ({ target, ...cardinality(result!) }),
  );
}

function buildPlanContextHistory(db: ScipDatabase, file: string | null, gitHead?: string): PlanContextHistory {
  const unavailable: PlanContextHistory = {
    available: false,
    file,
    churn: null,
    coChangePartners: [],
    suppressionsInFile: 0,
  };
  if (!file) return unavailable;
  const git = gitEvidenceProduct(db, gitHead ? { head: gitHead } : {});
  const churn = profilePlanContextComponent(
    'history.churn',
    file,
    () => git.fileChurn(),
    (result) => ({
      files: result?.size ?? 0,
    }),
  );
  if (!churn) return unavailable;

  const partners = profilePlanContextComponent(
    'history.co-change',
    file,
    () => coChange(db, file, { limit: 5, ...(gitHead ? { head: gitHead } : {}) }),
    (result) => ({
      commits: result.commitsAnalyzed,
      partners: result.findings.length,
    }),
  );
  const suppressionsInFile = profilePlanContextComponent(
    'history.suppressions',
    file,
    () => getSuppressionInventory(db).byFile.get(file) ?? 0,
    (result) => ({ suppressions: result }),
  );
  return {
    available: true,
    file,
    churn: churn.get(file) ?? { changes: 0, fixChanges: 0, lastChangedAt: 0 },
    coChangePartners: partners.findings.map((finding) => ({
      file: finding.fileA === file ? finding.fileB : finding.fileA,
      together: finding.together,
      confidence: finding.confidence,
      subjectContext: finding.subjectContext,
    })),
    suppressionsInFile,
  };
}

function looksLikePathTarget(target: string): boolean {
  return target.includes('/') || target.includes('\\') || /\.[A-Za-z0-9]+(?::\d+(?:-\d+)?)?$/.test(target);
}
