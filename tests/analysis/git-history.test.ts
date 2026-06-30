import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ScipDatabase } from '../../src/storage/db.js';
import {
  gitEvidenceProduct,
  getChangeAmplification,
  getCoChangePairs,
  getCoChangePairsForFiles,
  getCommitHistory,
  getDirectionalCoChangePairsForFiles,
  getFileAddRecords,
  getFileChurn,
} from '../../src/analysis/git-history.js';
import { coChange } from '../../src/queries/impact/co-change.js';
import { docDrift } from '../../src/queries/cleanup/doc-drift.js';
import type { ScipQueryConfig } from '../../src/domain/types.js';
import { fileContentHash, readCachedFileEvidence } from '../../src/storage/evidence-cache.js';
import { evidenceFixtureDb } from '../fixtures/evidence-fixture.js';

let repoRoot: string;

// Git-history only reads db.config.projectRoot; coChange also asks for an empty
// dependency graph, so the query methods return no indexed edges.
function fakeDb(projectRoot: string, config: Partial<ScipQueryConfig> = {}): ScipDatabase {
  return {
    config: { projectRoot, ...config },
    all: () => [],
    pathExclusionsFor: () => '',
    isIgnored: () => false,
  } as unknown as ScipDatabase;
}

let commitClock = 1_700_000_000;

function gitIn(root: string, ...args: string[]): void {
  execFileSync('git', ['-C', root, ...args], {
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 't@t.t',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 't@t.t',
      // Distinct timestamps per commit — doc-drift compares them strictly.
      GIT_AUTHOR_DATE: `${commitClock} +0000`,
      GIT_COMMITTER_DATE: `${commitClock} +0000`,
    },
  });
}

function git(...args: string[]): void {
  gitIn(repoRoot, ...args);
}

function commitIn(root: string, message: string, files: Record<string, string>): void {
  commitClock += 60;
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  gitIn(root, 'add', '-A');
  gitIn(root, 'commit', '-m', message, '--no-gpg-sign');
}

function commit(message: string, files: Record<string, string>): void {
  commitIn(repoRoot, message, files);
}

beforeAll(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'scip-git-history-'));
  git('init');
  // a.ts and b.ts always change together; c.ts changes alone.
  // guide.md documents a.ts (co-changes 3x), then a.ts moves on without it.
  commit('initial', { 'a.ts': '1', 'b.ts': '1', 'c.ts': '1', 'guide.md': 'v1' });
  commit('feature one', { 'a.ts': '2', 'b.ts': '2', 'guide.md': 'v2' });
  commit('fix(api): regression in pair (#42)', { 'a.ts': '3', 'b.ts': '3', 'guide.md': 'v3' });
  commit('feature two', { 'a.ts': '4', 'b.ts': '4' });
  commit('solo change', { 'c.ts': '2' });
  commit('feature three', { 'a.ts': '5' });
});

afterAll(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

describe('git history evidence', () => {
  it('parses bounded commit history', () => {
    const history = getCommitHistory(fakeDb(repoRoot));
    expect(history).not.toBeNull();
    expect(history!.commits).toHaveLength(6);
    expect(history!.commits[0]!.files).toContain('a.ts');
  });

  it('exposes git history facts through the product contract', () => {
    const git = gitEvidenceProduct(fakeDb(repoRoot));
    const capability = git.capability('file-add-records');

    expect(capability).toEqual(expect.objectContaining({ available: true, slot: 'file-add-records' }));
    expect(capability.head).toMatch(/[a-f0-9]{40}/);
    expect(git.commitHistory()?.commits).toHaveLength(6);
    expect(git.trackedFiles()?.has('guide.md')).toBe(true);
    expect(git.fileAddRecords()?.get('a.ts')).toEqual(expect.objectContaining({ addedAt: expect.any(Number) }));
    expect(git.fileChurn()?.get('a.ts')).toEqual(expect.objectContaining({ changes: 5, fixChanges: 1 }));
    expect(git.changeAmplification()).toEqual(expect.objectContaining({ commitsAnalyzed: 6 }));

    const pairs = git.coChangePairs({ minTogether: 3, minConfidence: 0.6 })!;
    expect(pairs).toEqual(expect.arrayContaining([expect.objectContaining({ fileA: 'a.ts', fileB: 'b.ts' })]));

    const firstDirectional = git.directionalCoChangePairsForFiles(new Set(['a.ts']), {
      minTogether: 3,
      minConfidence: 0,
    })!;
    const secondDirectional = git.directionalCoChangePairsForFiles(new Set(['a.ts']), {
      minTogether: 3,
      minConfidence: 0,
    })!;
    expect(secondDirectional).toEqual(firstDirectional);
    expect(secondDirectional).not.toBe(firstDirectional);
  });

  it('returns null outside a git repository', () => {
    const outside = mkdtempSync(join(tmpdir(), 'scip-no-git-'));
    expect(getCommitHistory(fakeDb(outside))).toBeNull();
    expect(gitEvidenceProduct(fakeDb(outside)).capability('commit-history')).toEqual({
      available: false,
      head: null,
      reason: 'git history is unavailable for this project',
      slot: 'commit-history',
    });
    rmSync(outside, { recursive: true, force: true });
  });

  it('persists file add records by HEAD', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-file-add-cache-'));
    try {
      gitIn(root, 'init');
      commitIn(root, 'initial files', {
        'src/a.ts': 'export const a = 1;\n',
        'src/b.ts': 'export const b = 1;\n',
      });
      const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
      const dbPath = join(root, 'index.db');
      const config = {
        projectRoot: root,
        dbPath,
        indexPath: join(root, 'index.scip'),
      };
      evidenceFixtureDb(dbPath).document(1, 'typescript', 'src/a.ts').document(2, 'typescript', 'src/b.ts').write();

      let first: ReturnType<typeof getFileAddRecords>;
      const db = new ScipDatabase(config);
      try {
        first = getFileAddRecords(db);
        expect(first?.get('src/a.ts')).toEqual(expect.objectContaining({ commitsAgo: 0 }));
        expect(readCachedFileEvidence(db, 'git-file-adds', '__git__/file-adds', head)).not.toBeNull();
      } finally {
        db.close();
      }

      const reopened = new ScipDatabase(config);
      try {
        expect([...getFileAddRecords(reopened)!]).toEqual([...first!]);
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('computes per-file churn with fix-commit counts', () => {
    const churn = getFileChurn(fakeDb(repoRoot))!;
    expect(churn.get('a.ts')!.changes).toBe(5);
    expect(churn.get('a.ts')!.fixChanges).toBe(1);
    expect(churn.get('c.ts')!.changes).toBe(2);
    expect(churn.get('c.ts')!.fixChanges).toBe(0);
  });

  it('computes change amplification percentiles', () => {
    const amplification = getChangeAmplification(fakeDb(repoRoot))!;
    expect(amplification.commitsAnalyzed).toBe(6);
    expect(amplification.medianFilesPerCommit).toBe(3);
  });

  it('flags docs whose coupled code moved on without them', () => {
    const result = docDrift(fakeDb(repoRoot));
    expect(result.available).toBe(true);
    const guide = result.findings.find((finding) => finding.doc === 'guide.md');
    expect(guide).toBeDefined();
    // a.ts changed twice after guide.md's last update; b.ts once.
    expect(guide!.subjects).toEqual([
      expect.objectContaining({ file: 'a.ts', coChanges: 3, changesSinceDocUpdate: 2 }),
      expect.objectContaining({ file: 'b.ts', coChanges: 3, changesSinceDocUpdate: 1 }),
    ]);
    expect(guide!.staleness).toBe(3);
  });

  it('attaches citation context to referenced stale subjects', () => {
    const referencedRepo = mkdtempSync(join(tmpdir(), 'scip-doc-drift-reference-'));
    try {
      gitIn(referencedRepo, 'init');
      commitIn(referencedRepo, 'initial docs', {
        'docs/guide.md': 'Cleanup detector behavior lives in src/a.ts.\n',
        'src/a.ts': 'export const version = 1;\n',
      });
      commitIn(referencedRepo, 'code moves on', {
        'src/a.ts': 'export const version = 2;\n',
      });
      const dbPath = join(referencedRepo, 'index.db');
      const config = {
        projectRoot: referencedRepo,
        dbPath,
        indexPath: join(referencedRepo, 'index.scip'),
      };
      evidenceFixtureDb(dbPath).document(1, 'markdown', 'docs/guide.md').document(2, 'typescript', 'src/a.ts').write();

      const db = new ScipDatabase(config);
      let guide: ReturnType<typeof docDrift>['findings'][number] | undefined;
      try {
        const result = docDrift(db);
        guide = result.findings.find((finding) => finding.doc === 'docs/guide.md');
        const docContent = readFileSync(join(referencedRepo, 'docs/guide.md'), 'utf-8');
        const docHash = fileContentHash(db, 'docs/guide.md', docContent);

        expect(guide).toBeDefined();
        expect(guide!.subjects).toEqual([
          expect.objectContaining({
            file: 'src/a.ts',
            evidence: 'reference',
            changesSinceDocUpdate: 1,
            citationContexts: expect.arrayContaining([expect.stringContaining('Cleanup detector behavior')]),
          }),
        ]);
        expect(readCachedFileEvidence(db, 'doc-path-evidence', 'docs/guide.md', docHash)).not.toBeNull();
      } finally {
        db.close();
      }

      const reopened = new ScipDatabase(config);
      try {
        const warmGuide = docDrift(reopened).findings.find((finding) => finding.doc === 'docs/guide.md');
        expect(warmGuide).toEqual(guide);
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(referencedRepo, { recursive: true, force: true });
    }
  });

  it('classifies co-change-only historical notes as support', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-doc-drift-intent-'));
    const previousClock = commitClock;
    try {
      commitClock = 1_900_000_000;
      gitIn(root, 'init');
      for (let version = 1; version <= 3; version += 1) {
        commitIn(root, `historical note ${version}`, {
          'docs/history-note.md': `Historical note: recorded legacy cleanup behavior as of migration ${version}.\n`,
          'src/legacy.ts': `export const legacy = ${version};\n`,
        });
      }
      for (let version = 1; version <= 3; version += 1) {
        commitIn(root, `current guide ${version}`, {
          'docs/current-guide.md': `Current standard: implementations must follow this behavior ${version}.\n`,
          'src/current.ts': `export const current = ${version};\n`,
        });
      }
      commitIn(root, 'code moves on', {
        'src/legacy.ts': 'export const legacy = 99;\n',
        'src/current.ts': 'export const current = 99;\n',
      });

      const result = docDrift(fakeDb(root), { minCoupling: 3, limit: 10 });
      const historical = result.findings.find((finding) => finding.doc === 'docs/history-note.md');
      const current = result.findings.find((finding) => finding.doc === 'docs/current-guide.md');

      expect(historical?.subjects[0]).toEqual(
        expect.objectContaining({
          file: 'src/legacy.ts',
          evidence: 'co-change',
          actionTier: 'support',
          docIntent: 'historical-note',
          docIntentReasons: expect.arrayContaining([expect.stringContaining('historical-note terms')]),
        }),
      );
      expect(current?.subjects[0]).toEqual(
        expect.objectContaining({
          file: 'src/current.ts',
          evidence: 'co-change',
          actionTier: 'signal',
          docIntent: 'current-guidance',
          docIntentReasons: expect.arrayContaining([expect.stringContaining('current-guidance terms')]),
        }),
      );
    } finally {
      commitClock = previousClock;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('finds high-confidence co-change pairs', () => {
    const pairs = getCoChangePairs(fakeDb(repoRoot), { minTogether: 3, minConfidence: 0.6 })!;
    const pair = pairs.find((entry) => entry.fileA === 'a.ts' && entry.fileB === 'b.ts');
    expect(pair).toBeDefined();
    expect(pair!.together).toBe(4);
    expect(pair!.confidence).toBe(1);
    expect(pair).toEqual(
      expect.objectContaining({
        commitScope: 'focused',
        recency: 'recent',
        focusedTogether: 4,
        broadTogether: 0,
        recentTogether: 4,
        subjectContext: {
          subjectLabels: ['feature', 'fix'],
          issueRefs: ['#42'],
          sampleSubjects: ['feature two', 'fix(api): regression in pair (#42)', 'feature one'],
          externalIssueLabelStatus: 'unavailable',
        },
      }),
    );
  });

  it('computes focused co-change pairs without losing directional churn', () => {
    const pairs = getCoChangePairsForFiles(fakeDb(repoRoot), new Set(['a.ts']), {
      minTogether: 3,
      minConfidence: 0,
    })!;

    expect(pairs.every((entry) => entry.fileA === 'a.ts' || entry.fileB === 'a.ts')).toBe(true);
    expect(pairs).not.toEqual(expect.arrayContaining([expect.objectContaining({ fileA: 'b.ts', fileB: 'guide.md' })]));

    const pair = pairs.find((entry) => entry.fileA === 'a.ts' && entry.fileB === 'b.ts');
    expect(pair).toEqual(
      expect.objectContaining({
        together: 4,
        changesA: 5,
        changesB: 4,
        confidence: 1,
      }),
    );
  });

  it('computes directional focused co-change pairs from narrowed git history', () => {
    const pairs = getDirectionalCoChangePairsForFiles(fakeDb(repoRoot), new Set(['a.ts']), {
      minTogether: 3,
      minConfidence: 0,
    })!;

    expect(pairs.every((entry) => entry.fileA === 'a.ts' || entry.fileB === 'a.ts')).toBe(true);
    const pair = pairs.find((entry) => entry.fileA === 'a.ts' && entry.fileB === 'b.ts');
    expect(pair).toEqual(
      expect.objectContaining({
        together: 4,
        changesA: 5,
        focusedTogether: 4,
        broadTogether: 0,
        recentTogether: 4,
        subjectContext: expect.objectContaining({
          subjectLabels: ['feature', 'fix'],
          issueRefs: ['#42'],
        }),
      }),
    );
  });

  it('classifies broad-sweep and stale co-change history', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-co-change-context-'));
    const previousClock = commitClock;
    try {
      commitClock = 1_800_000_000;
      gitIn(root, 'init');
      commitIn(root, 'old pair one', {
        'old/a.ts': '1',
        'old/b.ts': '1',
      });
      commitIn(root, 'old pair two', {
        'old/a.ts': '2',
        'old/b.ts': '2',
      });

      commitClock += 120 * 24 * 60 * 60;
      for (let version = 1; version <= 3; version += 1) {
        commitIn(root, `broad sweep ${version}`, {
          'broad/a.ts': `a${version}`,
          'broad/b.ts': `b${version}`,
          'area-one/file.ts': `one${version}`,
          'area-two/file.ts': `two${version}`,
          'area-three/file.ts': `three${version}`,
          'area-four/file.ts': `four${version}`,
          'area-five/file.ts': `five${version}`,
          'area-six/file.ts': `six${version}`,
        });
      }
      for (let version = 1; version <= 4; version += 1) {
        commitIn(root, `focused pair ${version}`, {
          'focused/a.ts': `a${version}`,
          'focused/b.ts': `b${version}`,
        });
      }

      const pairs = getCoChangePairs(fakeDb(root), { minTogether: 2, minConfidence: 0.6, maxFilesPerCommit: 20 })!;
      const oldPair = pairs.find((entry) => entry.fileA === 'old/a.ts' && entry.fileB === 'old/b.ts');
      const broadPair = pairs.find((entry) => entry.fileA === 'broad/a.ts' && entry.fileB === 'broad/b.ts');
      const focusedPair = pairs.find((entry) => entry.fileA === 'focused/a.ts' && entry.fileB === 'focused/b.ts');

      expect(oldPair).toEqual(
        expect.objectContaining({
          together: 2,
          commitScope: 'focused',
          recency: 'stale',
          focusedTogether: 2,
          broadTogether: 0,
          recentTogether: 0,
        }),
      );
      expect(broadPair).toEqual(
        expect.objectContaining({
          together: 3,
          commitScope: 'broad-sweep',
          recency: 'recent',
          focusedTogether: 0,
          broadTogether: 3,
          broadCommitRatio: 1,
          recentTogether: 3,
        }),
      );
      expect(focusedPair).toEqual(
        expect.objectContaining({
          together: 4,
          commitScope: 'focused',
          recency: 'recent',
          focusedTogether: 4,
          broadTogether: 0,
          recentTogether: 4,
        }),
      );
    } finally {
      commitClock = previousClock;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('can ignore broad commits when computing co-change pairs', () => {
    const pairs = getCoChangePairs(fakeDb(repoRoot), {
      minTogether: 3,
      minConfidence: 0.6,
      maxFilesPerCommit: 2,
    })!;

    expect(pairs).not.toEqual(expect.arrayContaining([expect.objectContaining({ fileA: 'a.ts', fileB: 'b.ts' })]));
  });

  it('treats declared coupling groups as structural links', () => {
    const plain = coChange(fakeDb(repoRoot), undefined, { minTogether: 3, minConfidence: 0.6, limit: 10 });
    expect(plain.findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ fileA: 'a.ts', fileB: 'b.ts', structurallyLinked: false })]),
    );

    const declared = fakeDb(repoRoot, {
      declaredCouplings: [
        {
          name: 'fixture pair',
          files: ['a.ts', 'b.ts'],
          reason: 'The fixture deliberately moves these files together.',
        },
      ],
    });
    expect(coChange(declared, undefined, { minTogether: 3, minConfidence: 0.6, limit: 10 }).findings).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ fileA: 'a.ts', fileB: 'b.ts' })]),
    );

    const partner = coChange(declared, 'a.ts', { minTogether: 3, limit: 10 }).findings.find(
      (entry) => entry.fileA === 'a.ts' && entry.fileB === 'b.ts',
    );
    expect(partner).toEqual(expect.objectContaining({ structurallyLinked: true }));
  });
});
