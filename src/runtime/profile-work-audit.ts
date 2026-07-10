import { readFileSync } from 'node:fs';

export type ProfileWorkOutcome = 'computed' | 'cache-hit' | 'cache-miss' | 'reused' | 'skipped';

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

export interface ProfileWorkAuditReport {
  profileEvents: number;
  instrumentedEvents: number;
  unclassifiedInstrumentedEvents: number;
  runCount: number;
  repeatedGroups: number;
  largestOpportunityMs: number;
  rows: ProfileWorkAuditRow[];
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
  const groups = new Map<string, WorkGroup>();
  const runIds = new Set<string>();
  let instrumentedEvents = 0;
  let unclassifiedInstrumentedEvents = 0;

  for (const [index, event] of events.entries()) {
    const workIdentity = stringValue(event['workIdentity']);
    if (!workIdentity) continue;
    instrumentedEvents += 1;

    const spanName = stringValue(event['name']) ?? stringValue(event['phase']);
    const durationMs = finiteNumber(event['durationMs']);
    const outcome = profileWorkOutcome(event['workOutcome']);
    if (!spanName || durationMs === null || !outcome) {
      unclassifiedInstrumentedEvents += 1;
      continue;
    }

    const explicitRunId = stringValue(event['runId']);
    const runId = explicitRunId ?? `unknown-run-${index}`;
    runIds.add(runId);
    const key = JSON.stringify([spanName, workIdentity]);
    const group = groups.get(key) ?? { spanName, workIdentity, observations: [] };
    group.observations.push({
      runId,
      command: stringValue(event['command']) ?? 'unknown',
      durationMs,
      outcome,
    });
    groups.set(key, group);
  }

  const repeatedRows = [...groups.values()]
    .map(summarizeWorkGroup)
    .filter((row): row is ProfileWorkAuditRow => row !== null)
    .sort(
      (left, right) =>
        right.estimatedAvoidableMs - left.estimatedAvoidableMs ||
        right.repeatComputations - left.repeatComputations ||
        left.spanName.localeCompare(right.spanName) ||
        left.workIdentity.localeCompare(right.workIdentity),
    );
  const top = opts.top ?? 20;

  return {
    profileEvents: events.length,
    instrumentedEvents,
    unclassifiedInstrumentedEvents,
    runCount: runIds.size,
    repeatedGroups: repeatedRows.length,
    largestOpportunityMs: repeatedRows[0]?.estimatedAvoidableMs ?? 0,
    rows: repeatedRows.slice(0, top),
  };
}

export function renderProfileWorkAudit(report: ProfileWorkAuditReport, profilePath: string): string {
  const lines = [
    'scip-query work-audit',
    `Profile: ${profilePath}`,
    `Profile events: ${report.profileEvents}; work-identified: ${report.instrumentedEvents}; runs: ${report.runCount}`,
    `Repeated work groups: ${report.repeatedGroups}; largest measured opportunity: ${report.largestOpportunityMs}ms`,
    '',
  ];
  if (report.rows.length === 0) {
    lines.push('No exact repeated computations were found in work-identified profile events.');
    if (report.instrumentedEvents === 0) {
      lines.push('This profile predates work identities or its spans have not been instrumented yet.');
    }
    return `${lines.join('\n')}\n`;
  }

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
  lines.push('', 'Rows are independent measurements; nested spans can overlap and must not be summed.');
  lines.push(
    'Within-run time is direct duplication. Cross-run time is a durable-cache opportunity that still needs safe invalidation.',
  );
  return `${lines.join('\n')}\n`;
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

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
