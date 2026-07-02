import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { docDrift } from '../../../src/queries/cleanup/doc-drift.js';
import type { ScipDatabase } from '../../../src/storage/db.js';

let commitClock = 2_000_000_000;

function fakeDb(projectRoot: string): ScipDatabase {
  return {
    config: { projectRoot },
    all: () => [],
    pathExclusionsFor: () => '',
    isIgnored: () => false,
  } as unknown as ScipDatabase;
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
      GIT_AUTHOR_DATE: `${commitClock} +0000`,
      GIT_COMMITTER_DATE: `${commitClock} +0000`,
    },
  });
}

function commitIn(root: string, message: string, files: Record<string, string>): void {
  commitClock += 60;
  for (const [path, content] of Object.entries(files)) {
    const fullPath = join(root, path);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content);
  }
  gitIn(root, 'add', '-A');
  gitIn(root, 'commit', '-m', message, '--no-gpg-sign');
}

describe('doc-drift', () => {
  it('reports stale cited files with line references and shared citation-kind policy', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-doc-drift-dedicated-'));
    try {
      gitIn(root, 'init');
      commitIn(root, 'initial docs', {
        'README.md': [
          'Use `.scipquery.json` for declaredCouplings configuration:',
          '',
          '```json',
          '{ "declaredCouplings": [{ "files": ["src/a.ts:7"] }] }',
          '```',
          '',
        ].join('\n'),
        'src/a.ts': 'export const version = 1;\n',
      });
      commitIn(root, 'code moves on', {
        'src/a.ts': 'export const version = 2;\n',
      });

      const result = docDrift(fakeDb(root), { doc: 'README.md' });
      const subject = result.findings[0]?.subjects[0];

      expect(subject).toEqual(
        expect.objectContaining({
          file: 'src/a.ts',
          evidence: 'reference',
          citedLines: [7],
          citationKind: 'configuration-example',
          actionTier: 'support',
        }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports broken references but suppresses archived changelog scans by default', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-doc-drift-broken-'));
    try {
      gitIn(root, 'init');
      commitIn(root, 'initial docs', {
        'docs/guide.md': 'Current behavior lives in src/removed.ts.\n',
        'CHANGELOG.md': 'Historical note for src/removed.ts.\n',
        'src/removed.ts': 'export const old = 1;\n',
      });
      gitIn(root, 'rm', 'src/removed.ts');
      commitIn(root, 'remove stale file', {});

      const result = docDrift(fakeDb(root), { limit: 10 });

      expect(result.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            doc: 'docs/guide.md',
            brokenReferences: ['src/removed.ts'],
          }),
        ]),
      );
      expect(result.findings.map((finding) => finding.doc)).not.toContain('CHANGELOG.md');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
