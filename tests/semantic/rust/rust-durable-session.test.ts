import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { IndexedDefinition } from '../../../src/domain/types.js';
import {
  DURABLE_RUST_SESSION_PROTOCOL_VERSION,
  DurableRustSessionHost,
  createDurableRustAnalyzerSessionRequester,
  createDurableRustSessionIdentity,
  durableRustSessionDirectory,
  isDurableRustSessionStateLive,
  rustCompilerSessionEnvironment,
  durableSettleDelayMs,
  type DurableRustSessionRequest,
  type DurableRustSessionIdentityRuntime,
} from '../../../src/semantic/rust/durable-session.js';
import type { RustReferenceWorkerRequest } from '../../../src/semantic/rust/lsp-batch-worker.js';
import type {
  RustAnalyzerSessionRequester,
  RustImportDefinitionWorkerRequest,
} from '../../../src/semantic/rust/lsp-session.js';
import { rustAnalyzerProjectFingerprint } from '../../../src/semantic/rust/project-fingerprint.js';
import { processDurableRustSessionRequests } from '../../../src/semantic/rust/durable-session-server.js';

const definition: IndexedDefinition = {
  symbolId: 1,
  symbol: 'rust-analyzer cargo fixture 0.1.0 src/lib.rs/run().',
  documentId: 1,
  startLine: 0,
  startChar: 0,
  endLine: 2,
  endChar: 1,
  relativePath: 'src/lib.rs',
  leaf: 'run',
  parentTypeName: null,
  isFunctionLike: true,
  isTypeLike: false,
  kind: 12,
  documentation: null,
  enclosingSymbol: null,
};

const semanticRequest: RustReferenceWorkerRequest = {
  projectRoot: '/repo',
  rustAnalyzerBinary: '/bin/rust-analyzer',
  definitions: [definition],
  requestTimeoutMs: 15_000,
  diagnosticsTimeoutMs: 10_000,
  settleDelayMs: 5_000,
  concurrency: 8,
  includeReferences: true,
};

const importDefinitionRequest: RustImportDefinitionWorkerRequest = {
  projectRoot: '/repo',
  rustAnalyzerBinary: '/bin/rust-analyzer',
  file: 'src/lib.rs',
  positions: [{ id: 'import-1', file: 'src/lib.rs', line: 0, column: 4 }],
  requestTimeoutMs: 15_000,
  diagnosticsTimeoutMs: 10_000,
  settleDelayMs: 5_000,
  concurrency: 8,
};

const compilerEnvironment = {
  HOME: '/home/test',
  PATH: '/bin',
  CARGO_HOME: '/cargo',
  RA_LOG: 'warn',
  RUSTFLAGS: '-Dwarnings',
};

describe('durable Rust semantic session identity', () => {
  it('uses mailbox protocol version 2', () => {
    expect(DURABLE_RUST_SESSION_PROTOCOL_VERSION).toBe(2);
  });

  it('is stable for the same compiler inputs', () => {
    const runtime = identityRuntime();

    const first = createDurableRustSessionIdentity(
      '/repo',
      '/dist/rust-semantic-session-worker.js',
      semanticRequest,
      runtime,
    );
    const second = createDurableRustSessionIdentity(
      '/repo',
      '/dist/rust-semantic-session-worker.js',
      semanticRequest,
      runtime,
    );

    expect(first).toEqual(second);
  });

  it('keeps one compiler-session key across request policy, product, profile, and SCIP routing changes', () => {
    const baseline = createDurableRustSessionIdentity(
      '/repo',
      '/dist/rust-semantic-session-worker.js',
      semanticRequest,
      identityRuntime(),
    );
    const variants: Array<{
      name: string;
      request?: RustReferenceWorkerRequest;
      runtime?: DurableRustSessionIdentityRuntime;
    }> = [
      { name: 'request timeout', request: { ...semanticRequest, requestTimeoutMs: 1 } },
      { name: 'diagnostics timeout', request: { ...semanticRequest, diagnosticsTimeoutMs: 2 } },
      { name: 'settle delay', request: { ...semanticRequest, settleDelayMs: 0 } },
      { name: 'concurrency', request: { ...semanticRequest, concurrency: 32 } },
      { name: 'reference retry timeout', request: { ...semanticRequest, referenceRetryTimeoutMs: 3 } },
      {
        name: 'requested reference/callee/signature products',
        request: {
          ...semanticRequest,
          referenceDefinitions: [definition],
          calleeDefinitions: [definition],
          signatureDefinitions: [definition],
          includeReferences: false,
          includeCallees: true,
          includeSignatures: true,
        },
      },
      {
        name: 'profiling output and thresholds',
        runtime: identityRuntime({
          environment: {
            ...compilerEnvironment,
            SCIP_QUERY_PROFILE: '1',
            SCIP_QUERY_PROFILE_CACHE_STATE: 'cold',
            SCIP_QUERY_PROFILE_COMMAND: 'scip-query health',
            SCIP_QUERY_PROFILE_OUT: '/tmp/profile.jsonl',
            SCIP_QUERY_PROFILE_MIN_MS: '25',
          },
        }),
      },
      {
        name: 'SCIP occurrence routing',
        runtime: identityRuntime({
          environment: {
            ...compilerEnvironment,
            SCIP_RUST_SCIP_OCCURRENCE_REFERENCE_MODE: 'all',
          },
        }),
      },
    ];

    for (const variant of variants) {
      const identity = createDurableRustSessionIdentity(
        '/repo',
        '/dist/rust-semantic-session-worker.js',
        variant.request ?? semanticRequest,
        variant.runtime ?? identityRuntime(),
      );
      expect(identity.key, variant.name).toBe(baseline.key);
    }
  });

  it('changes for canonical root, project, engine, worker, and compiler startup inputs', () => {
    const baseline = createDurableRustSessionIdentity(
      '/repo',
      '/dist/rust-semantic-session-worker.js',
      semanticRequest,
      identityRuntime(),
    );
    const variants: Array<[string, DurableRustSessionIdentityRuntime]> = [
      ['canonical project root', identityRuntime({ canonicalProjectRoot: '/canonical/repo-b' })],
      ['Rust source fingerprint', identityRuntime({ projectFingerprint: 'source-b' })],
      ['Cargo fingerprint', identityRuntime({ projectFingerprint: 'cargo-b' })],
      ['rust-analyzer path', identityRuntime({ resolvedBinary: '/opt/rust-analyzer' })],
      ['rust-analyzer version', identityRuntime({ engineVersion: 'rust-analyzer 2' })],
      ['semantic worker build', identityRuntime({ workerFingerprint: 'worker-b' })],
      ['HOME', identityRuntime({ environment: { ...compilerEnvironment, HOME: '/home/other' } })],
      ['PATH', identityRuntime({ environment: { ...compilerEnvironment, PATH: '/other/bin' } })],
      ['CARGO_*', identityRuntime({ environment: { ...compilerEnvironment, CARGO_HOME: '/other/cargo' } })],
      ['RA_*', identityRuntime({ environment: { ...compilerEnvironment, RA_LOG: 'info' } })],
      ['RUST*', identityRuntime({ environment: { ...compilerEnvironment, RUSTFLAGS: '-C target-cpu=native' } })],
    ];

    for (const [name, runtime] of variants) {
      const identity = createDurableRustSessionIdentity(
        '/repo',
        '/dist/rust-semantic-session-worker.js',
        semanticRequest,
        runtime,
      );
      expect(identity.key, name).not.toBe(baseline.key);
    }
  });

  it('changes for every rust-analyzer project input, including nested Cargo configuration', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'scip-query-rust-project-fingerprint-'));
    const includedPaths = [
      'src/lib.rs',
      'crates/member/src/lib.rs',
      'Cargo.toml',
      'crates/member/Cargo.toml',
      'Cargo.lock',
      'rust-toolchain',
      'rust-toolchain.toml',
      '.cargo/config',
      'crates/member/.cargo/config.toml',
      'rust-project.json',
    ];
    const excludedPaths = [
      'package.json',
      'package-lock.json',
      'tsconfig.json',
      'go.mod',
      'go.sum',
      'pyproject.toml',
      'src/main.ts',
      'src/main.go',
    ];

    try {
      for (const path of [...includedPaths, ...excludedPaths]) writeProjectFile(projectRoot, path, 'baseline');
      const baseline = realDefaultProjectIdentityKey(projectRoot);
      const changedByPath = Object.fromEntries(
        includedPaths.map((path) => {
          writeProjectFile(projectRoot, path, 'changed');
          const changed = realDefaultProjectIdentityKey(projectRoot) !== baseline;
          writeProjectFile(projectRoot, path, 'baseline');
          return [path, changed];
        }),
      );

      expect(changedByPath).toEqual(Object.fromEntries(includedPaths.map((path) => [path, true])));
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('ignores unrelated package, TypeScript, Go, Python, and source inputs', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'scip-query-rust-project-fingerprint-'));
    const includedPaths = ['src/lib.rs', 'Cargo.toml', 'Cargo.lock', '.cargo/config.toml'];
    const excludedPaths = [
      'package.json',
      'package-lock.json',
      'tsconfig.json',
      'go.mod',
      'go.sum',
      'pyproject.toml',
      'src/main.ts',
      'src/main.go',
    ];

    try {
      for (const path of [...includedPaths, ...excludedPaths]) writeProjectFile(projectRoot, path, 'baseline');
      const baseline = realDefaultProjectIdentityKey(projectRoot);
      const changedByPath = Object.fromEntries(
        excludedPaths.map((path) => {
          writeProjectFile(projectRoot, path, 'changed');
          const changed = realDefaultProjectIdentityKey(projectRoot) !== baseline;
          writeProjectFile(projectRoot, path, 'baseline');
          return [path, changed];
        }),
      );

      expect(changedByPath).toEqual(Object.fromEntries(excludedPaths.map((path) => [path, false])));
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe('DurableRustSessionHost', () => {
  it('reuses the requester for the same identity and replaces it before a changed identity runs', () => {
    const events: string[] = [];
    let requesterNumber = 0;
    const host = new DurableRustSessionHost(() => fakeRequester(++requesterNumber, events));

    const created = host.handle({
      kind: 'semantic',
      identityKey: 'identity-a',
      request: semanticRequest,
      timeoutMs: 1_000,
    });
    const reused = host.handle({
      kind: 'semantic',
      identityKey: 'identity-a',
      request: semanticRequest,
      timeoutMs: 1_000,
    });
    const invalidated = host.handle({
      kind: 'semantic',
      identityKey: 'identity-b',
      request: semanticRequest,
      timeoutMs: 1_000,
    });

    expect([created.session, reused.session, invalidated.session]).toEqual(['created', 'reused', 'invalidated']);
    expect(events).toEqual(['request:1', 'request:1', 'shutdown:1', 'request:2']);

    host.shutdown();
    expect(events).toEqual(['request:1', 'request:1', 'shutdown:1', 'request:2', 'shutdown:2']);
  });

  it('applies the requesting command environment before creating or reusing a worker', () => {
    const events: string[] = [];
    const host = new DurableRustSessionHost(
      () => {
        events.push('create');
        return fakeRequester(1, events);
      },
      (environment) => events.push(`env:${environment['SCIP_QUERY_PROFILE_OUT'] ?? 'none'}`),
    );

    host.handle({
      kind: 'semantic',
      identityKey: 'identity-a',
      workerEnvironment: { SCIP_QUERY_PROFILE_OUT: '/tmp/first.jsonl' },
      request: semanticRequest,
      timeoutMs: 1_000,
    });
    host.handle({
      kind: 'semantic',
      identityKey: 'identity-a',
      workerEnvironment: { SCIP_QUERY_PROFILE_OUT: '/tmp/second.jsonl' },
      request: semanticRequest,
      timeoutMs: 1_000,
    });

    expect(events.slice(0, 5)).toEqual([
      'env:/tmp/first.jsonl',
      'create',
      'request:1',
      'env:/tmp/second.jsonl',
      'request:1',
    ]);
  });

  it('reuses compatible policy shapes and forwards each current request unchanged', () => {
    const forwarded: RustReferenceWorkerRequest[] = [];
    const requester = fakeRequester(1, []);
    const host = new DurableRustSessionHost(() => ({
      ...requester,
      requestSemantic(request) {
        forwarded.push(request);
        return {
          available: true,
          references: request.definitions.map((entry) => [entry.symbolId, []]),
        };
      },
    }));
    const firstRequest = { ...semanticRequest, requestTimeoutMs: 1_000, settleDelayMs: 0 };
    const secondRequest = { ...semanticRequest, requestTimeoutMs: 9_000, settleDelayMs: 2_500, concurrency: 32 };

    host.handle({
      kind: 'semantic',
      identityKey: 'identity-a',
      request: firstRequest,
      timeoutMs: 1_000,
    });
    host.handle({
      kind: 'semantic',
      identityKey: 'identity-a',
      request: secondRequest,
      timeoutMs: 1_000,
    });

    expect(forwarded).toEqual([firstRequest, secondRequest]);
    expect(forwarded[0]).toBe(firstRequest);
    expect(forwarded[1]).toBe(secondRequest);
  });

  it('replaces managed environment exactly and invalidates before the changed compiler request runs', () => {
    const previousManagedEnvironment = captureManagedWorkerEnvironment();
    const events: string[] = [];
    let requesterNumber = 0;
    const host = new DurableRustSessionHost(() => {
      const id = ++requesterNumber;
      events.push(
        `create:${id}:${process.env['CARGO_TASK_3_SESSION'] ?? 'none'}:${process.env['SCIP_RUST_TASK_3_SESSION'] ?? 'none'}:${process.env['SCIP_QUERY_PROFILE_OUT'] ?? 'none'}`,
      );
      const requester = fakeRequester(id, events);
      return {
        ...requester,
        requestSemantic(request) {
          events.push(
            `work:${id}:${process.env['CARGO_TASK_3_SESSION'] ?? 'none'}:${process.env['SCIP_RUST_TASK_3_SESSION'] ?? 'none'}:${process.env['SCIP_QUERY_PROFILE_OUT'] ?? 'none'}`,
          );
          return {
            available: true,
            references: request.definitions.map((entry) => [entry.symbolId, []]),
          };
        },
      };
    });

    try {
      host.handle({
        kind: 'semantic',
        identityKey: 'compiler-a',
        workerEnvironment: {
          HOME: '/home/a',
          PATH: '/bin/a',
          CARGO_TASK_3_SESSION: 'compiler-a',
          SCIP_RUST_TASK_3_SESSION: 'transient-a',
          SCIP_QUERY_PROFILE_OUT: '/tmp/a.jsonl',
        },
        request: semanticRequest,
        timeoutMs: 1_000,
      });
      host.handle({
        kind: 'semantic',
        identityKey: 'compiler-b',
        workerEnvironment: {
          HOME: '/home/b',
          PATH: '/bin/b',
        },
        request: semanticRequest,
        timeoutMs: 1_000,
      });

      expect(events).toEqual([
        'create:1:compiler-a:transient-a:/tmp/a.jsonl',
        'work:1:compiler-a:transient-a:/tmp/a.jsonl',
        'shutdown:1',
        'create:2:none:none:none',
        'work:2:none:none:none',
      ]);
    } finally {
      host.shutdown();
      restoreManagedWorkerEnvironment(previousManagedEnvironment);
    }
  });
});

describe('durable Rust semantic readiness', () => {
  it('defaults durable settle to zero and honors only explicit nonnegative integers', () => {
    expect(durableSettleDelayMs(undefined)).toBe(0);
    expect(durableSettleDelayMs('0')).toBe(0);
    expect(durableSettleDelayMs('2500')).toBe(2_500);
    expect(durableSettleDelayMs('-1')).toBe(0);
    expect(durableSettleDelayMs('1.5')).toBe(0);
    expect(durableSettleDelayMs('not-a-number')).toBe(0);
  });

  it('captures only sorted compiler startup inputs', () => {
    expect(
      rustCompilerSessionEnvironment({
        PATH: '/bin',
        HOME: '/home/test',
        CARGO_HOME: '/cargo',
        CARGO_ENCODED_RUSTFLAGS: 'a\u001fb',
        RUSTUP_TOOLCHAIN: 'stable',
        RUSTFLAGS: '-Dwarnings',
        RA_LOG: 'info',
        SCIP_RUST_SEMANTIC_PARALLEL_OPERATIONS: '1',
        SCIP_QUERY_PROFILE: '1',
        UNRELATED: 'ignored',
      }),
    ).toEqual({
      CARGO_ENCODED_RUSTFLAGS: 'a\u001fb',
      CARGO_HOME: '/cargo',
      HOME: '/home/test',
      PATH: '/bin',
      RA_LOG: 'info',
      RUSTFLAGS: '-Dwarnings',
      RUSTUP_TOOLCHAIN: 'stable',
    });
  });
});

describe('durable Rust semantic server state', () => {
  it('trusts only current-protocol, recently-heartbeating, live processes', () => {
    const live = {
      protocolVersion: DURABLE_RUST_SESSION_PROTOCOL_VERSION,
      pid: 123,
      heartbeatAtMs: 9_500,
    };

    expect(isDurableRustSessionStateLive(live, 10_000, (pid) => pid === 123)).toBe(true);
    expect(isDurableRustSessionStateLive({ ...live, protocolVersion: 0 }, 10_000, () => true)).toBe(false);
    expect(isDurableRustSessionStateLive({ ...live, heartbeatAtMs: 1_000 }, 10_000, () => true)).toBe(false);
    expect(isDurableRustSessionStateLive(live, 10_000, () => false)).toBe(false);
  });

  it('scopes mailbox state to the canonical project and helper installation', () => {
    const first = durableRustSessionDirectory('/repo', '/dist-a/server.js', '/tmp');

    expect(first).toBe(durableRustSessionDirectory('/repo', '/dist-a/server.js', '/tmp'));
    expect(first).not.toBe(durableRustSessionDirectory('/other', '/dist-a/server.js', '/tmp'));
    expect(first).not.toBe(durableRustSessionDirectory('/repo', '/dist-b/server.js', '/tmp'));
  });

  it('changes the mailbox namespace when the helper build changes at the same path', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'scip-query-durable-session-namespace-test-'));
    const serverPath = join(tempRoot, 'server.js');
    try {
      writeFileSync(serverPath, 'first build');
      const first = durableRustSessionDirectory('/repo', serverPath, tempRoot);
      writeFileSync(serverPath, 'second build');
      const second = durableRustSessionDirectory('/repo', serverPath, tempRoot);

      expect(second).not.toBe(first);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

describe('durable Rust semantic requester', () => {
  it('copies semantic requests with the injected-clock readiness margin and preserves the request settle', () => {
    const previousSettle = process.env['SCIP_RUST_SEMANTIC_SETTLE_MS'];
    delete process.env['SCIP_RUST_SEMANTIC_SETTLE_MS'];
    const request: RustReferenceWorkerRequest = {
      ...semanticRequest,
      readinessDeadlineMs: 123,
      settleDelayMs: 4_000,
    };
    const original = { ...request };

    try {
      const captured = captureDurableMailboxRequest('semantic', request, 5_000, 10_000);

      expect(captured.kind).toBe('semantic');
      expect(captured.request).toEqual({
        ...request,
        readinessDeadlineMs: 14_000,
        settleDelayMs: 4_000,
      });
      expect(request).toEqual(original);
    } finally {
      restoreEnv('SCIP_RUST_SEMANTIC_SETTLE_MS', previousSettle);
    }
  });

  it('copies import-definition requests with the same margin and explicit durable settle policy', () => {
    const previousSettle = process.env['SCIP_RUST_SEMANTIC_SETTLE_MS'];
    process.env['SCIP_RUST_SEMANTIC_SETTLE_MS'] = '2500';
    const request: RustImportDefinitionWorkerRequest = {
      ...importDefinitionRequest,
      readinessDeadlineMs: 456,
      settleDelayMs: 9_000,
    };
    const original = { ...request };

    try {
      const captured = captureDurableMailboxRequest('import-definitions', request, 1_000, 20_000);

      expect(captured.kind).toBe('import-definitions');
      expect(captured.request).toEqual({
        ...request,
        readinessDeadlineMs: 20_001,
        settleDelayMs: 2_500,
      });
      expect(request).toEqual(original);
    } finally {
      restoreEnv('SCIP_RUST_SEMANTIC_SETTLE_MS', previousSettle);
    }
  });

  it('reconnects through shared state and restarts a dead helper', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'scip-query-durable-session-test-'));
    const profilePath = join(tempRoot, 'profile.jsonl');
    const previousProfile = process.env['SCIP_QUERY_PROFILE'];
    const previousProfileOut = process.env['SCIP_QUERY_PROFILE_OUT'];
    process.env['SCIP_QUERY_PROFILE'] = '1';
    process.env['SCIP_QUERY_PROFILE_OUT'] = profilePath;
    let nowMs = 10_000;
    let nextId = 1;
    let spawnCount = 0;
    let serverPid = 123;
    const processPendingRequests = (sessionDir: string): void => {
      const requestDir = join(sessionDir, 'requests');
      const responseDir = join(sessionDir, 'responses');
      for (const file of readdirSync(requestDir)) {
        const message = JSON.parse(readFileSync(join(requestDir, file), 'utf8')) as {
          id: string;
          request: { request: RustReferenceWorkerRequest };
        };
        writeFileSync(
          join(responseDir, `${message.id}.json`),
          JSON.stringify({
            ok: true,
            session: 'reused',
            response: {
              available: true,
              references: message.request.request.definitions.map((entry) => [entry.symbolId, []]),
            },
          }),
        );
        rmSync(join(requestDir, file), { force: true });
      }
    };
    const runtime = {
      now: () => nowMs,
      randomId: () => `request-${nextId++}`,
      isProcessAlive: (pid: number) => pid === serverPid,
      spawnServer: (_serverPath: string, sessionDir: string) => {
        spawnCount += 1;
        mkdirSync(join(sessionDir, 'requests'), { recursive: true });
        mkdirSync(join(sessionDir, 'responses'), { recursive: true });
        writeFileSync(
          join(sessionDir, 'server.json'),
          JSON.stringify({
            protocolVersion: DURABLE_RUST_SESSION_PROTOCOL_VERSION,
            pid: serverPid,
            heartbeatAtMs: nowMs,
          }),
        );
      },
      sleep: (durationMs: number) => {
        nowMs += durationMs;
        const sessionDir = durableRustSessionDirectory('/repo', '/dist/server.js', tempRoot);
        processPendingRequests(sessionDir);
      },
    };

    try {
      const first = createDurableRustAnalyzerSessionRequester('/repo', {
        serverPath: '/dist/server.js',
        semanticWorkerPath: '/dist/worker.js',
        tempRoot,
        identityRuntime: identityRuntime(),
        runtime,
      });
      expect(first.requestSemantic(semanticRequest, 1_000).references).toEqual([[1, []]]);
      first.shutdown();

      const second = createDurableRustAnalyzerSessionRequester('/repo', {
        serverPath: '/dist/server.js',
        semanticWorkerPath: '/dist/worker.js',
        tempRoot,
        identityRuntime: identityRuntime(),
        runtime,
      });
      expect(second.requestSemantic(semanticRequest, 1_000).references).toEqual([[1, []]]);
      expect(spawnCount).toBe(1);

      serverPid = 456;
      expect(second.requestSemantic(semanticRequest, 1_000).references).toEqual([[1, []]]);
      expect(spawnCount).toBe(2);
      expect(
        readFileSync(profilePath, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as { name?: string; session?: string })
          .filter((event) => event.name === 'rust.semantic.durable-session.request')
          .map((event) => event.session),
      ).toEqual(['reused', 'reused', 'reused']);
    } finally {
      restoreEnv('SCIP_QUERY_PROFILE', previousProfile);
      restoreEnv('SCIP_QUERY_PROFILE_OUT', previousProfileOut);
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

describe('durable Rust semantic helper shell', () => {
  it('processes an atomic mailbox request and records the session disposition', () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'scip-query-durable-session-server-test-'));
    const requestDir = join(sessionDir, 'requests');
    const responseDir = join(sessionDir, 'responses');
    mkdirSync(requestDir, { recursive: true });
    mkdirSync(responseDir, { recursive: true });
    writeFileSync(
      join(requestDir, 'request-1.json'),
      JSON.stringify({
        id: 'request-1',
        request: {
          kind: 'semantic',
          identityKey: 'identity-a',
          request: semanticRequest,
          timeoutMs: 1_000,
        },
      }),
    );
    const events: string[] = [];
    const host = new DurableRustSessionHost(() => fakeRequester(1, events));

    try {
      expect(processDurableRustSessionRequests(sessionDir, host)).toBe(1);
      expect(readdirSync(requestDir)).toEqual([]);
      expect(JSON.parse(readFileSync(join(responseDir, 'request-1.json'), 'utf8'))).toEqual({
        ok: true,
        session: 'created',
        response: {
          available: true,
          references: [[1, []]],
        },
      });
    } finally {
      host.shutdown();
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });
});

function identityRuntime(
  overrides: {
    canonicalProjectRoot?: string;
    projectFingerprint?: string;
    resolvedBinary?: string;
    engineVersion?: string;
    workerFingerprint?: string;
    environment?: Record<string, string | null>;
  } = {},
): DurableRustSessionIdentityRuntime {
  return {
    canonicalProjectRoot: () => overrides.canonicalProjectRoot ?? '/repo',
    projectFingerprint: () => overrides.projectFingerprint ?? 'source-a',
    engineIdentity: () => ({
      engine: 'rust-analyzer',
      resolvedBinary: overrides.resolvedBinary ?? '/bin/rust-analyzer',
      version: overrides.engineVersion ?? 'rust-analyzer 1',
    }),
    fileFingerprint: () => overrides.workerFingerprint ?? 'worker-a',
    environment: () => overrides.environment ?? compilerEnvironment,
  };
}

function realDefaultProjectIdentityKey(projectRoot: string): string {
  return createDurableRustSessionIdentity(
    projectRoot,
    '/dist/rust-semantic-session-worker.js',
    semanticRequest,
    identityRuntime({
      canonicalProjectRoot: projectRoot,
      projectFingerprint: rustAnalyzerProjectFingerprint(projectRoot),
    }),
  ).key;
}

function writeProjectFile(projectRoot: string, relativePath: string, content: string): void {
  const path = join(projectRoot, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function captureDurableMailboxRequest(
  kind: 'semantic',
  request: RustReferenceWorkerRequest,
  timeoutMs: number,
  initialNowMs: number,
): DurableRustSessionRequest;
function captureDurableMailboxRequest(
  kind: 'import-definitions',
  request: RustImportDefinitionWorkerRequest,
  timeoutMs: number,
  initialNowMs: number,
): DurableRustSessionRequest;
function captureDurableMailboxRequest(
  kind: DurableRustSessionRequest['kind'],
  request: RustReferenceWorkerRequest | RustImportDefinitionWorkerRequest,
  timeoutMs: number,
  initialNowMs: number,
): DurableRustSessionRequest {
  const tempRoot = mkdtempSync(join(tmpdir(), 'scip-query-durable-request-capture-'));
  let nowMs = initialNowMs;
  let captured: DurableRustSessionRequest | undefined;
  const runtime = {
    now: () => nowMs,
    randomId: () => 'request-1',
    isProcessAlive: (pid: number) => pid === 123,
    spawnServer: (_serverPath: string, sessionDir: string) => {
      mkdirSync(join(sessionDir, 'requests'), { recursive: true });
      mkdirSync(join(sessionDir, 'responses'), { recursive: true });
      writeFileSync(
        join(sessionDir, 'server.json'),
        JSON.stringify({
          protocolVersion: DURABLE_RUST_SESSION_PROTOCOL_VERSION,
          pid: 123,
          heartbeatAtMs: nowMs,
        }),
      );
    },
    sleep: (durationMs: number) => {
      nowMs += durationMs;
      const sessionDir = durableRustSessionDirectory('/repo', '/dist/server.js', tempRoot);
      const requestPath = join(sessionDir, 'requests', 'request-1.json');
      const message = JSON.parse(readFileSync(requestPath, 'utf8')) as {
        id: string;
        request: DurableRustSessionRequest;
      };
      captured = message.request;
      const response =
        captured.kind === 'semantic'
          ? { available: true, references: captured.request.definitions.map((entry) => [entry.symbolId, []]) }
          : { available: true, sourcePaths: captured.request.positions.map((position) => [position.id, null]) };
      writeFileSync(
        join(sessionDir, 'responses', `${message.id}.json`),
        JSON.stringify({ ok: true, session: 'reused', response }),
      );
    },
  };

  try {
    const requester = createDurableRustAnalyzerSessionRequester('/repo', {
      serverPath: '/dist/server.js',
      semanticWorkerPath: '/dist/worker.js',
      tempRoot,
      identityRuntime: identityRuntime(),
      runtime,
    });
    if (kind === 'semantic') requester.requestSemantic(request as RustReferenceWorkerRequest, timeoutMs);
    else requester.requestImportDefinitions(request as RustImportDefinitionWorkerRequest, timeoutMs);
    requester.shutdown();
    if (!captured) throw new Error('Expected the durable requester to publish a mailbox request.');
    return captured;
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function fakeRequester(id: number, events: string[]): RustAnalyzerSessionRequester {
  return {
    requestSemantic(request) {
      events.push(`request:${id}`);
      return {
        available: true,
        references: request.definitions.map((entry) => [entry.symbolId, []]),
      };
    },
    requestImportDefinitions(request) {
      events.push(`request:${id}`);
      return {
        available: true,
        sourcePaths: request.positions.map((position) => [position.id, null]),
      };
    },
    shutdown() {
      events.push(`shutdown:${id}`);
    },
  };
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function captureManagedWorkerEnvironment(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter(([key, value]) => isManagedWorkerKey(key) && value));
}

function restoreManagedWorkerEnvironment(environment: Record<string, string>): void {
  for (const key of Object.keys(process.env)) {
    if (isManagedWorkerKey(key)) delete process.env[key];
  }
  Object.assign(process.env, environment);
}

function isManagedWorkerKey(key: string): boolean {
  return (
    key === 'HOME' ||
    key === 'PATH' ||
    key.startsWith('CARGO_') ||
    key.startsWith('RA_') ||
    key.startsWith('RUST') ||
    key.startsWith('SCIP_RUST_') ||
    key === 'SCIP_QUERY_PROFILE' ||
    key === 'SCIP_QUERY_PROFILE_CACHE_STATE' ||
    key === 'SCIP_QUERY_PROFILE_COMMAND' ||
    key === 'SCIP_QUERY_PROFILE_OUT' ||
    key === 'SCIP_QUERY_PROFILE_MIN_MS'
  );
}
