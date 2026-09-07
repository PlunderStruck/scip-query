import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { maybePrintUpdateNotice } from '../../src/runtime/update-notice.js';

function declarations(path: string, names: string[], globals: Record<string, unknown> = {}) {
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  const selected = source.statements.filter(
    (node) => ts.isFunctionDeclaration(node) && names.includes(node.name?.text ?? ''),
  );
  expect(selected).toHaveLength(names.length);
  const context = createContext(globals);
  // Declarations only: script startup, benchmark agents, and external processes never execute.
  runInContext(ts.transpile(selected.map((node) => node.getText(source)).join('\n')), context);
  return context;
}

describe('wave7 worker3 contracts', () => {
  it('preserves shadow flag consumption, defaults, and first failing gate', () => {
    const context = declarations('scripts/affected-set-shadow-contract.mjs', [
      'parseArgs',
      'assignShadowArgument',
      'positiveInteger',
      'verifyShadow',
      'verifyShadowExpectations',
    ]);
    const parse = context.parseArgs as (args: string[]) => Record<string, unknown>;
    expect(parse(['--mode', 'fixture', '--out'])).toMatchObject({
      mode: 'fixture',
      out: undefined,
      label: 'generated-typescript-fixture',
    });
    expect(() => parse(['--mode', 'fixture', '--iterations', '0', '--unknown'])).toThrow(
      '--iterations must be a positive integer',
    );
    expect(() => parse(['--mode', 'fixture', '--constructor', 'x'])).toThrow('unknown argument: --constructor');
    const verify = context.verifyShadow as (value: unknown, options: unknown) => void;
    expect(() =>
      verify({ state: 'passing', actualFiles: ['missing'], predictedFiles: [], recall: 0 }, { expectedMode: 'bad' }),
    ).toThrow('shadow underpredicted: missing');
  });

  it('keeps benchmark operand lookup exact and preserves the empty operand', () => {
    const context = declarations('scripts/benchmark-query-service.ts', ['defaultOperand']);
    const operand = context.defaultOperand as (command: string) => string;
    expect(operand('kind-counts')).toBe('');
    expect(operand('methods')).toBe('ScipDatabase');
    expect(operand('constructor')).toBe('queryServiceSessionIdentity');
    expect(operand('__proto__')).toBe('queryServiceSessionIdentity');
  });

  it('prints cached update notices before yielding and never fetches a cached null result', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'wave7-update-'));
    try {
      const fetchLatestVersion = vi.fn(async () => '9.0.0');
      const writeNotice = vi.fn();
      writeFileSync(join(cacheDir, 'update-check.json'), JSON.stringify({ checkedAt: 100, latestVersion: '2.0.0' }));
      const pending = maybePrintUpdateNotice({
        cacheDir,
        env: {},
        now: 101,
        currentVersion: '1.0.0',
        fetchLatestVersion,
        writeNotice,
      });
      expect(writeNotice).toHaveBeenCalledTimes(1);
      await pending;
      writeFileSync(join(cacheDir, 'update-check.json'), JSON.stringify({ checkedAt: 100, latestVersion: null }));
      await maybePrintUpdateNotice({
        cacheDir,
        env: {},
        now: 101,
        currentVersion: '1.0.0',
        fetchLatestVersion,
        writeNotice,
      });
      expect(fetchLatestVersion).not.toHaveBeenCalled();
      expect(writeNotice).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it('retains git inspection error precedence and lazy message reads', () => {
    const context = declarations(
      'src/runtime/cleanup-verify.ts',
      ['workingTreeInspectionFailureReason', 'workingTreeFailureMessage', 'workingTreeOutputLimitExceeded'],
      { GIT_STATUS_TIMEOUT_MS: 30000, GIT_STATUS_MAX_BYTES: 1048576 },
    );
    const reason = context.workingTreeInspectionFailureReason as (error: unknown) => string;
    const message = () => {
      throw new Error('message should not be read');
    };
    expect(
      reason({
        code: 'ETIMEDOUT',
        get message() {
          return message();
        },
      }),
    ).toBe('git status timed out after 30000ms');
    expect(
      reason({
        code: 'ENOBUFS',
        signal: 'SIGTERM',
        get message() {
          return message();
        },
      }),
    ).toBe('git status exceeded its 1048576-byte output limit');
    expect(reason({ signal: 'SIGTERM', status: 2, message: 'failure' })).toBe('git status was terminated by SIGTERM');
  });
});
