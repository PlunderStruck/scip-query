import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

function privateFunctions(path: string, names: string[], bindings: Record<string, unknown> = {}) {
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  const declarations = source.statements.filter(
    (node) => ts.isFunctionDeclaration(node) && names.includes(node.name?.text ?? ''),
  );
  expect(declarations).toHaveLength(names.length);
  const script = ts.transpileModule(declarations.map((node) => node.getText(source)).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const context = createContext({ Error, ...bindings });
  // Exercise the real parsers without executing the worker or CLI entrypoints.
  runInContext(script, context);
  return context;
}

function workerParser() {
  const context = privateFunctions('src/runtime/typescript-mailbox-worker.ts', [
    'parseWorkerData',
    'parseIndexMailboxWorkerData',
    'parseSemanticMailboxWorkerData',
    'optionalPositiveInteger',
  ]);
  return context['parseWorkerData'] as (value: unknown) => Record<string, unknown>;
}

describe('mailbox worker launch data', () => {
  it('distinguishes missing data from an invalid object', () => {
    const parse = workerParser();
    for (const value of [undefined, null, false, 0, '', () => {}]) {
      expect(() => parse(value)).toThrow('TypeScript mailbox worker data is missing.');
    }
    for (const value of [{}, [], { kind: 'unknown' }, { kind: 'index', projectRoot: '/repo' }]) {
      expect(() => parse(value)).toThrow('TypeScript mailbox worker data is invalid.');
    }
  });

  it('projects each worker kind without leaking unrelated fields or adding absent options', () => {
    const parse = workerParser();
    expect(parse({ kind: 'index', projectRoot: '', dbPath: './index.db', extra: true })).toEqual({
      kind: 'index',
      projectRoot: '',
      dbPath: './index.db',
    });
    expect(parse({ kind: 'semantic', projectRoot: '/repo', dbPath: 42, maxActiveSessions: -1 })).toEqual({
      kind: 'semantic',
      projectRoot: '/repo',
    });
  });

  it('retains the existing positive-integer grammar independently for optional limits', () => {
    const parse = workerParser();
    for (const field of ['maxActiveSessions', 'softMemoryLimitMb']) {
      for (const value of [null, 0, -1, 1.5, '2', Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(() => parse({ kind: 'index', projectRoot: '/repo', dbPath: '/db', [field]: value })).toThrow(
          'TypeScript mailbox worker data is invalid.',
        );
      }
    }
    expect(
      parse({ kind: 'index', projectRoot: '/repo', dbPath: '/db', maxActiveSessions: 2, softMemoryLimitMb: 2 ** 53 }),
    ).toEqual({ kind: 'index', projectRoot: '/repo', dbPath: '/db', maxActiveSessions: 2, softMemoryLimitMb: 2 ** 53 });
  });

  it('preserves the acceptance of object-shaped arrays with valid launch fields', () => {
    const data = Object.assign([], { kind: 'semantic', projectRoot: '/repo', softMemoryLimitMb: 64 });
    expect(workerParser()(data)).toEqual({ kind: 'semantic', projectRoot: '/repo', softMemoryLimitMb: 64 });
  });
});

function compactParsers() {
  const context = privateFunctions('src/runtime/query-service-fastpath.ts', [
    'parseExactCompactOperand',
    'parseFilesInvocation',
    'applyQueryServiceOutputFlag',
    'hasCompactQueryOutput',
  ]);
  return {
    operand: context['parseExactCompactOperand'] as (argv: string[]) => string | null,
    files: context['parseFilesInvocation'] as (argv: string[]) => { kind: string; pattern: string } | null,
  };
}

describe('compact single-operand argument contract', () => {
  const flags = ['--json', '--result-only', '--compact'];

  it('accepts an empty operand and a literal flag after the delimiter', () => {
    const parse = compactParsers();
    for (const pattern of ['', '--json', '-file.ts']) {
      const argv = ['files', ...flags, '--', pattern];
      expect(parse.operand(argv)).toBe(pattern);
      expect(parse.files(argv)).toEqual({ kind: 'files', pattern });
    }
  });

  it('accepts flags around the operand and repeated output flags', () => {
    const parse = compactParsers();
    const argv = ['files', '--compact', 'src/a.ts', '--json', '--result-only', '--json'];
    expect(parse.operand(argv)).toBe('src/a.ts');
    expect(parse.files(argv)).toEqual({ kind: 'files', pattern: 'src/a.ts' });
  });

  it('requires all output flags before delimiter consumption and exactly one operand', () => {
    const parse = compactParsers();
    for (const args of [
      flags,
      ['a.ts', '--json', '--compact'],
      [...flags, 'a.ts', 'b.ts'],
      [...flags, 'a.ts', '--', 'b.ts'],
      [...flags, '--'],
      ['--', 'a.ts', ...flags],
      [...flags, '--unknown', 'a.ts'],
    ]) {
      expect(parse.operand(['files', ...args])).toBeNull();
      expect(parse.files(['files', ...args])).toBeNull();
    }
  });
});

describe('serialized query result validation', () => {
  it('requires a matching digest and object-shaped JSON', () => {
    const context = privateFunctions(
      'src/runtime/query-service.ts',
      ['isSerializedJsonResult', 'isSerializedObjectJson'],
      {
        createHash,
        QUERY_SERVICE_MAX_ITEM_BYTES: 64 * 1024 * 1024,
      },
    );
    const valid = context['isSerializedJsonResult'] as (value: unknown) => boolean;
    const result = (serializedJson: string) => ({
      serializedJson,
      sha256: createHash('sha256').update(serializedJson).digest('hex'),
    });
    expect(valid(result('{"items":[]}'))).toBe(true);
    expect(valid(result('{}'))).toBe(true);
    for (const json of ['[]', 'null', '3', '"text"', '{']) expect(valid(result(json))).toBe(false);
    expect(valid({ ...result('{}'), sha256: 'wrong' })).toBe(false);
    expect(valid({ serializedJson: {}, sha256: 'wrong' })).toBe(false);
  });
});

describe('worker response publication', () => {
  it.each([true, false])('preserves callback receivers and publication order for ok=%s', (ok) => {
    const context = privateFunctions('src/runtime/worker-request-lane.ts', ['publishWorkerLaneResponse']);
    const publish = context['publishWorkerLaneResponse'] as (
      options: unknown,
      active: unknown,
      response: unknown,
    ) => boolean;
    const calls: string[] = [];
    const active = { request: { requestId: 'old' } };
    const updatedRequest = { requestId: 'updated' };
    const status = { ready: true };
    const result = { count: 3 };
    const options = {
      onStatus(value: unknown) {
        expect(this).toBe(options);
        expect(value).toBe(status);
        active.request = updatedRequest;
        calls.push('status');
      },
      onComplete(request: unknown, value: unknown, observed: unknown) {
        expect(this).toBe(options);
        expect(request).toBe(updatedRequest);
        expect(value).toBe(result);
        expect(observed).toBe(status);
        calls.push('complete');
      },
      onReject(request: unknown, reason: unknown, observed: unknown) {
        expect(this).toBe(options);
        expect(request).toBe(updatedRequest);
        expect(reason).toBe('failed');
        expect(observed).toBe(status);
        calls.push('reject');
      },
      retireAfterResponse(observed: unknown) {
        expect(this).toBe(options);
        expect(observed).toBe(status);
        calls.push('retire');
        return true;
      },
    };
    expect(publish(options, active, { ok, status, ...(ok ? { result } : { error: 'failed' }) })).toBe(true);
    expect(calls).toEqual(['status', ok ? 'complete' : 'reject', 'retire']);
  });

  it('propagates a status callback failure before completing or retiring the request', () => {
    const context = privateFunctions('src/runtime/worker-request-lane.ts', ['publishWorkerLaneResponse']);
    const publish = context['publishWorkerLaneResponse'] as (
      options: unknown,
      active: unknown,
      response: unknown,
    ) => boolean;
    const error = new Error('status failure');
    const calls: string[] = [];
    const options = {
      onStatus() {
        throw error;
      },
      onComplete() {
        calls.push('complete');
      },
      retireAfterResponse() {
        calls.push('retire');
      },
    };
    expect(() => publish(options, { request: {} }, { ok: true, status: {}, result: {} })).toThrow(error);
    expect(calls).toEqual([]);
  });
});
