import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runTlaTool } from '../../src/tla/tool-runner.js';

describe('TLA tool runner', () => {
  it('runs Apalache through a normalized command result', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-tla-tool-'));
    const specPath = join(root, 'Spec.tla');
    writeFileSync(specPath, '---- MODULE Spec ----\n====\n');
    const calls: Array<{ binary: string; args: string[] }> = [];
    const spawn = ((binary: string, args: string[]) => {
      calls.push({ binary, args });
      if (args[0] === '--version') return { status: 0, signal: null, stdout: '', stderr: '' };
      return { status: 0, signal: null, stdout: 'PASS', stderr: '' };
    }) as never;

    const result = runTlaTool({
      projectRoot: root,
      specPath,
      checker: 'apalache',
      length: 3,
      spawn,
    });

    expect(result.status).toBe('passed');
    expect(result.checker).toBe('apalache');
    expect(result.command).toEqual(['apalache-mc', 'check', '--length=3', specPath]);
    expect(calls).toEqual([
      { binary: 'apalache-mc', args: ['--version'] },
      { binary: 'apalache-mc', args: ['check', '--length=3', specPath] },
    ]);
  });

  it('reports missing checker dependencies as skipped diagnostics', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-tla-tool-'));
    const specPath = join(root, 'Spec.tla');
    writeFileSync(specPath, '---- MODULE Spec ----\n====\n');
    const spawn = (() => ({ status: 1, signal: null, stdout: '', stderr: '' })) as never;

    const result = runTlaTool({
      projectRoot: root,
      specPath,
      checker: 'apalache',
      spawn,
    });

    expect(result.status).toBe('skipped');
    expect(result.diagnostics[0]?.message).toContain('Apalache binary is not available');
  });

  it('runs TLC with an isolated metadata directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-tla-tool-'));
    const specPath = join(root, 'Spec.tla');
    const configPath = join(root, 'Spec.cfg');
    const jarPath = join(root, 'tla2tools.jar');
    const metaDir = join(root, 'tlc-meta');
    writeFileSync(specPath, '---- MODULE Spec ----\n====\n');
    writeFileSync(configPath, 'SPECIFICATION Spec\n');
    writeFileSync(jarPath, '');
    const calls: Array<{ binary: string; args: string[] }> = [];
    const spawn = ((binary: string, args: string[]) => {
      calls.push({ binary, args });
      if (args[0] === '--version') return { status: 0, signal: null, stdout: '', stderr: '' };
      return { status: 0, signal: null, stdout: 'PASS', stderr: '' };
    }) as never;

    const result = runTlaTool({
      projectRoot: root,
      specPath,
      configPath,
      checker: 'tlc',
      tlaToolsJar: jarPath,
      metaDir,
      spawn,
    });

    expect(result.status).toBe('passed');
    expect(result.command).toEqual([
      'java',
      '-cp',
      jarPath,
      'tlc2.TLC',
      '-metadir',
      metaDir,
      '-config',
      configPath,
      specPath,
    ]);
    expect(calls).toEqual([
      { binary: 'java', args: ['--version'] },
      { binary: 'java', args: result.command.slice(1) },
    ]);
    expect(existsSync(metaDir)).toBe(false);
  });
});
