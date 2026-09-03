import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SymbolInformation_Kind } from '@c4312/scip';
import {
  groupTwins,
  isSingleForwardingCallBody,
  isThinForwarderBody,
  twinDrift,
  type TwinDriftRecord,
} from '../../../src/queries/cleanup/twin-drift.js';
import { ScipDatabase } from '../../../src/storage/db.js';
import type { ScipQueryConfig } from '../../../src/domain/types.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../../fixtures/evidence-fixture.js';

function record(
  overrides: Partial<TwinDriftRecord> & Pick<TwinDriftRecord, 'leaf' | 'file' | 'tokens'>,
): TwinDriftRecord {
  return {
    symbol: `scip-typescript npm fixture 1.0.0 ${overrides.file}/${overrides.leaf}().`,
    shortName: overrides.leaf,
    startLine: 0,
    endLine: 1,
    loc: 2,
    normalizedBody: overrides.tokens.join(''),
    isThinForwarder: false,
    ...overrides,
  };
}

describe('groupTwins (pure)', () => {
  it('flags same-name functions with drifted bodies as divergent', () => {
    const groups = groupTwins([
      record({
        leaf: 'compareProfiles',
        file: 'src/react/a.ts',
        tokens: ['if', '(', 'x', '>', '5', ')', 'return', 'true', ';'],
      }),
      record({
        leaf: 'compareProfiles',
        file: 'src/vue/b.ts',
        tokens: ['if', '(', 'x', '>', '9', ')', 'return', 'true', ';'],
      }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.relationship).toBe('divergent');
    expect(groups[0]?.members.map((m) => m.file)).toEqual(['src/react/a.ts', 'src/vue/b.ts']);
    expect(groups[0]?.firstDivergentTokens).toBeDefined();
  });

  it('defers identical cross-file bodies to duplicate-bodies', () => {
    const tokens = ['return', 'value', '.', 'trim', '(', ')', ';'];
    const groups = groupTwins([
      record({ leaf: 'normalize', file: 'src/a.ts', tokens }),
      record({ leaf: 'normalize', file: 'src/b.ts', tokens }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.relationship).toBe('identical');
  });

  it('drops unrelated short-name homonyms before similarity scoring', () => {
    const groups = groupTwins([
      record({ leaf: 'get', file: 'src/a.ts', tokens: ['return', 'this', '.', 'a', ';'] }),
      record({ leaf: 'get', file: 'src/b.ts', tokens: ['throw', 'new', 'Error', '(', ')', ';'] }),
    ]);

    expect(groups).toHaveLength(0);
  });

  it('clusters near-names (edit distance <= 2, length >= 8) and flags drift', () => {
    const groups = groupTwins([
      record({
        leaf: 'escapeRegex',
        file: 'src/a.ts',
        tokens: ['return', 'value', '.', 'replace', '(', 'PATTERN_A', ',', 'repl', ')', ';'],
      }),
      record({
        leaf: 'escapeRegExp',
        file: 'src/b.ts',
        tokens: ['return', 'value', '.', 'replace', '(', 'PATTERN_B', ',', 'repl', ',', 'extra', ')', ';'],
      }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.relationship).toBe('divergent');
    expect(groups[0]?.members.map((m) => m.file).sort()).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('preserves source record order when a near-name cluster spans leaf buckets', () => {
    const groups = groupTwins([
      record({ leaf: 'escapeRegExp', file: 'src/b.ts', tokens: ['return', 'B', ';'] }),
      record({ leaf: 'escapeRegex', file: 'src/a.ts', tokens: ['return', 'A', ';'] }),
      record({ leaf: 'escapeRegex', file: 'src/c.ts', tokens: ['return', 'C', ';'] }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.members.map((member) => member.file)).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
    expect(groups[0]?.firstDivergentTokens).toBe('A: B ;  |  B: A ;');
  });

  it('does not merge near names without a strong shared prefix', () => {
    const groups = groupTwins([
      record({ leaf: 'StageCard', file: 'src/landing.ts', tokens: ['return', 'Card', '(', 'stage', ')'] }),
      record({ leaf: 'StatCard', file: 'src/report.ts', tokens: ['return', 'Card', '(', 'stat', ')'] }),
    ]);

    expect(groups).toHaveLength(0);
  });

  it('retains exact short-name matches while tightening near-name buckets', () => {
    const groups = groupTwins([
      record({ leaf: 'Cell', shortName: 'Panel:Cell', file: 'src/a.ts', tokens: ['return', 'a', ';'] }),
      record({ leaf: 'cell', shortName: 'Panel:Cell', file: 'src/b.ts', tokens: ['return', 'b', ';'] }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.relationship).toBe('divergent');
  });

  it('requires contextual overlap for very short generic component names', () => {
    const groups = groupTwins([
      record({
        leaf: 'Row',
        file: 'src/slack/SlackConnectButton.tsx',
        shortName: 'SlackConnectButton:Row',
        tokens: ['return', 'div', '(', 'label', ')'],
      }),
      record({
        leaf: 'Row',
        file: 'src/billing/CostBreakdown.tsx',
        shortName: 'CostBreakdown:Row',
        tokens: ['return', 'div', '(', 'amount', ')'],
      }),
    ]);

    expect(groups).toHaveLength(0);
  });

  it('does not cluster short or unrelated names', () => {
    const groups = groupTwins([
      record({ leaf: 'run', file: 'src/a.ts', tokens: ['return', '1', ';'] }),
      record({ leaf: 'runner', file: 'src/b.ts', tokens: ['return', '2', ';'] }),
    ]);

    expect(groups).toHaveLength(0);
  });

  it('does not group same-file definitions (declaration-merged overloads excluded by construction)', () => {
    const groups = groupTwins([
      record({ leaf: 'overload', file: 'src/a.ts', tokens: ['return', '1', ';'] }),
      record({ leaf: 'overload', file: 'src/a.ts', tokens: ['return', '2', ';'] }),
    ]);

    expect(groups).toHaveLength(0);
  });

  // 21.2 calibration retune (external calibration: Stable_Management §6.4,
  // Vega_2.0 §3): every class has a `<constructor>` member — grouping on
  // that literal name matches unrelated classes by naming convention alone.
  it('excludes synthetic `<constructor>`-shaped leaves from grouping', () => {
    const groups = groupTwins([
      record({
        leaf: '<constructor>',
        file: 'src/app-error.ts',
        tokens: ['this', '.', 'message', '=', 'msg', ';'],
      }),
      record({
        leaf: '<constructor>',
        file: 'src/record-builder.ts',
        tokens: ['this', '.', 'items', '=', 'items', ';'],
      }),
    ]);

    expect(groups).toHaveLength(0);
  });

  it('excludes other angle-bracket-wrapped synthetic names the same way', () => {
    const groups = groupTwins([
      record({ leaf: '<computed>', file: 'src/a.ts', tokens: ['return', '1', ';'] }),
      record({ leaf: '<computed>', file: 'src/b.ts', tokens: ['return', '2', ';'] }),
    ]);

    expect(groups).toHaveLength(0);
  });

  it('excludes Python dunder protocol methods that match by convention rather than concept', () => {
    const groups = groupTwins([
      record({
        leaf: '__init__',
        symbol: 'scip-python python fixture 1.0.0 `a`/Alpha#__init__().',
        file: 'src/a.py',
        tokens: ['self', '.', 'value', '=', 'value'],
      }),
      record({
        leaf: '__init__',
        symbol: 'scip-python python fixture 1.0.0 `b`/Beta#__init__().',
        file: 'src/b.py',
        tokens: ['self', '.', 'client', '=', 'Client', '(', ')'],
      }),
    ]);

    expect(groups).toHaveLength(0);
  });

  // 21.2 calibration retune: a same-name pair that only exists inside test
  // files (mocks, parallel suites) is not a drifted-production-twin.
  it('excludes groups where every member lives in a test file', () => {
    const groups = groupTwins([
      record({
        leaf: 'compareProfiles',
        file: 'src/react/__tests__/a.test.ts',
        tokens: ['if', '(', 'x', '>', '5', ')', 'return', 'true', ';'],
      }),
      record({
        leaf: 'compareProfiles',
        file: 'src/vue/__tests__/b.test.ts',
        tokens: ['if', '(', 'x', '>', '9', ')', 'return', 'true', ';'],
      }),
    ]);

    expect(groups).toHaveLength(0);
  });

  it('excludes test helpers even when a production callable shares the name', () => {
    const groups = groupTwins([
      record({
        leaf: 'compareProfiles',
        file: 'src/react/a.ts',
        tokens: ['if', '(', 'x', '>', '5', ')', 'return', 'true', ';'],
      }),
      record({
        leaf: 'compareProfiles',
        file: 'src/react/__tests__/a.test.ts',
        tokens: ['if', '(', 'x', '>', '9', ')', 'return', 'true', ';'],
      }),
    ]);

    expect(groups).toHaveLength(0);
  });

  it('excludes Rust trait implementations that share a required method name', () => {
    const groups = groupTwins([
      record({
        leaf: 'default',
        file: 'src/a.rs',
        symbol: 'rust-analyzer cargo fixture 0.1.0 a/impl#[Alpha][Default]default().',
        tokens: ['Self', '{', 'value', ':', '1', '}'],
      }),
      record({
        leaf: 'default',
        file: 'src/b.rs',
        symbol: 'rust-analyzer cargo fixture 0.1.0 b/impl#[Beta][Default]default().',
        tokens: ['Self', '{', 'value', ':', '2', '}'],
      }),
    ]);

    expect(groups).toHaveLength(0);
  });

  it('does not treat the Rust impl marker as concept context for generic methods', () => {
    const groups = groupTwins([
      record({
        leaf: 'new',
        file: 'src/effects.rs',
        symbol: 'rust-analyzer cargo fixture 0.1.0 effects/impl#[BubbleTrail]new().',
        shortName: 'effects:impl:BubbleTrail:new()',
        tokens: ['Self', '{', 'slots', ':', 'Vec', ':', ':', 'new', '(', ')', '}'],
      }),
      record({
        leaf: 'new',
        file: 'src/transcript.rs',
        symbol: 'rust-analyzer cargo fixture 0.1.0 transcript/impl#[Snapshot]new().',
        shortName: 'transcript:impl:Snapshot:new()',
        tokens: ['Self', '{', 'version', ':', 'VERSION', ',', 'summary', '}'],
      }),
    ]);

    expect(groups).toHaveLength(0);
  });

  it('excludes conventional Rust lifecycle method names longer than the short-name guard', () => {
    const groups = groupTwins([
      record({
        leaf: 'reset',
        file: 'src/effects.rs',
        symbol: 'rust-analyzer cargo fixture 0.1.0 effects/impl#[BubbleTrail]reset().',
        shortName: 'effects:impl:BubbleTrail:reset()',
        tokens: ['self', '.', 'slots', '.', 'clear', '(', ')'],
      }),
      record({
        leaf: 'reset',
        file: 'src/visualizer.rs',
        symbol: 'rust-analyzer cargo fixture 0.1.0 visualizer/impl#[State]reset().',
        shortName: 'visualizer:impl:State:reset()',
        tokens: ['self', '.', 'left', '.', 'clear', '(', ')'],
      }),
    ]);

    expect(groups).toHaveLength(0);
  });

  it('excludes Rust inline test-module helpers in production-shaped files', () => {
    const groups = groupTwins([
      record({
        leaf: 'mesh_positions',
        file: 'src/effects.rs',
        symbol: 'rust-analyzer cargo fixture 0.1.0 effects/tests/mesh_positions().',
        tokens: ['mesh', '.', 'attribute', '(', 'POSITION', ')'],
      }),
      record({
        leaf: 'mesh_positions',
        file: 'src/visualizer.rs',
        symbol: 'rust-analyzer cargo fixture 0.1.0 visualizer/tests/mesh_positions().',
        tokens: ['mesh', '.', 'attribute', '(', 'POSITION', ')', '.', 'unwrap', '(', ')'],
      }),
    ]);

    expect(groups).toHaveLength(0);
  });

  // followup #7: controller -> service -> storage style delegation chains
  // (a thin forwarder and its same-name implementation) are not drifted
  // twins -- they're the intended architecture. `isDelegatePair` is injected
  // so this stays exercisable without a real call graph.
  it('drops a pair entirely when isDelegatePair reports a delegation relationship', () => {
    const a = record({
      leaf: 'jsonHandler',
      file: 'src/controller.ts',
      tokens: ['return', 'service', '.', 'jsonHandler', '(', 'req', ')', ';'],
      isThinForwarder: true,
    });
    const b = record({
      leaf: 'jsonHandler',
      file: 'src/service.ts',
      tokens: ['const', 'parsed', '=', 'JSON', '.', 'stringify', '(', 'req', ')', ';', 'return', 'parsed', ';'],
    });

    const groups = groupTwins([a, b], {
      isDelegatePair: (from, to) => from.file === a.file && to.file === b.file,
    });

    expect(groups).toHaveLength(0);
  });

  it('still reports a same-name pair when isDelegatePair says it is not a delegate', () => {
    const groups = groupTwins(
      [
        record({
          leaf: 'jsonHandler',
          file: 'src/controller.ts',
          tokens: ['return', 'service', '.', 'jsonHandler', '(', 'req', ')', ';'],
          isThinForwarder: true,
        }),
        record({
          leaf: 'jsonHandler',
          file: 'src/other.ts',
          tokens: ['const', 'parsed', '=', 'JSON', '.', 'stringify', '(', 'req', ')', ';', 'return', 'parsed', ';'],
        }),
      ],
      { isDelegatePair: () => false },
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]?.relationship).toBe('divergent');
  });
});

describe('groupTwins layering and stubs', () => {
  it('removes a member that delegates to a cluster peer before near-name pairing', () => {
    const facade = record({
      leaf: 'dispatchTicketSet',
      file: 'src/session.ts',
      tokens: ['return', 'this', '.', 'mutations', '.', 'dispatchTicketSet', '(', 'key', ')', ';'],
      isThinForwarder: true,
    });
    const implementation = record({
      leaf: 'dispatchTicketSet',
      file: 'src/mutations.ts',
      tokens: [
        'await',
        'assertPermission',
        '(',
        'key',
        ')',
        ';',
        'return',
        'setField',
        '(',
        'key',
        ',',
        'value',
        ')',
        ';',
      ],
    });
    const sibling = record({
      leaf: 'dispatchTicketGet',
      file: 'src/queries.ts',
      tokens: ['await', 'assertPermission', '(', 'key', ')', ';', 'return', 'getField', '(', 'key', ')', ';'],
    });

    const groups = groupTwins([facade, implementation, sibling], {
      isDelegatePair: (from, to) => from.file === facade.file && to.file === implementation.file,
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.members.map((member) => member.file)).toEqual(['src/mutations.ts', 'src/queries.ts']);
  });

  it('does not pair a stub that forwards to a differently named call with a peer that has a body', () => {
    const webClient = record({
      leaf: 'getThroughput',
      file: 'apps/web/src/api/reports.ts',
      tokens: ['apiClient', '.', 'getData', '(', 'paths', '.', 'throughput', '(', 'projectId', ')', ')'],
      isThinForwarder: true,
      forwardTargetLeaf: 'getData',
    });
    const service = record({
      leaf: 'getThroughput',
      file: 'apps/api/src/reports.service.ts',
      tokens: [
        'const',
        'cutoff',
        '=',
        'new',
        'Date',
        '(',
        ')',
        ';',
        'const',
        'rows',
        '=',
        'await',
        'db',
        '.',
        'select',
        '(',
        ')',
        ';',
        'return',
        'rows',
        ';',
      ],
    });

    expect(groupTwins([webClient, service])).toHaveLength(0);
  });

  it('does not cluster a name with the same name plus an appended capitalized word', () => {
    const user = record({
      leaf: 'requireUser',
      file: 'src/users.service.ts',
      tokens: [
        'const',
        'user',
        '=',
        'await',
        'selectOne',
        '(',
        'db',
        ')',
        ';',
        'if',
        '(',
        '!',
        'user',
        ')',
        'throw',
        ';',
        'return',
        'user',
        ';',
      ],
    });
    const userId = record({
      leaf: 'requireUserId',
      file: 'src/controller-helpers.ts',
      tokens: [
        'const',
        'userId',
        '=',
        'req',
        '.',
        'user',
        '?.',
        'sub',
        ';',
        'if',
        '(',
        '!',
        'userId',
        ')',
        'throw',
        ';',
        'return',
        'userId',
        ';',
      ],
    });

    expect(groupTwins([user, userId])).toHaveLength(0);
  });

  it('treats key-qualified lookup members on unrelated classes as convention', () => {
    const organization = record({
      leaf: 'getBySlug',
      symbol: 'scip-typescript npm fixture 1.0.0 src/`organizations.ts`/OrganizationService#getBySlug().',
      file: 'src/organizations.ts',
      tokens: [
        'return',
        'selectOne',
        '(',
        'db',
        '.',
        'select',
        '(',
        ')',
        '.',
        'from',
        '(',
        'organizations',
        ')',
        ')',
        ';',
      ],
    });
    const role = record({
      leaf: 'getBySlug',
      symbol: 'scip-typescript npm fixture 1.0.0 src/`roles.ts`/RoleService#getBySlug().',
      file: 'src/roles.ts',
      tokens: ['return', 'selectOne', '(', 'db', '.', 'select', '(', ')', '.', 'from', '(', 'roles', ')', ')', ';'],
    });

    expect(groupTwins([organization, role])).toHaveLength(0);
  });
});

describe('twinDrift (db-backed)', () => {
  let tempDir: string;
  let db: ScipDatabase;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-query-twin-drift-'));
    const projectRoot = join(tempDir, 'project');
    writeFixtureFiles(projectRoot, {
      'src/a.ts': [
        'export function escapeRegex(value: string) {',
        "  return value.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&');",
        '}',
      ],
      'src/b.ts': [
        '// scip-query: ignore-twin - reviewed near-name implementations are intentionally separate.',
        'export function escapeRegExp(value: string) {',
        "  return value.replace(/[.*+?^${}()\\\\]/g, '\\\\-');",
        '}',
      ],
      'src/c.ts': ['export function unrelatedGet(value: string) {', '  return value;', '}'],
    });

    const dbPath = join(tempDir, 'index.db');
    evidenceFixtureDb(dbPath)
      .document(1, 'typescript', 'src/a.ts')
      .document(2, 'typescript', 'src/b.ts')
      .document(3, 'typescript', 'src/c.ts')
      .symbol(1, 'scip-typescript npm fixture 1.0.0 src/`a.ts`/escapeRegex().', 'escapeRegex', 12)
      .symbol(2, 'scip-typescript npm fixture 1.0.0 src/`b.ts`/escapeRegExp().', 'escapeRegExp', 12)
      .symbol(3, 'scip-typescript npm fixture 1.0.0 src/`c.ts`/unrelatedGet().', 'unrelatedGet', 12)
      .definition(1, 1, 1, 0, 0, 2, 1)
      .definition(2, 2, 2, 0, 0, 2, 1)
      .definition(3, 3, 3, 0, 0, 2, 1)
      .write();

    db = new ScipDatabase({ dbPath, projectRoot });
  });

  afterAll(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('suppresses a reviewed near-name family when one member carries ignore-twin', () => {
    const groups = twinDrift(db);

    expect(groups).toHaveLength(0);
  });

  it('does not report a lone unrelated function as a twin', () => {
    const groups = twinDrift(db);

    expect(groups.every((group) => group.members.every((member) => member.file !== 'src/c.ts'))).toBe(true);
  });

  it('does not treat rust static variables as callable twins', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-query-twin-drift-rust-'));
    try {
      writeFixtureFiles(root, {
        'src/lib.rs': ['static escapeRegex: i32 = 1;'],
        'src/work.ts': ['export function escapeRegex(value: string) {', '  return value;', '}'],
      });
      const dbPath = join(root, 'index.db');
      evidenceFixtureDb(dbPath)
        .document(1, 'rust', 'src/lib.rs')
        .document(2, 'typescript', 'src/work.ts')
        .symbol(
          1,
          'rust-analyzer cargo fixture 0.1.0 escapeRegex.',
          'escapeRegex',
          SymbolInformation_Kind.StaticVariable,
        )
        .symbol(
          2,
          'scip-typescript npm fixture 1.0.0 src/`work.ts`/escapeRegex().',
          'escapeRegex',
          SymbolInformation_Kind.Function,
        )
        .definition(1, 1, 1, 0, 0, 0, 27)
        .definition(2, 2, 2, 0, 0, 2, 1)
        .write();

      const config: ScipQueryConfig = { projectRoot: root, dbPath, indexPath: join(root, 'index.scip') };
      const rustDb = new ScipDatabase(config);
      try {
        expect(twinDrift(rustDb, { includeHomonyms: true })).toHaveLength(0);
      } finally {
        rustDb.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not treat TypeScript top-level constants as callable twins', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-query-twin-drift-ts-constant-'));
    try {
      writeFixtureFiles(root, {
        'src/a.ts': ['export const queue = [1, 2];'],
        'src/b.ts': ['export const queue = [2, 3];'],
      });
      const dbPath = join(root, 'index.db');
      evidenceFixtureDb(dbPath)
        .document(1, 'typescript', 'src/a.ts')
        .document(2, 'typescript', 'src/b.ts')
        .symbol(1, 'scip-typescript npm fixture 1.0.0 src/`a.ts`/queue.', 'queue', SymbolInformation_Kind.Variable)
        .symbol(2, 'scip-typescript npm fixture 1.0.0 src/`b.ts`/queue.', 'queue', SymbolInformation_Kind.Variable)
        .definition(1, 1, 1, 0, 0, 0, 27)
        .definition(2, 2, 2, 0, 0, 0, 27)
        .write();

      const config: ScipQueryConfig = { projectRoot: root, dbPath, indexPath: join(root, 'index.scip') };
      const tsDb = new ScipDatabase(config);
      try {
        expect(twinDrift(tsDb, { includeHomonyms: true })).toHaveLength(0);
      } finally {
        tsDb.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// followup #7: real call-graph-backed delegation-chain exclusion. A
// jsonHandler-style thin controller delegate calling its same-name service
// implementation must not be reported as a drifted twin; two same-name
// functions with genuinely divergent bodies and no call relationship must
// still be reported (covered by the escapeRegex/escapeRegExp suite above).
describe('twinDrift (db-backed) — delegation-chain exclusion', () => {
  let tempDir: string;
  let db: ScipDatabase;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-query-twin-drift-delegation-'));
    const projectRoot = join(tempDir, 'project');
    writeFixtureFiles(projectRoot, {
      'src/controller.ts': [
        "import * as service from './service.js';",
        'export function jsonHandler(req: unknown) {',
        '  return service.jsonHandler(req);',
        '}',
      ],
      'src/service.ts': [
        'export function jsonHandler(req: unknown) {',
        '  const parsed = JSON.stringify(req);',
        '  return { ok: true, body: parsed, extra: parsed.length };',
        '}',
      ],
    });

    const dbPath = join(tempDir, 'index.db');
    evidenceFixtureDb(dbPath)
      .document(1, 'typescript', 'src/controller.ts')
      .document(2, 'typescript', 'src/service.ts')
      .symbol(1, 'scip-typescript npm fixture 1.0.0 src/`controller.ts`/jsonHandler().', 'jsonHandler', 12)
      .symbol(2, 'scip-typescript npm fixture 1.0.0 src/`service.ts`/jsonHandler().', 'jsonHandler', 12)
      .definition(1, 1, 1, 1, 0, 3, 1)
      .definition(2, 2, 2, 0, 0, 3, 1)
      .write();

    db = new ScipDatabase({ dbPath, projectRoot });
  });

  afterAll(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('does not report a thin delegate calling its same-name implementation as a drifted twin', () => {
    const groups = twinDrift(db, { includeHomonyms: true });

    expect(groups).toHaveLength(0);
  });
});

describe('twinDrift (db-backed) — layering exclusion', () => {
  let tempDir: string;
  let db: ScipDatabase;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-query-twin-drift-layering-'));
    const projectRoot = join(tempDir, 'project');
    writeFixtureFiles(projectRoot, {
      'src/operations.ts': [
        "import { getCandidates as getCandidatesUseCase } from './use-case.js';",
        'export async function getCandidates(clientId: string) {',
        '  const repository = createRepository();',
        '  const provider = createProvider();',
        '  return getCandidatesUseCase({ repository, provider, clientId });',
        '}',
        'function createRepository() {',
        '  return {};',
        '}',
        'function createProvider() {',
        '  return {};',
        '}',
      ],
      'src/use-case.ts': [
        'export async function getCandidates(params: { repository: unknown; provider: unknown; clientId: string }) {',
        '  const repository = await Promise.resolve(params.repository);',
        '  const provider = await Promise.resolve(params.provider);',
        '  return [repository, provider, params.clientId];',
        '}',
      ],
    });

    const dbPath = join(tempDir, 'index.db');
    evidenceFixtureDb(dbPath)
      .document(1, 'typescript', 'src/operations.ts')
      .document(2, 'typescript', 'src/use-case.ts')
      .symbol(1, 'scip-typescript npm fixture 1.0.0 src/`operations.ts`/getCandidates().', 'getCandidates', 12)
      .symbol(2, 'scip-typescript npm fixture 1.0.0 src/`use-case.ts`/getCandidates().', 'getCandidates', 12)
      .definition(1, 1, 1, 1, 0, 5, 1)
      .definition(2, 2, 2, 0, 0, 4, 1)
      .write();

    db = new ScipDatabase({ dbPath, projectRoot });
  });

  afterAll(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('does not report a member that builds its inputs and calls its same-name counterpart under an alias', () => {
    const groups = twinDrift(db, { includeHomonyms: true });

    expect(groups).toHaveLength(0);
  });
});

describe('twinDrift (db-backed) — abstract members and re-exported delegates', () => {
  let tempDir: string;
  let db: ScipDatabase;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-query-twin-drift-abstract-'));
    const projectRoot = join(tempDir, 'project');
    writeFixtureFiles(projectRoot, {
      'src/base.ts': [
        'export abstract class Runtime {',
        '  protected abstract buildTurnState(input: unknown): unknown;',
        '}',
      ],
      'src/backlog.ts': [
        "import { Runtime } from './base.js';",
        'export class BacklogRuntime extends Runtime {',
        '  protected override buildTurnState(input: { backlog: string[] }) {',
        '    return { backlog: [...input.backlog], pendingQuestion: null };',
        '  }',
        '}',
      ],
      'src/spec.ts': [
        "import { Runtime } from './base.js';",
        'export class SpecRuntime extends Runtime {',
        '  protected override buildTurnState(input: { goals: string[] }) {',
        '    return { goals: [...input.goals], interactions: [] };',
        '  }',
        '}',
      ],
      'src/recorder.ts': [
        'export const recorder = {',
        '  record(input: { organizationId: string }) {',
        '    return { organizationId: input.organizationId, stored: true };',
        '  },',
        '};',
      ],
      'src/index.ts': ["export { recorder } from './recorder.js';"],
      'src/usage.ts': [
        "import { recorder } from './index.js';",
        'export function record(input: { scope: { organizationId: string } }) {',
        '  const ids = { organizationId: input.scope.organizationId };',
        '  return recorder.record(ids);',
        '}',
      ],
    });

    const dbPath = join(tempDir, 'index.db');
    evidenceFixtureDb(dbPath)
      .document(1, 'typescript', 'src/backlog.ts')
      .document(2, 'typescript', 'src/spec.ts')
      .document(3, 'typescript', 'src/recorder.ts')
      .document(4, 'typescript', 'src/usage.ts')
      .document(5, 'typescript', 'src/index.ts')
      .symbol(
        1,
        'scip-typescript npm fixture 1.0.0 src/`backlog.ts`/BacklogRuntime#buildTurnState().',
        'buildTurnState',
        12,
      )
      .symbol(2, 'scip-typescript npm fixture 1.0.0 src/`spec.ts`/SpecRuntime#buildTurnState().', 'buildTurnState', 12)
      .symbol(3, 'scip-typescript npm fixture 1.0.0 src/`recorder.ts`/recorder.record().', 'record', 12)
      .symbol(4, 'scip-typescript npm fixture 1.0.0 src/`usage.ts`/record().', 'record', 12)
      .definition(1, 1, 1, 2, 2, 4, 3)
      .definition(2, 2, 2, 2, 2, 4, 3)
      .definition(3, 3, 3, 1, 2, 3, 3)
      .definition(4, 4, 4, 1, 0, 4, 1)
      .write();

    db = new ScipDatabase({ dbPath, projectRoot });
  });

  afterAll(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('does not group overrides of one abstract member, nor a caller that reaches its target through a re-export', () => {
    expect(twinDrift(db, { includeHomonyms: true })).toHaveLength(0);
  });
});

describe('isSingleForwardingCallBody', () => {
  const body = (...lines: string[]) => ['function wrap(raw: string) {', ...lines, '}'].join('\n');

  it('accepts one call whose arguments are plain values', () => {
    expect(isSingleForwardingCallBody(body('  return inner(raw);'))).toBe(true);
    expect(isSingleForwardingCallBody(body('  await service.inner(tx, raw, MODE.Switch);'))).toBe(true);
    expect(isSingleForwardingCallBody(body('  return inner(raw ?? [], "deleted");'))).toBe(true);
  });

  it('reads a concise arrow body past braces inside its type arguments', () => {
    const client = [
      'export const updateBoardOrder = (projectId: string, issueId: string) =>',
      '  apiClient.patchData<ApiResponse<{ success: boolean }>>(paths.boardReorder(projectId), { issueId });',
    ].join('\n');
    expect(isThinForwarderBody(client)).toBe(true);
  });

  it('reads a declaration body past an object type literal in its return type', () => {
    const client = [
      'export async function createPortalSession(args: Args): Promise<{ url: string }> {',
      '  return fetchJson<{ url: string }>(`/api/${args.organizationId}/portal`, { method: "POST" });',
      '}',
    ].join('\n');
    expect(isThinForwarderBody(client)).toBe(true);
    expect(isSingleForwardingCallBody(client)).toBe(false);
  });

  it('rejects preparatory statements, callbacks, nested calls, and built literals', () => {
    expect(isSingleForwardingCallBody(body('  const key = raw.trim();', '  return inner(key);'))).toBe(false);
    expect(isSingleForwardingCallBody(body('  return items.reduce((sum, n) => sum + n, 0);'))).toBe(false);
    expect(isSingleForwardingCallBody(body('  return outer(await inner(raw), raw);'))).toBe(false);
    expect(isSingleForwardingCallBody(body('  return JSON.stringify([raw.id, raw.kind]);'))).toBe(false);
    expect(isSingleForwardingCallBody(body('  if (!raw) return null;', '  return inner(raw);'))).toBe(false);
  });
});

describe('groupTwins framework route conventions', () => {
  it('excludes route-file convention names that every route implements by construction', () => {
    const tokens = ['return', 'json', '(', 'await', 'load', '(', 'req', ')', ')'];
    const groups = groupTwins([
      record({ leaf: 'handler', file: 'src/app/api/users/route.ts', tokens }),
      record({ leaf: 'handler', file: 'src/app/api/posts/route.ts', tokens: [...tokens, 'limit'] }),
      record({ leaf: 'handleGet', file: 'src/app/api/users/route.ts', tokens }),
      record({ leaf: 'handleGet', file: 'src/app/api/posts/route.ts', tokens: [...tokens, 'limit'] }),
      record({ leaf: 'UsersPage', file: 'src/app/users/page.tsx', tokens }),
      record({ leaf: 'UsersPage', file: 'src/app/@modal/(.)users/page.tsx', tokens: [...tokens, 'limit'] }),
    ]);
    expect(groups).toEqual([]);
  });

  it('keeps the same convention names when they live outside framework entry files', () => {
    const tokens = ['return', 'json', '(', 'await', 'load', '(', 'req', ')', ')'];
    const groups = groupTwins([
      record({ leaf: 'handler', file: 'src/lib/queue/users.ts', tokens }),
      record({ leaf: 'handler', file: 'src/lib/queue/posts.ts', tokens: [...tokens, 'limit'] }),
    ]);
    expect(groups.map((group) => group.leaf)).toEqual(['handler']);
  });
});

describe('groupTwins convention-only class members', () => {
  it('does not group CRUD and lifecycle method names shared across unrelated classes', () => {
    const tokens = ['const', 'row', '=', 'await', 'this', '.', 'repo', '.', 'remove', '(', 'id', ')', ';'];
    const groups = groupTwins([
      record({
        leaf: 'delete',
        symbol: 'scip-typescript npm fixture 1.0.0 src/`chat.service.ts`/ChatService#delete().',
        file: 'src/chat.service.ts',
        tokens,
      }),
      record({
        leaf: 'delete',
        symbol: 'scip-typescript npm fixture 1.0.0 src/`issue.service.ts`/IssueService#delete().',
        file: 'src/issue.service.ts',
        tokens: [...tokens, 'audit'],
      }),
    ]);
    expect(groups).toEqual([]);
  });

  it('still groups free functions that share a CRUD verb name', () => {
    const tokens = ['const', 'row', '=', 'await', 'repo', '.', 'remove', '(', 'id', ')', ';'];
    const groups = groupTwins([
      record({ leaf: 'deleteRecord', file: 'src/chat.ts', tokens }),
      record({ leaf: 'deleteRecord', file: 'src/issue.ts', tokens: [...tokens, 'audit'] }),
    ]);
    expect(groups.map((group) => group.leaf)).toEqual(['deleteRecord']);
  });
});
