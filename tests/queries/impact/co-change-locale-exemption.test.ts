import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ScipQueryConfig } from '../../../src/domain/types.js';
import { coChange } from '../../../src/queries/cleanup/co-change.js';
import { ScipDatabase } from '../../../src/storage/db.js';
import { evidenceFixtureDb } from '../../fixtures/evidence-fixture.js';

// 21.2 calibration retune (external calibration: Vega_2.0 §5 — "suppress
// same-directory pairs and locale-sibling (locales/*.json) pairs by default
// — the 'hidden' premise fails when colocation already signals the
// coupling"). Locale/i18n resource pairs co-change constantly by design
// (every language file changes together) and that coupling is already
// obvious from the directory layout — not the hidden-coupling shape
// co-change exists to surface.

let commitClock = 1_700_200_000;
const tempRoots: string[] = [];
const openDbs: ScipDatabase[] = [];

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

afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('co-change locale/i18n sibling exemption', () => {
  it('exempts locales/** pairs, sibling-locale-dir same-basename json pairs, but not an unrelated pair', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'scip-co-change-locale-'));
    tempRoots.push(repoRoot);
    gitIn(repoRoot, 'init');

    commitIn(repoRoot, 'initial', {
      'src/locales/en/common.json': '{ "hello": "Hello" }\n',
      'src/locales/fr/common.json': '{ "hello": "Bonjour" }\n',
      'src/translations/en/errors.json': '{ "notFound": "Not found" }\n',
      'src/translations/fr/errors.json': '{ "notFound": "Introuvable" }\n',
      'src/service-a.ts': 'export const a = 0;\n',
      'src/service-b.ts': 'export const b = 0;\n',
    });
    for (let version = 1; version <= 5; version += 1) {
      commitIn(repoRoot, `locale update ${version}`, {
        'src/locales/en/common.json': `{ "hello": "Hello ${version}" }\n`,
        'src/locales/fr/common.json': `{ "hello": "Bonjour ${version}" }\n`,
        'src/translations/en/errors.json': `{ "notFound": "Not found ${version}" }\n`,
        'src/translations/fr/errors.json': `{ "notFound": "Introuvable ${version}" }\n`,
        'src/service-a.ts': `export const a = ${version};\n`,
        'src/service-b.ts': `export const b = ${version};\n`,
      });
    }

    const dbPath = join(repoRoot, 'index.db');
    evidenceFixtureDb(dbPath)
      .document(1, 'json', 'src/locales/en/common.json')
      .document(2, 'json', 'src/locales/fr/common.json')
      .document(3, 'json', 'src/translations/en/errors.json')
      .document(4, 'json', 'src/translations/fr/errors.json')
      .document(5, 'typescript', 'src/service-a.ts')
      .document(6, 'typescript', 'src/service-b.ts')
      .write();

    const config: ScipQueryConfig = { dbPath, indexPath: join(repoRoot, 'index.scip'), projectRoot: repoRoot };
    const db = new ScipDatabase(config);
    openDbs.push(db);

    const result = coChange(db, undefined, { minTogether: 4, minConfidence: 0.6, limit: 30 });

    const hasPair = (fileA: string, fileB: string): boolean =>
      result.findings.some(
        (finding) =>
          (finding.fileA === fileA && finding.fileB === fileB) || (finding.fileA === fileB && finding.fileB === fileA),
      );

    // Both under literal locales/ — exempt.
    expect(hasPair('src/locales/en/common.json', 'src/locales/fr/common.json')).toBe(false);
    // Same basename, sibling per-locale dirs, not literally named locales/i18n — exempt.
    expect(hasPair('src/translations/en/errors.json', 'src/translations/fr/errors.json')).toBe(false);
    // Unrelated pair with no locale shape — still reported.
    expect(hasPair('src/service-a.ts', 'src/service-b.ts')).toBe(true);
  });
});
