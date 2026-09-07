import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { deadCandidateDecision } from '../../src/queries/internal/dead-candidate-gate.js';
import { decodeDurableRustMailboxResponse } from '../../src/semantic/rust/durable-session-protocol.js';

const definition = {
  relativePath: 'src/lib.rs',
  startLine: 0,
  endLine: 4,
  symbol: 'rust-analyzer cargo fixture 0.1.0 src/lib.rs/run().',
  isFunctionLike: true,
  enclosingSymbol: null,
  parentTypeName: null,
};

const expected = {
  requestId: 'request',
  operationKey: 'operation',
  sessionIdentity: 'session',
  deadlineAtMs: 100,
  nowMs: 100,
  requestKind: 'semantic' as const,
};
const rejection = {
  protocolVersion: 3,
  mailboxVersion: 1,
  id: 'request',
  operationKey: 'operation',
  sessionIdentity: 'session',
  deadlineAtMs: 100,
  completedAtMs: 100,
  ok: false,
  errorCode: 'handler-error',
  error: 'worker rejected the operation',
};

function runComparisonArgs(args: string[]) {
  return spawnSync(process.execPath, ['scripts/typescript-semantic-provider-comparison.mjs', ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 5_000,
  });
}

describe('complexity wave 2 worker 2 preservation', () => {
  it('stops rejection checks after the first applicable contract and keeps includeTests local to file filters', () => {
    const calls: string[] = [];
    const decision = deadCandidateDecision(definition, {
      minLoc: 100,
      includeTests: true,
      includeMembers: true,
      isIgnoredPath: () => {
        calls.push('ignored');
        return false;
      },
      isExcludedRegion: () => {
        calls.push('excluded');
        return true;
      },
      isDeclarationOnlyCallable: () => {
        calls.push('declaration');
        return true;
      },
      isFrameworkContractCallable: () => {
        calls.push('framework');
        return true;
      },
    });
    expect(decision).toEqual({ accepted: false, rejectionReason: 'declaration-only-callable' });
    expect(calls).toEqual(['ignored', 'declaration']);
  });

  it('checks response identity before deadline and deadline before worker rejection payload', () => {
    expect(decodeDurableRustMailboxResponse({ ...rejection, id: 'other', completedAtMs: 101 }, expected)).toMatchObject(
      { ok: false, code: 'incompatible-response' },
    );
    expect(
      decodeDurableRustMailboxResponse({ ...rejection, completedAtMs: 101, errorCode: 'unknown' }, expected),
    ).toMatchObject({ ok: false, code: 'expired-request' });
    expect(decodeDurableRustMailboxResponse(rejection, expected)).toEqual({
      ok: false,
      code: 'handler-error',
      error: 'worker rejected the operation',
    });
  });

  it.each([
    [['--limit', '0', '--max-mismatches', '-1'], '--limit must be >= 1'],
    [['--max-mismatches', '-1', '--timeout-ms', '0'], '--max-mismatches must be >= 0'],
    [['--timeout-ms', 'NaN'], '--timeout-ms must be >= 1000'],
    [['--scope'], '--scope requires a value'],
    [['constructor'], 'Unknown argument: constructor'],
  ])('rejects comparison arguments before executing repository work: %j', (args, message) => {
    const child = runComparisonArgs(args);
    expect(child.status).toBe(1);
    expect(child.stderr).toContain(message);
  });

  it('handles --list immediately before numeric validation', () => {
    const child = runComparisonArgs(['--limit', '0', '--list', '--unknown']);
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({ repos: ['scip-query', 'VegaAssistant'] });
  });
});
