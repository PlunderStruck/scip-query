import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as service from '../../src/runtime/query-service.js';
import { tryRunQueryServiceFastPath } from '../../src/runtime/query-service-fastpath.js';
import { runWithCliOutputPagination } from '../../src/runtime/output-pagination.js';
import { CLIENT_SAFE_OUTPUT_BYTES, writeSerializedJson } from '../../src/platform/terminal-output.js';
import type * as TerminalOutput from '../../src/platform/terminal-output.js';

vi.mock('../../src/runtime/query-service.js', () => ({
  tryFilesWithQueryService: vi.fn(),
  tryFileDependenciesWithQueryService: vi.fn(),
  tryMethodsWithQueryService: vi.fn(),
  tryDependenceSliceWithQueryService: vi.fn(),
  tryCodeWithQueryService: vi.fn(),
  tryImportsWithQueryService: vi.fn(),
}));
vi.mock('../../src/runtime/cli-context.js', () => ({ resolveProjectRoot: () => '/repo' }));
vi.mock('../../src/runtime/cli-invocation.js', () => ({ cliInvocationPrefix: () => 'scip-query' }));
vi.mock('../../src/platform/terminal-output.js', async (original) => ({
  ...(await original<typeof TerminalOutput>()),
  writeSerializedJson: vi.fn(),
}));
vi.mock('../../src/runtime/output-pagination.js', () => ({
  runWithCliOutputPagination: vi.fn(async (_options, render) => render()),
}));

const jsonFlags = ['--json', '--result-only', '--compact'];
let originalExitCode: typeof process.exitCode;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('SCIP_QUERY_PROFILE', '0');
  originalExitCode = process.exitCode;
  process.exitCode = undefined;
});
afterEach(() => {
  vi.unstubAllEnvs();
  process.exitCode = originalExitCode;
});

describe('query service fast-path output and fallback', () => {
  it.each(['deps', 'rdeps'])('paginates oversized %s with the original command and arguments', async (command) => {
    const result = { files: ['x'.repeat(CLIENT_SAFE_OUTPUT_BYTES)] };
    vi.mocked(service.tryFileDependenciesWithQueryService).mockReturnValue({ result } as never);
    const argv = [command, 'src/model.ts', ...jsonFlags];
    expect(await tryRunQueryServiceFastPath(argv)).toBe(true);
    expect(service.tryFileDependenciesWithQueryService).toHaveBeenCalledWith(
      '/repo',
      command === 'deps' ? 'outgoing' : 'incoming',
      'src/model.ts',
      { allowDefault: true },
    );
    expect(runWithCliOutputPagination).toHaveBeenCalledWith(
      expect.objectContaining({ command, argv }),
      expect.any(Function),
    );
    expect(writeSerializedJson).toHaveBeenCalledWith(JSON.stringify(result));
  });

  it('leaves oversized unpaged imports to the full CLI without partial output', async () => {
    vi.mocked(service.tryImportsWithQueryService).mockReturnValue({
      result: 'x'.repeat(CLIENT_SAFE_OUTPUT_BYTES),
    } as never);
    expect(await tryRunQueryServiceFastPath(['imports', 'src/model.ts', ...jsonFlags])).toBe(false);
    expect(writeSerializedJson).not.toHaveBeenCalled();
    expect(runWithCliOutputPagination).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it('leaves an oversized unresolved method result and its exit status to the full CLI', async () => {
    vi.mocked(service.tryMethodsWithQueryService).mockReturnValue({
      result: { kind: 'missing', detail: 'x'.repeat(CLIENT_SAFE_OUTPUT_BYTES) },
    } as never);
    expect(await tryRunQueryServiceFastPath(['methods', 'Missing', ...jsonFlags])).toBe(false);
    expect(writeSerializedJson).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it('sets the method failure status only after emitting the unresolved result', async () => {
    vi.mocked(service.tryMethodsWithQueryService).mockReturnValue({ result: { kind: 'missing' } } as never);
    vi.mocked(writeSerializedJson).mockImplementationOnce(() => {
      expect(process.exitCode).toBeUndefined();
    });
    expect(await tryRunQueryServiceFastPath(['methods', 'Missing', ...jsonFlags])).toBe(true);
    expect(writeSerializedJson).toHaveBeenCalledWith('{"kind":"missing"}');
    expect(process.exitCode).toBe(1);
  });

  it('sets slice resolution failure before paginated output', async () => {
    const serializedJson = JSON.stringify({ resolution: 'missing', detail: 'x'.repeat(CLIENT_SAFE_OUTPUT_BYTES) });
    vi.mocked(service.tryDependenceSliceWithQueryService).mockReturnValue({ result: { serializedJson } } as never);
    vi.mocked(writeSerializedJson).mockImplementationOnce(() => {
      expect(process.exitCode).toBe(1);
    });
    expect(await tryRunQueryServiceFastPath(['dependence-slice', 'Missing', ...jsonFlags])).toBe(true);
    expect(runWithCliOutputPagination).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'dependence-slice' }),
      expect.any(Function),
    );
    expect(writeSerializedJson).toHaveBeenCalledWith(serializedJson);
  });

  it('preserves service-rendered code bytes without an additional JSON encoding', async () => {
    const serializedJson = '{ "units": [1, 2] }';
    vi.mocked(service.tryCodeWithQueryService).mockReturnValue({ result: { serializedJson } } as never);
    expect(await tryRunQueryServiceFastPath(['code', 'Model', ...jsonFlags])).toBe(true);
    expect(writeSerializedJson).toHaveBeenCalledWith(serializedJson);
    expect(runWithCliOutputPagination).not.toHaveBeenCalled();
  });

  it('falls through silently when the service has no result', async () => {
    vi.mocked(service.tryFilesWithQueryService).mockReturnValue(null);
    expect(await tryRunQueryServiceFastPath(['files', 'src', ...jsonFlags])).toBe(false);
    expect(writeSerializedJson).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it.each(['1', 'true'])('keeps profiling=%s on the full CLI', async (profile) => {
    vi.stubEnv('SCIP_QUERY_PROFILE', profile);
    expect(await tryRunQueryServiceFastPath(['files', 'src', ...jsonFlags])).toBe(false);
    expect(service.tryFilesWithQueryService).not.toHaveBeenCalled();
  });

  it('keeps unsupported options on the full CLI', async () => {
    expect(await tryRunQueryServiceFastPath(['files', 'src', ...jsonFlags, '--unknown'])).toBe(false);
    expect(service.tryFilesWithQueryService).not.toHaveBeenCalled();
  });
});
