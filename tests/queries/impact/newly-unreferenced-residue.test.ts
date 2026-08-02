import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ScipQueryConfig } from '../../../src/domain/types.js';
import { diffGate } from '../../../src/queries/impact/diff-gate.js';
import { newlyUnreferencedResidue } from '../../../src/queries/impact/newly-unreferenced-residue.js';
import { ScipDatabase } from '../../../src/storage/db.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../../fixtures/evidence-fixture.js';
import { createPlanContractRecord } from '../../../src/change-control/plan-contract.js';
import { createObservationIdentity, type ObservationReceiptV2 } from '../../../src/domain/observation-receipt.js';

const tempRoots: string[] = [];
const openDbs: ScipDatabase[] = [];

afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('newly unreferenced residue', () => {
  it('finds the implementation abandoned by this change without flagging unrelated old code or a live compatibility shim', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'scip-newly-unreferenced-'));
    tempRoots.push(repoRoot);
    gitIn(repoRoot, 'init');
    writeFixtureFiles(repoRoot, {
      'src/legacy.ts': "export function legacyFlow() { return 'legacy'; }\n",
      'src/compat.ts': "export function compatShim() { return 'compat'; }\n",
      'src/orphan.ts': "export function unrelatedOldSmell() { return 'old'; }\n",
      'src/registry.ts': [
        "import { legacyFlow } from './legacy.js';",
        "import { compatShim } from './compat.js';",
        'export const handlers = [legacyFlow, compatShim];',
      ],
      'src/compat-client.ts': [
        "import { compatShim } from './compat.js';",
        'export function useCompatibilityPath() { return compatShim(); }',
      ],
    });
    commit(repoRoot, 'base');

    writeFixtureFiles(repoRoot, {
      'src/current.ts': "export function currentFlow() { return 'current'; }\n",
      'src/registry.ts': ["import { currentFlow } from './current.js';", 'export const handlers = [currentFlow];'],
    });

    const dbPath = join(repoRoot, 'index.db');
    evidenceFixtureDb(dbPath)
      .document(1, 'typescript', 'src/legacy.ts')
      .document(2, 'typescript', 'src/compat.ts')
      .document(3, 'typescript', 'src/orphan.ts')
      .document(4, 'typescript', 'src/registry.ts')
      .document(5, 'typescript', 'src/compat-client.ts')
      .document(6, 'typescript', 'src/current.ts')
      .symbol(1, symbol('legacy.ts', 'legacyFlow'), 'legacyFlow', 12)
      .symbol(2, symbol('compat.ts', 'compatShim'), 'compatShim', 12)
      .symbol(3, symbol('orphan.ts', 'unrelatedOldSmell'), 'unrelatedOldSmell', 12)
      .symbol(4, symbol('current.ts', 'currentFlow'), 'currentFlow', 12)
      .definition(1, 1, 1, 0, 0, 0, 57)
      .definition(2, 2, 2, 0, 0, 0, 56)
      .definition(3, 3, 3, 0, 0, 0, 70)
      .definition(4, 6, 4, 0, 0, 0, 59)
      .chunk(1, 1, 0, 0)
      .chunk(2, 2, 0, 0)
      .chunk(3, 3, 0, 0)
      .chunk(4, 6, 0, 0)
      .mention(1, 1, 1)
      .mention(2, 2, 1)
      .mention(3, 3, 1)
      .mention(4, 4, 1)
      .write();

    const config: ScipQueryConfig = {
      dbPath,
      indexPath: join(repoRoot, 'index.scip'),
      projectRoot: repoRoot,
      entryRoots: { symbolPatterns: ['compatShim'] },
    };
    const db = new ScipDatabase(config);
    openDbs.push(db);

    const result = newlyUnreferencedResidue(db, { base: 'HEAD', semantic: false });
    const byName = new Map(
      result.evaluations.map((evaluation) => [evaluation.observation.referent.displayName, evaluation]),
    );

    expect(result.available).toBe(true);
    expect(result.coverage).toMatchObject({
      state: 'complete',
      analyzedFiles: ['src/current.ts', 'src/registry.ts'],
      omitted: [],
      unresolvedReferences: [],
    });
    expect([...byName]).toHaveLength(2);
    expect(byName.get('legacyFlow')?.disposition).toBe('candidate');
    expect(byName.get('compatShim')?.disposition).toBe('current-role-proven');
    expect(byName.get('compatShim')?.observation.currentRoleProofs.map((proof) => proof.kind)).toEqual(
      expect.arrayContaining(['production-consumers', 'declared-external-root']),
    );
    expect(byName.has('unrelatedOldSmell')).toBe(false);
    expect(byName.has('currentFlow')).toBe(false);

    const plan = createPlanContractRecord({
      collaborationDomainId: '70a26367-a22f-46a7-aa64-f4ea5f09cc51',
      request: {
        schemaVersion: 1,
        goalId: 'SQG-0123456789ABCDEF0123456789ABCDEF',
        changeId: 'SQC-0123456789ABCDEF0123456789ABCDEF',
        workflowClass: 'relational',
        affectedSeeds: [],
        preserve: [],
        retirements: [
          {
            id: 'legacy',
            kind: 'identity',
            referent: 'legacyFlow',
            responsibility: 'legacy flow',
            condition: 'The legacy flow identity is absent',
            evidenceIds: ['closure'],
          },
        ],
        allowedSurvivors: [],
        reuseAuthorities: [],
        architecture: [],
        completionEvidence: [{ id: 'closure', description: 'Inspect retirement closure' }],
        slices: [],
      },
      source: { path: 'plan.md', sha256: 'a'.repeat(64) },
      compiledAgainst: fixedReceipt(),
      createdAt: '2026-08-01T12:00:00.000Z',
      toolVersion: '0.20.0',
    });
    const gate = diffGate(db, {
      base: 'HEAD',
      semantic: false,
      planContracts: [plan],
      skip: [
        'echo',
        'incomplete-migration',
        'co-change-partner',
        'twin-partner',
        'coverage-contract',
        'architecture',
        'doc-reference',
        'unused-params',
        'baseline',
      ],
    });
    expect(gate.findings).toContainEqual(
      expect.objectContaining({
        check: 'new-dead',
        sourceAnalyzer: 'newly-unreferenced-residue',
        symbol: symbol('legacy.ts', 'legacyFlow'),
        evidence: 'change-graph',
        actionTier: 'direct',
      }),
    );
    expect(gate.findings).toContainEqual(
      expect.objectContaining({
        check: 'new-dead',
        sourceAnalyzer: 'plan-retirement-residue',
        rootCauseKey: `plan-retirement:${plan.planId}:legacy`,
        actionTier: 'direct',
      }),
    );
  });

  it('does not attribute a removed local name to an unrelated unique global callable', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'scip-newly-unreferenced-local-'));
    tempRoots.push(repoRoot);
    gitIn(repoRoot, 'init');
    writeFixtureFiles(repoRoot, {
      'src/global.ts': "export function sharedName() { return 'global'; }\n",
      'src/registry.ts': ["const sharedName = 'local';", 'export const handlers = [sharedName];'],
    });
    commit(repoRoot, 'base');
    writeFixtureFiles(repoRoot, {
      'src/registry.ts': 'export const handlers: string[] = [];\n',
    });

    const dbPath = join(repoRoot, 'index.db');
    evidenceFixtureDb(dbPath)
      .document(1, 'typescript', 'src/global.ts')
      .document(2, 'typescript', 'src/registry.ts')
      .symbol(1, symbol('global.ts', 'sharedName'), 'sharedName', 12)
      .definition(1, 1, 1, 0, 0, 0, 57)
      .chunk(1, 1, 0, 0)
      .mention(1, 1, 1)
      .write();
    const db = new ScipDatabase({
      dbPath,
      indexPath: join(repoRoot, 'index.scip'),
      projectRoot: repoRoot,
    });
    openDbs.push(db);

    const result = newlyUnreferencedResidue(db, { base: 'HEAD', semantic: false });

    expect(result.evaluations).toEqual([]);
    expect(result.coverage.unresolvedReferences).toContainEqual({
      changedFile: 'src/registry.ts',
      leaf: 'sharedName',
      reason: 'base-reference-not-attributed',
    });
  });
});

function symbol(file: string, name: string): string {
  return `scip-typescript npm fixture 1.0.0 src/\`${file}\`/${name}().`;
}

function gitIn(root: string, ...args: string[]): void {
  execFileSync('git', ['-C', root, ...args], {
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 't@t.t',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 't@t.t',
      GIT_AUTHOR_DATE: '1700000000 +0000',
      GIT_COMMITTER_DATE: '1700000000 +0000',
    },
  });
}

function commit(root: string, message: string): void {
  gitIn(root, 'add', '-A');
  gitIn(root, 'commit', '-m', message, '--no-gpg-sign');
}

function fixedReceipt(): ObservationReceiptV2 {
  const domain = '70a26367-a22f-46a7-aa64-f4ea5f09cc51';
  const content = createObservationIdentity('repository-content', 1, 'pre-edit');
  return {
    schemaVersion: 2,
    observedAt: '2026-08-01T12:00:00.000Z',
    facts: {
      collaborationDomain: createObservationIdentity('scip-query:collaboration-domain', 1, domain),
      wholeContent: content,
    },
    observedSources: [{ kind: 'repository-snapshot', identity: content }],
    stabilityProofs: [{ source: 'repository-snapshot', kind: 'fixed-snapshot' }],
  };
}
