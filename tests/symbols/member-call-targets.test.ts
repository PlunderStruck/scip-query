import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ScipDatabase } from '../../src/storage/db.js';
import {
  importedMemberCallTargets,
  serviceDeclarationFilesForImplementation,
} from '../../src/symbols/graph/member-call-targets.js';
import { sourceRangeNextAnchorPacket } from '../../src/queries/internal/next-anchor-candidates.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../fixtures/evidence-fixture.js';

describe('imported member call targets', () => {
  let root: string | null = null;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = null;
  });

  it('admits one directly imported source file that declares the callable leaf', () => {
    const db = createDb({
      'src/registry.ts': [
        "import { controller } from './controller.js';",
        'const dispatchController = controller;',
        'export const registry = { run: () => dispatchController.handle() };',
      ],
      'src/controller.ts': ['export const controller = {', '  async handle() { return 1; },', '};'],
    });
    try {
      expect(importedMemberCallTargets(db, 'src/registry.ts', { ranges: [{ startLine: 1, endLine: 2 }] })).toEqual({
        targets: [
          {
            calleeLeaf: 'handle',
            line: 2,
            sourceFile: 'src/registry.ts',
            targetFile: 'src/controller.ts',
            targetStartLine: 1,
            targetEndLine: 1,
            resolution: 'direct-import-receiver',
            strength: 'candidate',
          },
        ],
        unresolvedCallsites: 0,
      });
    } finally {
      db.close();
    }
  });

  it('does not guess when two directly imported files declare the same member', () => {
    const db = createDb({
      'src/registry.ts': [
        "import { controllerA as controller } from './controller-a.js';",
        "import { controllerB as controller } from './controller-b.js';",
        'export const registry = { run: () => controller.handle() };',
      ],
      'src/controller-a.ts': ['export const controllerA = { handle() { return 1; } };'],
      'src/controller-b.ts': ['export const controllerB = { handle() { return 2; } };'],
    });
    try {
      expect(importedMemberCallTargets(db, 'src/registry.ts')).toEqual({
        targets: [],
        unresolvedCallsites: 1,
      });
    } finally {
      db.close();
    }
  });

  it('does not attribute an unrelated local receiver by leaf name alone', () => {
    const db = createDb({
      'src/registry.ts': [
        "import { helper } from './helper.js';",
        'const local = { handle() { return 1; } };',
        'export const registry = { run: () => local.handle() };',
      ],
      'src/helper.ts': ['export const helper = { handle() { return 2; } };'],
    });
    try {
      expect(importedMemberCallTargets(db, 'src/registry.ts')).toEqual({
        targets: [],
        unresolvedCallsites: 1,
      });
    } finally {
      db.close();
    }
  });

  it('leaves member calls already resolved by an indexed symbol to the compiler graph', () => {
    const db = createDb(
      {
        'src/registry.ts': [
          "import { controller } from './controller.js';",
          'export const registry = { run: () => controller.handle() };',
        ],
        'src/controller.ts': ['export function handle() { return 1; }', 'export const controller = { handle };'],
      },
      { file: 'src/controller.ts', leaf: 'handle' },
    );
    try {
      expect(importedMemberCallTargets(db, 'src/registry.ts')).toEqual({
        targets: [],
        unresolvedCallsites: 0,
      });
    } finally {
      db.close();
    }
  });

  it('resolves a this-field constructed from one imported class to that class method', () => {
    const db = createDb(
      {
        'src/service.ts': [
          "import { EventService } from './event-service.js';",
          'export class Service {',
          '  private readonly events: EventService;',
          '  constructor() { this.events = new EventService(); }',
          '  run() { return this.events.append(); }',
          '}',
        ],
        'src/event-service.ts': ['export class EventService {', '  append() { return 1; }', '}'],
      },
      { file: 'src/event-service.ts', leaf: 'append', parentType: 'EventService' },
    );
    try {
      const result = importedMemberCallTargets(db, 'src/service.ts', {
        ranges: [{ startLine: 4, endLine: 4 }],
        excludeIndexedTargets: false,
      });
      expect(result.unresolvedCallsites).toBe(0);
      expect(result.targets).toEqual([
        expect.objectContaining({
          calleeLeaf: 'append',
          line: 4,
          sourceFile: 'src/service.ts',
          targetFile: 'src/event-service.ts',
          targetStartLine: 1,
          targetEndLine: 1,
          resolution: 'constructed-member-receiver',
          strength: 'exact',
        }),
      ]);
      expect(result.targets[0]?.targetSymbol).toContain('EventService#append().');
    } finally {
      db.close();
    }
  });

  it('resolves a yielded imported service through its assembled object member', () => {
    const db = createDb({
      'src/runner.ts': [
        "import { SessionCompaction } from './compaction.js';",
        'export function* run() {',
        '  const compaction = yield* SessionCompaction.Service;',
        '  return yield* compaction.process();',
        '}',
      ],
      'src/compaction.ts': [
        "const processCompaction = Effect.fn('SessionCompaction.process')(function* () {",
        "  return 'done';",
        '});',
        'export const layer = Service.of({ process: processCompaction });',
      ],
    });
    try {
      expect(importedMemberCallTargets(db, 'src/runner.ts')).toEqual({
        targets: [
          {
            calleeLeaf: 'processCompaction',
            line: 3,
            sourceFile: 'src/runner.ts',
            targetFile: 'src/compaction.ts',
            targetStartLine: 0,
            targetEndLine: 2,
            serviceFile: 'src/compaction.ts',
            resolutionAlternativeCount: 1,
            resolution: 'imported-service-object-member',
            strength: 'candidate',
          },
        ],
        unresolvedCallsites: 0,
      });
      expect(
        sourceRangeNextAnchorPacket(db, [
          { id: 'runner', label: 'run', file: 'src/runner.ts', startLine: 1, endLine: 4 },
        ]).anchors,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            status: 'derived',
            source: 'graph-call',
            callsite: expect.objectContaining({ calleeLeaf: 'process' }),
            alternatives: [expect.objectContaining({ file: 'src/compaction.ts', line: 0, endLine: 2 })],
            evidence: [expect.objectContaining({ method: 'ast-service-member-callsite', strength: 'derived' })],
          }),
        ]),
      );
    } finally {
      db.close();
    }
  });

  it('resolves an inline wrapped service member implementation', () => {
    const db = createDb({
      'src/public.ts': [
        "import * as Sessions from './sessions.js';",
        'export function* invoke() {',
        '  const sessions = yield* Sessions.Service;',
        '  return yield* sessions.prompt();',
        '}',
      ],
      'src/sessions.ts': [
        'export class Service {}',
        'export const layer = Layer.effect(Service, Effect.gen(function* () {',
        "  return Service.of({ prompt: Effect.fn('Sessions.prompt')(function* () {",
        "    return 'accepted';",
        '  }) });',
        '}));',
      ],
    });
    try {
      expect(importedMemberCallTargets(db, 'src/public.ts')).toEqual({
        targets: [
          expect.objectContaining({
            calleeLeaf: 'prompt',
            line: 3,
            targetFile: 'src/sessions.ts',
            targetStartLine: 2,
            targetEndLine: 4,
            resolution: 'imported-service-object-member',
          }),
        ],
        unresolvedCallsites: 0,
      });
    } finally {
      db.close();
    }
  });

  it('resolves a Service.use callback through the unique provider file', () => {
    const db = createDb(
      {
        'src/execution.ts': [
          "import * as Runner from './runner.js';",
          'export function execute() {',
          '  return Runner.Service.use((runner) => runner.run());',
          '}',
        ],
        'src/runner.ts': ['export class Service {}'],
        'src/provider.ts': [
          "import { Service } from './runner.js';",
          "const run = Effect.fn('Runner.run')(function* () { return 'done'; });",
          'export const layer = Layer.effect(Service, Effect.gen(function* () {',
          '  return Service.of({ run });',
          '}));',
        ],
      },
      { file: 'src/runner.ts', leaf: 'Service', type: true, references: ['src/provider.ts', 'src/execution.ts'] },
    );
    try {
      expect(serviceDeclarationFilesForImplementation(db, 'src/provider.ts')).toEqual(['src/runner.ts']);
      expect(importedMemberCallTargets(db, 'src/execution.ts')).toEqual({
        targets: [
          expect.objectContaining({
            calleeLeaf: 'run',
            line: 2,
            targetFile: 'src/provider.ts',
            targetStartLine: 1,
            targetEndLine: 1,
            resolution: 'imported-service-object-member',
          }),
        ],
        unresolvedCallsites: 1,
      });
    } finally {
      db.close();
    }
  });

  it('resolves a delegated service member to its provider container', () => {
    const db = createDb({
      'src/caller.ts': [
        "import * as Execution from './execution.js';",
        'export function* prompt() {',
        '  const execution = yield* Execution.Service;',
        '  return yield* execution.wake();',
        '}',
      ],
      'src/execution.ts': [
        'export class Service {}',
        'export const layer = Layer.effect(Service, Effect.gen(function* () {',
        '  const coordinator = yield* makeCoordinator();',
        '  return Service.of({ wake: coordinator.wake });',
        '}));',
      ],
    });
    try {
      expect(importedMemberCallTargets(db, 'src/caller.ts')).toEqual({
        targets: [
          expect.objectContaining({
            calleeLeaf: 'layer',
            line: 3,
            targetFile: 'src/execution.ts',
            targetStartLine: 1,
            targetEndLine: 4,
            resolution: 'imported-service-object-member',
          }),
        ],
        unresolvedCallsites: 0,
      });
    } finally {
      db.close();
    }
  });

  it('resolves a service member delegated through a uniquely returned factory member', () => {
    const db = createDb(
      {
        'src/caller.ts': [
          "import * as Execution from './execution.js';",
          'export function* prompt() {',
          '  const execution = yield* Execution.Service;',
          '  return yield* execution.wake();',
          '}',
        ],
        'src/execution.ts': ['export class Service {}'],
        'src/provider.ts': [
          "import * as Execution from './execution.js';",
          "import * as Coordinator from './coordinator.js';",
          'export const layer = Layer.effect(Execution.Service, Effect.gen(function* () {',
          '  const coordinator = yield* Coordinator.make();',
          '  return Execution.Service.of({ wake: coordinator.wake });',
          '}));',
        ],
        'src/coordinator.ts': [
          'export const make = () => Effect.gen(function* () {',
          "  const wake = () => 'awake';",
          '  return { wake };',
          '});',
        ],
      },
      { file: 'src/execution.ts', leaf: 'Service', type: true, references: ['src/provider.ts', 'src/caller.ts'] },
    );
    try {
      expect(importedMemberCallTargets(db, 'src/caller.ts')).toEqual({
        targets: [
          expect.objectContaining({
            calleeLeaf: 'wake',
            line: 3,
            targetFile: 'src/coordinator.ts',
            targetStartLine: 1,
            targetEndLine: 1,
            resolutionAlternativeCount: 1,
            resolution: 'imported-service-object-member',
          }),
        ],
        unresolvedCallsites: 0,
      });
    } finally {
      db.close();
    }
  });

  it('binds a delegated factory member to only the callback it causally reaches', () => {
    const db = createDb(
      {
        'src/execution.ts': ['export class Service {}', 'export interface Interface { wake: (id: string) => void }'],
        'src/caller.ts': [
          "import * as Execution from './execution.js';",
          'export const run = Effect.gen(function* () {',
          '  const execution = yield* Execution.Service;',
          "  return execution.wake('session');",
          '});',
        ],
        'src/provider.ts': [
          "import * as Execution from './execution.js';",
          "import * as Coordinator from './coordinator.js';",
          'export const layer = Layer.effect(Execution.Service, Effect.gen(function* () {',
          '  const coordinator = yield* Coordinator.make({',
          '    drain: (id: string) => id,',
          '    onFailure: () => false,',
          '  });',
          '  return Execution.Service.of({ wake: coordinator.wake });',
          '}));',
        ],
        'src/coordinator.ts': [
          'export const make = (options: { drain: (id: string) => string; onFailure: () => boolean }) => {',
          '  const start = (id: string) => options.drain(id);',
          '  const wake = (id: string) => start(id);',
          '  return { wake };',
          '};',
        ],
      },
      { file: 'src/execution.ts', leaf: 'Service', type: true, references: ['src/provider.ts', 'src/caller.ts'] },
    );
    try {
      expect(importedMemberCallTargets(db, 'src/caller.ts')).toEqual({
        targets: [
          expect.objectContaining({
            line: 3,
            targetFile: 'src/provider.ts',
            targetStartLine: 4,
            targetEndLine: 4,
            resolutionAlternativeCount: 1,
            resolution: 'imported-service-object-member',
          }),
        ],
        unresolvedCallsites: 1,
      });
    } finally {
      db.close();
    }
  });

  it('resolves a factory parameter callback to its compiler-resolved object-literal argument', () => {
    const db = createDb(
      {
        'src/factory.ts': [
          'export const make = (options: { drain: () => void }) => {',
          '  const start = () => options.drain();',
          '  return { start };',
          '};',
        ],
        'src/caller.ts': [
          "import { make } from './factory.js';",
          'const drain = () => true;',
          'export const coordinator = make({ drain: drain });',
        ],
      },
      { file: 'src/factory.ts', leaf: 'make', references: ['src/caller.ts'] },
    );
    try {
      expect(importedMemberCallTargets(db, 'src/factory.ts', { excludeIndexedTargets: false })).toEqual({
        targets: [
          expect.objectContaining({
            calleeLeaf: 'drain',
            line: 1,
            targetFile: 'src/caller.ts',
            targetStartLine: 1,
            targetEndLine: 1,
            resolutionAlternativeCount: 1,
            resolution: 'factory-callback-member',
            strength: 'exact',
          }),
        ],
        unresolvedCallsites: 0,
      });
    } finally {
      db.close();
    }
  });

  function createDb(
    files: Record<string, readonly string[]>,
    indexed?: { file: string; leaf: string; parentType?: string; type?: boolean; references?: string[] },
  ): ScipDatabase {
    root = mkdtempSync(join(tmpdir(), 'scip-member-calls-'));
    writeFixtureFiles(root, {
      'package.json': JSON.stringify({ private: true, type: 'module' }),
      'tsconfig.json': JSON.stringify({ compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext' } }),
      ...files,
    });
    const builder = evidenceFixtureDb(join(root, 'index.db'));
    Object.keys(files).forEach((file, index) => builder.document(index + 1, 'typescript', file));
    if (indexed) {
      const documentId = Object.keys(files).indexOf(indexed.file) + 1;
      const owner = indexed.parentType ? `${indexed.parentType}#` : '';
      const descriptor = indexed.type ? `${indexed.leaf}#` : `${owner}${indexed.leaf}().`;
      const symbol = `scip-typescript npm fixture 1.0.0 ${indexed.file}/${descriptor}`;
      builder
        .symbol(1, symbol, indexed.leaf, indexed.type ? 7 : 12)
        .definition(1, documentId, 1, 0, 0, 0, 1)
        .chunk(1, documentId, 0, 0)
        .mention(1, 1, 1);
      indexed.references?.forEach((file, index) => {
        const referenceDocumentId = Object.keys(files).indexOf(file) + 1;
        builder.chunk(index + 2, referenceDocumentId, 0, files[file]!.length - 1).mention(index + 2, 1, 2);
      });
    }
    builder.write();
    return new ScipDatabase({ projectRoot: root, dbPath: join(root, 'index.db'), indexPath: join(root, 'index.scip') });
  }
});
