import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as setup from '../../src/runtime/setup.js';
import * as scipCli from '../../src/platform/scip-cli.js';
import * as context from '../../src/runtime/cli-context.js';
import * as config from '../../src/runtime/config.js';
import * as projectReadiness from '../../src/runtime/project-readiness.js';
import { handleCheckDeps } from '../../src/runtime/commands/command-handlers.js';

const originalExitCode = process.exitCode;

function readiness(overrides: Partial<projectReadiness.ProjectReadiness> = {}): projectReadiness.ProjectReadiness {
  return { languages: [], indexers: [], checkers: [], gitAvailable: false, ...overrides };
}

describe('dependency-check reporting after responsibility extraction', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(setup, 'isScipInstalled').mockReturnValue(true);
    vi.spyOn(context, 'resolveProjectRoot').mockReturnValue('/dependency-check-fixture');
    vi.spyOn(config, 'loadProjectConfig').mockReturnValue({});
    vi.spyOn(projectReadiness, 'getProjectReadiness').mockReturnValue(readiness());
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = originalExitCode;
  });

  it('retains a missing required converter failure when no project language is detected', () => {
    vi.mocked(setup.isScipInstalled).mockReturnValue(false);
    vi.spyOn(scipCli, 'externalScipConverterSelected').mockReturnValue(true);
    const install = vi.spyOn(setup, 'printScipInstallInstructions').mockImplementation(() => undefined);
    handleCheckDeps();
    expect(install).toHaveBeenCalledOnce();
    expect(projectReadiness.getProjectReadiness).toHaveBeenCalledOnce();
    expect(vi.mocked(console.log).mock.calls).toEqual([
      ['\nNo supported project languages detected in the current directory.'],
    ]);
    expect(process.exitCode).toBe(1);
  });

  it('renders every indexer and semantic provider in order despite earlier failures', () => {
    vi.mocked(projectReadiness.getProjectReadiness).mockReturnValue(
      readiness({
        languages: ['typescript', 'rust'],
        indexers: [
          {
            language: 'typescript',
            binaryLabel: 'ts-indexer',
            installed: true,
            runnable: false,
            resolvedBinary: '/tools/ts',
            note: 'configuration missing',
            installUrl: 'https://unused.example',
          },
          {
            language: 'rust',
            binaryLabel: 'rust-indexer',
            installed: false,
            runnable: false,
            installUrl: 'https://install.example',
          },
        ],
        semantics: [
          {
            language: 'typescript',
            available: false,
            dependencyAvailable: true,
            tsconfigPath: 'tsconfig.json',
            reason: 'project unavailable',
          },
        ],
      }),
    );
    handleCheckDeps();
    expect(vi.mocked(console.log).mock.calls).toEqual([
      ['scip CLI: installed'],
      ['\nDetected languages: typescript, rust'],
      ['\nIndexer readiness:'],
      ['  WARN typescript: ts-indexer (/tools/ts)'],
      ['    configuration missing'],
      ['  MISSING rust: rust-indexer'],
      ['    install: https://install.example'],
      ['\nSemantic provider readiness:'],
      ['  WARN typescript: ts-morph (tsconfig.json)'],
      ['    project unavailable'],
    ]);
    expect(process.exitCode).toBe(1);
  });

  it('leaves unavailable semantic providers informational when indexers are runnable', () => {
    vi.mocked(projectReadiness.getProjectReadiness).mockReturnValue(
      readiness({
        languages: ['rust'],
        indexers: [{ language: 'rust', binaryLabel: 'rust-indexer', installed: true, runnable: true }],
        semantic: {
          language: 'rust',
          available: false,
          dependencyAvailable: false,
          reason: 'optional provider absent',
        },
      }),
    );
    handleCheckDeps();
    expect(console.log).toHaveBeenCalledWith('  MISSING rust: rust-analyzer');
    expect(console.log).toHaveBeenCalledWith('    optional provider absent');
    expect(process.exitCode).toBe(0);
  });
});
