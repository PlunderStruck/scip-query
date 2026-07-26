import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fetchTlaToolsJar, resolveTlaToolsJar, runTlaTool } from '../../src/tla/tool-runner.js';

describe('TLA tool runner', () => {
  it('does not select a repository-local tla2tools.jar without an explicit path', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-tla-local-jar-'));
    const localJar = join(root, 'tla2tools.jar');
    writeFileSync(localJar, 'repository bytes');
    const env = { SCIP_QUERY_CACHE_DIR: join(root, 'empty-cache') };

    expect(resolveTlaToolsJar({ projectRoot: root, specPath: join(root, 'Spec.tla'), env })).toBeNull();
    expect(
      resolveTlaToolsJar({
        projectRoot: root,
        specPath: join(root, 'Spec.tla'),
        env,
        tlaToolsJar: localJar,
      }),
    ).toBe(localJar);
  });

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

  it('classifies a SIGTERM at the timeout boundary as timed-out, not failed', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-tla-tool-'));
    const specPath = join(root, 'Spec.tla');
    writeFileSync(specPath, '---- MODULE Spec ----\n====\n');
    // spawnSync's own `timeout` kill surfaces as signal=SIGTERM with no
    // `error` (not the ETIMEDOUT shape) — reproduce that here.
    const spawn = ((binary: string, args: string[]) => {
      if (args[0] === '--version') return { status: 0, signal: null, stdout: '', stderr: '' };
      return { status: null, signal: 'SIGTERM', stdout: '', stderr: '' };
    }) as never;

    const result = runTlaTool({
      projectRoot: root,
      specPath,
      checker: 'apalache',
      spawn,
      // timeoutMs: 0 means any measured duration satisfies `>= timeoutMs`,
      // making the boundary condition deterministic in a fast unit test.
      timeoutMs: 0,
    });

    expect(result.status).toBe('timed-out');
    expect(result.timedOut).toBe(true);
    expect(result.signal).toBe('SIGTERM');
  });

  it('does not classify an ordinary SIGTERM well before the timeout as timed-out', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-tla-tool-'));
    const specPath = join(root, 'Spec.tla');
    writeFileSync(specPath, '---- MODULE Spec ----\n====\n');
    const spawn = ((binary: string, args: string[]) => {
      if (args[0] === '--version') return { status: 0, signal: null, stdout: '', stderr: '' };
      return { status: null, signal: 'SIGTERM', stdout: '', stderr: '' };
    }) as never;

    const result = runTlaTool({
      projectRoot: root,
      specPath,
      checker: 'apalache',
      spawn,
      timeoutMs: 120_000,
    });

    expect(result.status).toBe('failed');
    expect(result.timedOut).toBe(false);
  });

  it('reports the fetch-tools remediation when tla2tools.jar is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-tla-tool-'));
    const specPath = join(root, 'Spec.tla');
    writeFileSync(specPath, '---- MODULE Spec ----\n====\n');
    const spawn = ((binary: string) =>
      binary === 'java'
        ? { status: 0, signal: null, stdout: '', stderr: '' }
        : { status: 1, signal: null, stdout: '', stderr: '' }) as never;

    const result = runTlaTool({
      projectRoot: root,
      specPath,
      checker: 'tlc',
      spawn,
      // Hermetic: without this, a jar cached by a previous `tla fetch-tools`
      // run in the developer's real cache dir makes this test flip.
      env: { SCIP_QUERY_CACHE_DIR: join(root, 'empty-cache') },
    });

    expect(result.status).toBe('skipped');
    expect(result.diagnostics[0]?.message).toContain("run 'scip-query tla fetch-tools'");
  });

  it('downloads tla2tools.jar into the cache with checksum verification', async () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-tla-tool-'));
    const jarPath = join(root, 'cache', 'tla2tools.jar');
    const bytes = Buffer.from('tiny jar fixture');
    const expectedSha256 = createHash('sha256').update(bytes).digest('hex');
    const fetchImpl = (async () =>
      new Response(bytes, {
        status: 200,
        headers: { 'content-length': String(bytes.length) },
      })) as typeof fetch;

    const result = await fetchTlaToolsJar({
      cachePath: jarPath,
      fetchImpl,
      url: 'https://example.test/tla2tools.jar',
      version: 'test',
      expectedSha256,
    });

    expect(result.status).toBe('downloaded');
    expect(result.path).toBe(jarPath);
    expect(readFileSync(jarPath)).toEqual(bytes);

    const cached = await fetchTlaToolsJar({
      cachePath: jarPath,
      fetchImpl,
      url: 'https://example.test/tla2tools.jar',
      version: 'test',
      expectedSha256,
    });
    expect(cached.status).toBe('cached');
  });
});
