import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ScipDatabase } from '../../src/storage/db.js';
import { importedMemberCallTargets } from '../../src/symbols/graph/member-call-targets.js';
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

  function createDb(
    files: Record<string, readonly string[]>,
    indexed?: { file: string; leaf: string; parentType?: string },
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
      const symbol = `scip-typescript npm fixture 1.0.0 ${indexed.file}/${owner}${indexed.leaf}().`;
      builder
        .symbol(1, symbol, indexed.leaf, 12)
        .definition(1, documentId, 1, 0, 0, 0, 1)
        .chunk(1, documentId, 0, 0)
        .mention(1, 1, 1);
    }
    builder.write();
    return new ScipDatabase({ projectRoot: root, dbPath: join(root, 'index.db'), indexPath: join(root, 'index.scip') });
  }
});
