import { readFileSync } from 'node:fs';

export type ProfileWorkOutcome = 'computed' | 'cache-hit' | 'cache-miss' | 'reused' | 'skipped';

// scip-query: ignore-stale — reviewed S1 owned contract; profile parsing materializes this event record.
export interface ProfileEvent {
  [field: string]: unknown;
}

export interface ProfileWorkAuditRow {
  spanName: string;
  workIdentity: string;
  commands: string[];
  computations: number;
  runCount: number;
  repeatComputations: number;
  withinRunRepeats: number;
  crossRunRecomputes: number;
  totalComputeMs: number;
  firstComputeMs: number;
  withinRunAvoidableMs: number;
  crossRunRecomputeMs: number;
  estimatedAvoidableMs: number;
  cacheHits: number;
  cacheMisses: number;
  reused: number;
  skipped: number;
}

export interface ProfileWorkloadAuditRow {
  subsystem: string;
  spanName: string;
  subsystemWorkIdentity: string;
  commands: string[];
  runCount: number;
  totalEvents: number;
  firstRunEvents: number;
  laterRunEvents: number;
  totalDurationMs: number;
  firstRunMs: number;
  laterRunMs: number;
}

export interface ProfileSubsystemCoverageRow {
  subsystem: string;
  events: number;
  totalDurationMs: number;
  spanNames: string[];
  workloadIdentifiedEvents: number;
  workloadIdentifiedSpanNames: number;
  exactIdentifiedEvents: number;
  exactIdentifiedSpanNames: number;
}

export interface ProfileWorkAuditReport {
  profileEvents: number;
  spanEvents: number;
  distinctSpanNames: number;
  instrumentedEvents: number;
  unclassifiedInstrumentedEvents: number;
  exactIdentifiedSpanNames: number;
  workloadIdentifiedEvents: number;
  workloadIdentifiedSpanNames: number;
  runCount: number;
  repeatedGroups: number;
  largestOpportunityMs: number;
  rows: ProfileWorkAuditRow[];
  repeatedWorkloads: number;
  largestRepeatedWorkloadMs: number;
  workloadRows: ProfileWorkloadAuditRow[];
  subsystemCoverage: ProfileSubsystemCoverageRow[];
}

interface WorkObservation {
  runId: string;
  command: string;
  durationMs: number;
  outcome: ProfileWorkOutcome;
}

interface WorkGroup {
  spanName: string;
  workIdentity: string;
  observations: WorkObservation[];
}

interface WorkloadObservation {
  runId: string;
  command: string;
  durationMs: number;
}

interface WorkloadGroup {
  subsystem: string;
  spanName: string;
  subsystemWorkIdentity: string;
  observations: WorkloadObservation[];
}

interface SubsystemCoverageAccumulator {
  subsystem: string;
  events: number;
  totalDurationMs: number;
  spanNames: Set<string>;
  workloadIdentifiedEvents: number;
  workloadIdentifiedSpanNames: Set<string>;
  exactIdentifiedEvents: number;
  exactIdentifiedSpanNames: Set<string>;
}

export function readProfileEvents(path: string): ProfileEvent[] {
  const events: ProfileEvent[] = [];
  for (const [index, rawLine] of readFileSync(path, 'utf8').split('\n').entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw new Error(
        `${path}:${index + 1}: invalid profile JSON: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`${path}:${index + 1}: profile event must be a JSON object`);
    }
    events.push(value as ProfileEvent);
  }
  return events;
}

export function auditProfileWork(events: readonly ProfileEvent[], opts: { top?: number } = {}): ProfileWorkAuditReport {
  const exactGroups = new Map<string, WorkGroup>();
  const workloadGroups = new Map<string, WorkloadGroup>();
  const coverageBySubsystem = new Map<string, SubsystemCoverageAccumulator>();
  const runIds = new Set<string>();
  const spanNames = new Set<string>();
  const exactSpanNames = new Set<string>();
  const workloadSpanNames = new Set<string>();
  let spanEvents = 0;
  let instrumentedEvents = 0;
  let unclassifiedInstrumentedEvents = 0;

  for (const [index, event] of events.entries()) {
    const spanName = stringValue(event['name']) ?? stringValue(event['phase']);
    const durationMs = finiteNumber(event['durationMs']);
    const explicitRunId = stringValue(event['runId']);
    if (spanName && durationMs !== null) {
      spanEvents += 1;
      spanNames.add(spanName);
      if (explicitRunId) runIds.add(explicitRunId);
      recordCoverage(coverageBySubsystem, event, spanName, durationMs);
      recordWorkloadObservation(workloadGroups, event, spanName, durationMs, explicitRunId);
      if (stringValue(event['subsystemWorkIdentity'])) workloadSpanNames.add(spanName);
    }

    const workIdentity = stringValue(event['workIdentity']);
    if (!workIdentity) continue;
    instrumentedEvents += 1;
    if (spanName) exactSpanNames.add(spanName);
    const outcome = profileWorkOutcome(event['workOutcome']);
    if (!spanName || durationMs === null || !outcome) {
      unclassifiedInstrumentedEvents += 1;
      continue;
    }

    const runId = explicitRunId ?? `unknown-run-${index}`;
    const key = JSON.stringify([spanName, workIdentity]);
    const group = exactGroups.get(key) ?? { spanName, workIdentity, observations: [] };
    group.observations.push({
      runId,
      command: stringValue(event['command']) ?? 'unknown',
      durationMs,
      outcome,
    });
    exactGroups.set(key, group);
  }

  const repeatedRows = [...exactGroups.values()]
    .map(summarizeWorkGroup)
    .filter((row): row is ProfileWorkAuditRow => row !== null)
    .sort(
      (left, right) =>
        right.estimatedAvoidableMs - left.estimatedAvoidableMs ||
        right.repeatComputations - left.repeatComputations ||
        left.spanName.localeCompare(right.spanName) ||
        left.workIdentity.localeCompare(right.workIdentity),
    );
  const workloadRows = [...workloadGroups.values()]
    .map(summarizeWorkloadGroup)
    .filter((row): row is ProfileWorkloadAuditRow => row !== null)
    .sort(
      (left, right) =>
        right.laterRunMs - left.laterRunMs ||
        right.laterRunEvents - left.laterRunEvents ||
        left.spanName.localeCompare(right.spanName),
    );
  const subsystemCoverage = [...coverageBySubsystem.values()]
    .map(finalizeSubsystemCoverage)
    .sort(
      (left, right) => right.totalDurationMs - left.totalDurationMs || left.subsystem.localeCompare(right.subsystem),
    );
  const top = opts.top ?? 20;

  return {
    profileEvents: events.length,
    spanEvents,
    distinctSpanNames: spanNames.size,
    instrumentedEvents,
    unclassifiedInstrumentedEvents,
    exactIdentifiedSpanNames: exactSpanNames.size,
    workloadIdentifiedEvents: subsystemCoverage.reduce((total, row) => total + row.workloadIdentifiedEvents, 0),
    workloadIdentifiedSpanNames: workloadSpanNames.size,
    runCount: runIds.size,
    repeatedGroups: repeatedRows.length,
    largestOpportunityMs: repeatedRows[0]?.estimatedAvoidableMs ?? 0,
    rows: repeatedRows.slice(0, top),
    repeatedWorkloads: workloadRows.length,
    largestRepeatedWorkloadMs: workloadRows[0]?.laterRunMs ?? 0,
    workloadRows: workloadRows.slice(0, top),
    subsystemCoverage,
  };
}

export function renderProfileWorkAudit(report: ProfileWorkAuditReport, profilePath: string): string {
  const lines = [
    'scip-query work-audit',
    `Profile: ${profilePath}`,
    `Profile events: ${report.profileEvents}; spans: ${report.spanEvents}; distinct span names: ${report.distinctSpanNames}; runs: ${report.runCount}`,
    `Subsystem identity coverage: ${report.workloadIdentifiedSpanNames}/${report.distinctSpanNames} span names, ${report.workloadIdentifiedEvents}/${report.spanEvents} events`,
    `Exact identity coverage: ${report.exactIdentifiedSpanNames}/${report.distinctSpanNames} span names, ${report.instrumentedEvents}/${report.spanEvents} events`,
    `Repeated work groups: ${report.repeatedGroups}; largest measured opportunity: ${report.largestOpportunityMs}ms`,
    '',
  ];
  if (report.rows.length === 0) {
    lines.push('No exact repeated computations were found in work-identified profile events.');
    if (report.instrumentedEvents === 0) {
      lines.push('This profile predates exact work identities or its spans have not been instrumented yet.');
    }
  } else {
    lines.push('Exact repeated computations:');
    lines.push('avoidableMs\twithinRunMs\tcrossRunMs\trepeats\truns\tspan\tworkIdentity\tcommands');
    for (const row of report.rows) {
      lines.push(
        [
          row.estimatedAvoidableMs,
          row.withinRunAvoidableMs,
          row.crossRunRecomputeMs,
          row.repeatComputations,
          row.runCount,
          row.spanName,
          row.workIdentity,
          row.commands.join(', '),
        ].join('\t'),
      );
    }
  }

  lines.push('', `Repeated subsystem workloads: ${report.repeatedWorkloads}`);
  if (report.workloadRows.length === 0) {
    lines.push('No named subsystem workload was observed in more than one run.');
  } else {
    lines.push('laterRunMs\tfirstRunMs\tlaterEvents\truns\tsubsystem\tspan\tsubsystemWorkIdentity\tcommands');
    for (const row of report.workloadRows) {
      lines.push(
        [
          row.laterRunMs,
          row.firstRunMs,
          row.laterRunEvents,
          row.runCount,
          row.subsystem,
          row.spanName,
          row.subsystemWorkIdentity,
          row.commands.join(', '),
        ].join('\t'),
      );
    }
  }
  lines.push('', 'Rows are independent measurements; nested spans can overlap and must not be summed.');
  lines.push(
    'Within-run time is direct duplication. Cross-run time is a durable-cache opportunity that still needs safe invalidation.',
  );
  lines.push(
    'Subsystem workload time is an aggregate observation against the same command/project inputs, not proven avoidable time.',
  );
  return `${lines.join('\n')}\n`;
}

function recordCoverage(
  coverageBySubsystem: Map<string, SubsystemCoverageAccumulator>,
  event: ProfileEvent,
  spanName: string,
  durationMs: number,
): void {
  const subsystem = stringValue(event['subsystem']) ?? spanName.split(/[.:]/, 1)[0] ?? spanName;
  const coverage = coverageBySubsystem.get(subsystem) ?? {
    subsystem,
    events: 0,
    totalDurationMs: 0,
    spanNames: new Set<string>(),
    workloadIdentifiedEvents: 0,
    workloadIdentifiedSpanNames: new Set<string>(),
    exactIdentifiedEvents: 0,
    exactIdentifiedSpanNames: new Set<string>(),
  };
  coverage.events += 1;
  coverage.totalDurationMs += durationMs;
  coverage.spanNames.add(spanName);
  if (stringValue(event['subsystemWorkIdentity'])) {
    coverage.workloadIdentifiedEvents += 1;
    coverage.workloadIdentifiedSpanNames.add(spanName);
  }
  if (stringValue(event['workIdentity'])) {
    coverage.exactIdentifiedEvents += 1;
    coverage.exactIdentifiedSpanNames.add(spanName);
  }
  coverageBySubsystem.set(subsystem, coverage);
}

function recordWorkloadObservation(
  workloadGroups: Map<string, WorkloadGroup>,
  event: ProfileEvent,
  spanName: string,
  durationMs: number,
  runId: string | null,
): void {
  const subsystemWorkIdentity = stringValue(event['subsystemWorkIdentity']);
  if (!subsystemWorkIdentity || !runId || event['workloadIdentityKind'] !== 'published-project') return;
  const subsystem = stringValue(event['subsystem']) ?? spanName.split(/[.:]/, 1)[0] ?? spanName;
  const key = JSON.stringify([spanName, subsystemWorkIdentity]);
  const group = workloadGroups.get(key) ?? { subsystem, spanName, subsystemWorkIdentity, observations: [] };
  group.observations.push({
    runId,
    command: stringValue(event['command']) ?? 'unknown',
    durationMs,
  });
  workloadGroups.set(key, group);
}

function summarizeWorkloadGroup(group: WorkloadGroup): ProfileWorkloadAuditRow | null {
  const observationsByRun = new Map<string, WorkloadObservation[]>();
  for (const observation of group.observations) {
    const run = observationsByRun.get(observation.runId) ?? [];
    run.push(observation);
    observationsByRun.set(observation.runId, run);
  }
  const runs = [...observationsByRun.values()];
  if (runs.length < 2) return null;
  const firstRun = runs[0]!;
  const laterObservations = runs.slice(1).flat();
  return {
    subsystem: group.subsystem,
    spanName: group.spanName,
    subsystemWorkIdentity: group.subsystemWorkIdentity,
    commands: [...new Set(group.observations.map((observation) => observation.command))].sort(),
    runCount: runs.length,
    totalEvents: group.observations.length,
    firstRunEvents: firstRun.length,
    laterRunEvents: laterObservations.length,
    totalDurationMs: sum(group.observations.map((observation) => observation.durationMs)),
    firstRunMs: sum(firstRun.map((observation) => observation.durationMs)),
    laterRunMs: sum(laterObservations.map((observation) => observation.durationMs)),
  };
}

function finalizeSubsystemCoverage(coverage: SubsystemCoverageAccumulator): ProfileSubsystemCoverageRow {
  return {
    subsystem: coverage.subsystem,
    events: coverage.events,
    totalDurationMs: coverage.totalDurationMs,
    spanNames: [...coverage.spanNames].sort(),
    workloadIdentifiedEvents: coverage.workloadIdentifiedEvents,
    workloadIdentifiedSpanNames: coverage.workloadIdentifiedSpanNames.size,
    exactIdentifiedEvents: coverage.exactIdentifiedEvents,
    exactIdentifiedSpanNames: coverage.exactIdentifiedSpanNames.size,
  };
}

function summarizeWorkGroup(group: WorkGroup): ProfileWorkAuditRow | null {
  const computations = group.observations.filter((observation) => observation.outcome === 'computed');
  if (computations.length < 2) return null;

  const computationsByRun = new Map<string, WorkObservation[]>();
  for (const observation of computations) {
    const run = computationsByRun.get(observation.runId) ?? [];
    run.push(observation);
    computationsByRun.set(observation.runId, run);
  }
  const runComputations = [...computationsByRun.values()];
  const withinRunAvoidableMs = sum(
    runComputations.flatMap((observations) => observations.slice(1).map((observation) => observation.durationMs)),
  );
  const crossRunRecomputeMs = sum(runComputations.slice(1).map((observations) => observations[0]?.durationMs ?? 0));
  const commands = [...new Set(group.observations.map((observation) => observation.command))].sort();

  return {
    spanName: group.spanName,
    workIdentity: group.workIdentity,
    commands,
    computations: computations.length,
    runCount: runComputations.length,
    repeatComputations: computations.length - 1,
    withinRunRepeats: computations.length - runComputations.length,
    crossRunRecomputes: Math.max(0, runComputations.length - 1),
    totalComputeMs: sum(computations.map((observation) => observation.durationMs)),
    firstComputeMs: computations[0]?.durationMs ?? 0,
    withinRunAvoidableMs,
    crossRunRecomputeMs,
    estimatedAvoidableMs: withinRunAvoidableMs + crossRunRecomputeMs,
    cacheHits: countOutcome(group.observations, 'cache-hit'),
    cacheMisses: countOutcome(group.observations, 'cache-miss'),
    reused: countOutcome(group.observations, 'reused'),
    skipped: countOutcome(group.observations, 'skipped'),
  };
}

function profileWorkOutcome(value: unknown): ProfileWorkOutcome | null {
  switch (value) {
    case 'computed':
    case 'cache-hit':
    case 'cache-miss':
    case 'reused':
    case 'skipped':
      return value;
    default:
      return null;
  }
}

function countOutcome(observations: readonly WorkObservation[], outcome: ProfileWorkOutcome): number {
  return observations.filter((observation) => observation.outcome === outcome).length;
}

// scip-query: ignore-twin — audit input and watch-state parsing enforce different fallback semantics.
function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
