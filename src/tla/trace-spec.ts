import { copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { TlaTraceStep } from './model-contract.js';
import { runTlaTool, type TlaToolResult, type TlaToolRunOptions } from './tool-runner.js';

/**
 * TLA P2 trace validation: check that a recorded execution trace is a
 * behavior of the model's next-state relation, not merely consistent with
 * declared write sets.
 *
 * Encoding (standard TLA+ trace-validation shape): a generated module
 * extends the base spec, pins the state sequence observed at runtime, and
 * requires the base next-state operator (default `Next`, overridable via
 * `--next` for dual-spec models with e.g. `NextCurrent`/`NextVulnerable`)
 * to hold between consecutive states. TLC deadlocks exactly at the first
 * divergent step, which we parse back into a step-indexed verdict.
 */

export interface TraceSpecGeneration {
  moduleName: string;
  moduleText: string;
  cfgText: string;
  /** Variables included in the pinned states. */
  variables: string[];
  /** Variables dropped because a value was not scalar-encodable. */
  skippedVariables: string[];
  states: number;
  warnings: string[];
}

/** Per-mapped-action step count for a trace (P5.6 / followup #15). */
export interface TraceActionCoverage {
  action: string;
  stepsObserved: number;
}

export interface TraceCheckVerdict {
  status: 'accepted' | 'diverged' | 'unavailable' | 'invalid-trace';
  states: number;
  /** 1-based index of the last trace state TLC reached before divergence. */
  divergedAtState?: number;
  /** The trace step (0-based into the input steps) that could not be taken. */
  divergedStep?: { index: number; action: string };
  detail: string;
  checker?: TlaToolResult;
  generation?: TraceSpecGeneration;
  /**
   * Steps observed per mapped action, in mapping order. An action with
   * `stepsObserved: 0` was never exercised by this trace — it is either a
   * pure modeling abstraction (expected, no code twin) or a real coverage
   * gap; the caller must classify which.
   */
  actionCoverage: TraceActionCoverage[];
}

/** Counts trace steps per mapped action; unexercised actions still appear with 0. */
export function computeTraceActionCoverage(
  mappedActions: readonly string[],
  steps: readonly TlaTraceStep[],
): TraceActionCoverage[] {
  const counts = new Map<string, number>();
  for (const step of steps) counts.set(step.action, (counts.get(step.action) ?? 0) + 1);
  return mappedActions.map((action) => ({ action, stepsObserved: counts.get(action) ?? 0 }));
}

type TlaScalar = string | number | boolean | readonly (string | number | boolean)[];

export function generateTraceSpec(
  baseModuleName: string,
  mappedVariables: readonly string[],
  steps: readonly TlaTraceStep[],
  nextOperator = 'Next',
): TraceSpecGeneration | { error: string } {
  if (steps.length === 0) return { error: 'trace has no steps' };
  const warnings: string[] = [];

  // Reconstruct the full state sequence: state 0 is the first step's
  // `before`, each subsequent state overlays the step's `after`.
  const first = steps[0]!;
  if (!first.before) return { error: 'trace step 0 must include a full `before` state' };

  const states: Record<string, TlaScalar>[] = [];
  const current: Record<string, unknown> = { ...first.before };
  const encodable = (record: Record<string, unknown>): Record<string, TlaScalar> => {
    const out: Record<string, TlaScalar> = {};
    for (const [key, value] of Object.entries(record)) {
      if (!mappedVariables.includes(key)) continue;
      const scalar = asTlaScalar(value);
      if (scalar !== undefined) out[key] = scalar;
    }
    return out;
  };

  states.push(encodable(current));
  for (const step of steps) {
    if (step.before) {
      for (const [key, value] of Object.entries(step.before)) {
        if (!(key in current)) current[key] = value;
      }
    }
    Object.assign(current, step.after ?? {});
    states.push(encodable(current));
  }

  const variables = mappedVariables.filter((name) => states.every((state) => name in state));
  const skippedVariables = mappedVariables.filter((name) => !variables.includes(name));
  if (variables.length === 0) {
    return { error: 'no mapped variable had a scalar-encodable value in every trace state' };
  }
  if (skippedVariables.length > 0) {
    warnings.push(
      `variables not pinned by the trace (missing or non-scalar values): ${skippedVariables.join(', ')} — ` +
        'divergence in these variables is NOT checked.',
    );
  }

  const moduleName = `${baseModuleName}Trace`;
  const records = states
    .map((state) => `  [${variables.map((name) => `${name} |-> ${renderTlaValue(state[name]!)}`).join(', ')}]`)
    .join(',\n');

  const moduleText = [
    `---- MODULE ${moduleName} ----`,
    `\\* Generated trace-validation harness. Checks that the recorded execution`,
    `\\* is a behavior of ${baseModuleName}!${nextOperator}. TLC deadlocks at the first`,
    `\\* divergent step; a clean run means the model accepts the trace.`,
    `EXTENDS ${baseModuleName}, Naturals, Sequences`,
    '',
    'VARIABLE traceIdx',
    '',
    'TraceStates ==',
    '<<',
    records,
    '>>',
    '',
    'TraceInit ==',
    '  /\\ traceIdx = 1',
    ...variables.map((name) => `  /\\ ${name} = TraceStates[1].${name}`),
    '',
    'TraceStep ==',
    '  /\\ traceIdx < Len(TraceStates)',
    "  /\\ traceIdx' = traceIdx + 1",
    `  /\\ ${nextOperator}`,
    ...variables.map((name) => `  /\\ ${name}' = TraceStates[traceIdx + 1].${name}`),
    '',
    'TraceDone ==',
    '  /\\ traceIdx = Len(TraceStates)',
    '  /\\ UNCHANGED <<vars, traceIdx>>',
    '',
    'TraceNext == TraceStep \\/ TraceDone',
    '',
    'TraceSpec == TraceInit /\\ [][TraceNext]_<<vars, traceIdx>>',
    '',
    '\\* Reaching the last pinned state means the model accepted every step.',
    'TraceProgress == traceIdx \\in 1..Len(TraceStates)',
    '====',
    '',
  ].join('\n');

  const cfgText = ['SPECIFICATION TraceSpec', 'INVARIANT TraceProgress', ''].join('\n');
  return { moduleName, moduleText, cfgText, variables, skippedVariables, states: states.length, warnings };
}

export function runTraceCheck(opts: {
  specPath: string;
  baseModuleName: string;
  mappedVariables: readonly string[];
  /** All mapped action names, for per-action coverage reporting (P5.6). */
  mappedActions?: readonly string[];
  steps: readonly TlaTraceStep[];
  /** Next-state operator the harness requires between states (default `Next`). */
  nextOperator?: string;
  toolOptions: Omit<TlaToolRunOptions, 'specPath' | 'configPath' | 'checker'>;
}): TraceCheckVerdict {
  const mappedActions = opts.mappedActions ?? [];
  // C2: coverage counts only steps TLC actually proved were legal
  // transitions — an unchecked or rejected trace step is not evidence that
  // its action's code twin was exercised correctly, so it must not inflate
  // coverage. `acceptedSteps` is computed per branch below.
  const generation = generateTraceSpec(opts.baseModuleName, opts.mappedVariables, opts.steps, opts.nextOperator);
  if ('error' in generation) {
    return {
      status: 'invalid-trace',
      states: 0,
      detail: generation.error,
      actionCoverage: computeTraceActionCoverage(mappedActions, []),
    };
  }

  // TLC resolves EXTENDS from the working directory: copy the spec's sibling
  // .tla modules and the generated harness into an isolated temp dir.
  const workDir = mkdtempSync(join(tmpdir(), 'scip-tla-trace-'));
  try {
    const specDir = dirname(opts.specPath);
    for (const entry of readdirSync(specDir)) {
      if (entry.endsWith('.tla')) copyFileSync(join(specDir, entry), join(workDir, entry));
    }
    const harnessPath = join(workDir, `${generation.moduleName}.tla`);
    const cfgPath = join(workDir, `${generation.moduleName}.cfg`);
    writeFileSync(harnessPath, generation.moduleText);
    writeFileSync(cfgPath, generation.cfgText);

    const checker = runTlaTool({
      ...opts.toolOptions,
      specPath: harnessPath,
      configPath: cfgPath,
      checker: 'tlc',
    });

    if (checker.status === 'skipped') {
      return {
        status: 'unavailable',
        states: generation.states,
        detail: checker.diagnostics[0]?.message ?? 'model checker unavailable',
        checker,
        generation,
        actionCoverage: computeTraceActionCoverage(mappedActions, []),
      };
    }
    if (checker.status === 'passed') {
      return {
        status: 'accepted',
        states: generation.states,
        detail: `TLC accepted all ${generation.states} pinned states under ${opts.baseModuleName}!${opts.nextOperator ?? 'Next'}.`,
        checker,
        generation,
        actionCoverage: computeTraceActionCoverage(mappedActions, opts.steps),
      };
    }

    const divergence = parseDivergence(checker.stdout, opts.steps);
    // Steps before the divergent one transitioned legally (TLC reached
    // that state); the divergent step's own attempted transition was
    // rejected, so it is excluded from coverage along with everything
    // after it.
    const acceptedSteps = divergence ? opts.steps.slice(0, divergence.divergedStep!.index) : [];
    return {
      status: 'diverged',
      states: generation.states,
      ...(divergence ?? {}),
      detail: divergence
        ? `trace diverges entering state ${divergence.divergedAtState! + 1} (step ${divergence.divergedStep!.index}: ` +
          `${divergence.divergedStep!.action}) — the model's ${opts.nextOperator ?? 'Next'} relation does not accept the recorded transition.`
        : 'TLC rejected the trace but the divergent step could not be parsed from its output; see checker stdout.',
      checker,
      generation,
      actionCoverage: computeTraceActionCoverage(mappedActions, acceptedSteps),
    };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function parseDivergence(
  stdout: string,
  steps: readonly TlaTraceStep[],
): Pick<TraceCheckVerdict, 'divergedAtState' | 'divergedStep'> | null {
  // TLC deadlock output ends with a state dump containing `traceIdx = k`;
  // the deepest k printed is the last accepted pinned state.
  let deepest: number | null = null;
  for (const match of stdout.matchAll(/\btraceIdx = (\d+)/g)) {
    const value = Number.parseInt(match[1]!, 10);
    if (deepest === null || value > deepest) deepest = value;
  }
  if (deepest === null || !/deadlock/i.test(stdout)) return null;
  const stepIndex = deepest - 1; // step k transitions state k -> k+1 (1-based states)
  const step = steps[stepIndex];
  return {
    divergedAtState: deepest,
    divergedStep: { index: stepIndex, action: step?.action ?? 'unknown' },
  };
}

function asTlaScalar(value: unknown): TlaScalar | undefined {
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (Array.isArray(value)) {
    const items: (string | number | boolean)[] = [];
    for (const item of value) {
      if (typeof item === 'string' || typeof item === 'boolean') items.push(item);
      else if (typeof item === 'number' && Number.isInteger(item)) items.push(item);
      else return undefined;
    }
    return items;
  }
  return undefined;
}

function renderTlaValue(value: TlaScalar): string {
  if (typeof value === 'string') return `"${value.replace(/"/g, '\\"')}"`;
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'number') return String(value);
  return `<<${value.map((item) => renderTlaValue(item)).join(', ')}>>`;
}

export function traceHarnessBaseName(specPath: string): string {
  return basename(specPath).replace(/\.tla$/i, '');
}
