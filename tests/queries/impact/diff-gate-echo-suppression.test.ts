import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ScipQueryConfig } from '../../../src/domain/types.js';
import { diffGate } from '../../../src/queries/impact/diff-gate.js';
import { ScipDatabase } from '../../../src/storage/db.js';
import { evidenceFixtureDb } from '../../fixtures/evidence-fixture.js';

const roots: string[] = [];
const databases: ScipDatabase[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('diff-gate echo source decisions', () => {
  it('finds the newly added near-duplicate without a source decision', () => {
    expect(echoFindings(false)).toHaveLength(1);
  });

  it('honors ignore-similar on the same newly added near-duplicate target', () => {
    expect(echoFindings(true)).toEqual([]);
  });
});

function echoFindings(suppressed: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'scip-diff-gate-echo-suppression-'));
  roots.push(root);
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  const established = [
    'export function decodeAlpha(value: unknown) {',
    '  const envelope = decodeEnvelope(value);',
    '  if (!envelope.ok) return envelope.result;',
    '  const fields = envelope.value;',
    "  const source = decodeSource(fields['source']);",
    "  if (!source.ok) return { state: 'malformed', error: source.error };",
    '  const expected = createRecord(source.source);',
    "  if (stableJson(fields) !== stableJson(expected)) return { state: 'malformed', error: 'alpha' };",
    "  return { state: 'current', record: expected };",
    '}',
    '',
  ].join('\n');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src/alpha.ts'), established);
  execFileSync('git', ['add', '-A'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=t@example.test', 'commit', '-m', 'base'], {
    cwd: root,
    stdio: 'ignore',
  });

  const candidate = [
    ...(suppressed ? ['// scip-query: ignore-similar — independent decoder contract.'] : []),
    'export function decodeBeta(value: unknown) {',
    '  const envelope = decodeEnvelope(value);',
    '  if (!envelope.ok) return envelope.result;',
    '  const fields = envelope.value;',
    "  const source = decodeSource(fields['source']);",
    "  if (!source.ok) return { state: 'malformed', error: source.error };",
    '  const expected = createRecord(source.source);',
    "  if (stableJson(fields) !== stableJson(expected)) return { state: 'malformed', error: 'beta' };",
    "  return { state: 'current', record: expected };",
    '}',
    '',
  ].join('\n');
  writeFileSync(join(root, 'src/beta.ts'), candidate);
  execFileSync('git', ['add', 'src/beta.ts'], { cwd: root, stdio: 'ignore' });

  const dbPath = join(root, 'index.db');
  evidenceFixtureDb(dbPath)
    .document(1, 'typescript', 'src/alpha.ts')
    .document(2, 'typescript', 'src/beta.ts')
    .symbol(1, 'scip-typescript npm fixture 1.0.0 src/`alpha.ts`/decodeAlpha().', 'decodeAlpha', 12)
    .symbol(2, 'scip-typescript npm fixture 1.0.0 src/`beta.ts`/decodeBeta().', 'decodeBeta', 12)
    .definition(1, 1, 1, 0, 0, 9, 1)
    .definition(2, 2, 2, suppressed ? 1 : 0, 0, suppressed ? 10 : 9, 1)
    .write();
  const config: ScipQueryConfig = { dbPath, indexPath: join(root, 'index.scip'), projectRoot: root };
  const db = new ScipDatabase(config);
  databases.push(db);

  const result = diffGate(db, {
    base: 'HEAD',
    skip: [
      'incomplete-migration',
      'co-change-partner',
      'twin-partner',
      'coverage-contract',
      'architecture',
      'doc-reference',
      'unused-params',
      'new-dead',
    ],
  });

  return result.findings.filter((finding) => finding.check === 'echo');
}
