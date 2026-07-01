import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { generateTraceSpec, runTraceCheck } from '../../src/tla/trace-spec.js';
import { resolveTlaToolsJarCachePath } from '../../src/tla/tool-runner.js';
import type { TlaTraceStep } from '../../src/tla/model-contract.js';

const MACHINE_TLA = `---- MODULE Machine ----
EXTENDS Naturals, Sequences, TLC
VARIABLES status
vars == <<status>>
Init == status = "idle"
Start == status = "idle" /\\ status' = "busy"
Finish == status = "busy" /\\ status' = "idle"
Next == Start \\/ Finish
====
`;

const ACCEPTED_STEPS: TlaTraceStep[] = [
  { action: 'Start', before: { status: 'idle' }, after: { status: 'busy' } },
  { action: 'Finish', before: { status: 'busy' }, after: { status: 'idle' } },
];

describe('TLA trace-spec generation', () => {
  it('pins the reconstructed state sequence and requires the base Next relation', () => {
    const generation = generateTraceSpec('Machine', ['status'], ACCEPTED_STEPS);
    if ('error' in generation) throw new Error(generation.error);

    expect(generation.states).toBe(3);
    expect(generation.variables).toEqual(['status']);
    expect(generation.moduleText).toContain('EXTENDS Machine, Naturals, Sequences');
    expect(generation.moduleText).toContain('[status |-> "idle"],');
    expect(generation.moduleText).toContain('/\\ Next');
    expect(generation.moduleText).toContain("/\\ status' = TraceStates[traceIdx + 1].status");
    expect(generation.cfgText).toContain('SPECIFICATION TraceSpec');
  });

  it('rejects traces whose first step lacks a full before state', () => {
    const generation = generateTraceSpec('Machine', ['status'], [{ action: 'Start', after: { status: 'busy' } }]);
    expect(generation).toEqual({ error: 'trace step 0 must include a full `before` state' });
  });

  it('drops non-scalar variables with a disclosed warning', () => {
    const steps: TlaTraceStep[] = [
      { action: 'Start', before: { status: 'idle', blob: { nested: true } }, after: { status: 'busy' } },
    ];
    const generation = generateTraceSpec('Machine', ['status', 'blob'], steps);
    if ('error' in generation) throw new Error(generation.error);
    expect(generation.variables).toEqual(['status']);
    expect(generation.skippedVariables).toEqual(['blob']);
    expect(generation.warnings[0]).toContain('blob');
    expect(generation.warnings[0]).toContain('NOT checked');
  });
});

describe('TLA trace-check verdicts (faked checker)', () => {
  function fixture(): { specPath: string; jarPath: string; projectRoot: string } {
    const root = mkdtempSync(join(tmpdir(), 'scip-tla-trace-test-'));
    const specPath = join(root, 'Machine.tla');
    writeFileSync(specPath, MACHINE_TLA);
    const jarPath = join(root, 'fake.jar');
    writeFileSync(jarPath, 'fake');
    return { specPath, jarPath, projectRoot: root };
  }

  function fakeSpawn(tlcResult: { status: number; stdout: string }) {
    return ((binary: string, args: string[]) => {
      if (args.some((arg) => arg === '--version' || arg === '-version')) {
        return { status: 0, signal: null, stdout: '', stderr: '' };
      }
      if (binary === 'java') return { status: tlcResult.status, signal: null, stdout: tlcResult.stdout, stderr: '' };
      return { status: 1, signal: null, stdout: '', stderr: '' };
    }) as never;
  }

  it('reports acceptance when TLC passes', () => {
    const { specPath, jarPath, projectRoot } = fixture();
    const verdict = runTraceCheck({
      specPath,
      baseModuleName: 'Machine',
      mappedVariables: ['status'],
      steps: ACCEPTED_STEPS,
      toolOptions: { projectRoot, tlaToolsJar: jarPath, spawn: fakeSpawn({ status: 0, stdout: 'ok' }) },
    });
    expect(verdict.status).toBe('accepted');
    expect(verdict.states).toBe(3);
  });

  it('parses the divergent step out of a TLC deadlock', () => {
    const { specPath, jarPath, projectRoot } = fixture();
    const stdout = [
      'Error: Deadlock reached.',
      'The behavior up to this point is:',
      'State 1: <Initial predicate>',
      '/\\ traceIdx = 1',
      '/\\ status = "idle"',
      '',
      'State 2: <TraceStep>',
      '/\\ traceIdx = 2',
      '/\\ status = "busy"',
    ].join('\n');
    const verdict = runTraceCheck({
      specPath,
      baseModuleName: 'Machine',
      mappedVariables: ['status'],
      steps: [
        { action: 'Start', before: { status: 'idle' }, after: { status: 'busy' } },
        { action: 'Start', before: { status: 'busy' }, after: { status: 'busy' } },
      ],
      toolOptions: { projectRoot, tlaToolsJar: jarPath, spawn: fakeSpawn({ status: 1, stdout }) },
    });
    expect(verdict.status).toBe('diverged');
    expect(verdict.divergedAtState).toBe(2);
    expect(verdict.divergedStep).toEqual({ index: 1, action: 'Start' });
    expect(verdict.detail).toContain('does not accept the recorded transition');
  });
});

const cachedJar = resolveTlaToolsJarCachePath();
const javaOk = spawnSync('java', ['-version'], { encoding: 'utf8' }).status === 0;
const canRunTlc = existsSync(cachedJar) && javaOk;

describe.skipIf(!canRunTlc)('TLA trace-check end-to-end (real TLC)', () => {
  it('accepts a legal trace and pinpoints the divergent step of an illegal one', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-tla-trace-e2e-'));
    const specPath = join(root, 'Machine.tla');
    writeFileSync(specPath, MACHINE_TLA);

    const accepted = runTraceCheck({
      specPath,
      baseModuleName: 'Machine',
      mappedVariables: ['status'],
      steps: ACCEPTED_STEPS,
      toolOptions: { projectRoot: root, tlaToolsJar: cachedJar },
    });
    expect(accepted.status).toBe('accepted');

    const diverging = runTraceCheck({
      specPath,
      baseModuleName: 'Machine',
      mappedVariables: ['status'],
      steps: [
        { action: 'Start', before: { status: 'idle' }, after: { status: 'busy' } },
        // Illegal: from "busy", no action can keep status at "busy".
        { action: 'Start', before: { status: 'busy' }, after: { status: 'busy' } },
      ],
      toolOptions: { projectRoot: root, tlaToolsJar: cachedJar },
    });
    expect(diverging.status).toBe('diverged');
    expect(diverging.divergedAtState).toBe(2);
    expect(diverging.divergedStep?.index).toBe(1);
  }, 60_000);
});
