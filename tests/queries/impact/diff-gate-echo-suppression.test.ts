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

  it('finds repeated shared-owner behavior in callable bodies that existed before the diff', () => {
    expect(changedOwnerFindings()).toMatchObject([
      {
        actionTier: 'direct',
        sourceAnalyzer: 'changed-consumer-owner',
        relatedFiles: ['src/apply.ts', 'src/relay.ts', 'src/sweeper.ts'],
      },
    ]);
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
    semantic: false,
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

function changedOwnerFindings() {
  const root = mkdtempSync(join(tmpdir(), 'scip-diff-gate-changed-owner-'));
  roots.push(root);
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  mkdirSync(join(root, 'src'), { recursive: true });
  const owner = outcomeFunction('applyInvoiceOutcome', 'owner');
  writeFileSync(join(root, 'src/apply.ts'), owner);
  writeFileSync(join(root, 'src/relay.ts'), outcomeFunction('relayInvoice', 'relay'));
  writeFileSync(join(root, 'src/sweeper.ts'), outcomeFunction('sweepInvoice', 'sweeper'));
  execFileSync('git', ['add', '-A'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=t@example.test', 'commit', '-m', 'base'], {
    cwd: root,
    stdio: 'ignore',
  });

  writeFileSync(join(root, 'src/relay.ts'), outcomeFunction('relayInvoice', 'owner'));
  writeFileSync(join(root, 'src/sweeper.ts'), outcomeFunction('sweepInvoice', 'owner'));
  execFileSync('git', ['add', 'src/relay.ts', 'src/sweeper.ts'], { cwd: root, stdio: 'ignore' });

  const dbPath = join(root, 'index.db');
  const ownerSymbol = 'scip-typescript npm fixture 1.0.0 src/`apply.ts`/applyInvoiceOutcome().';
  const relaySymbol = 'scip-typescript npm fixture 1.0.0 src/`relay.ts`/relayInvoice().';
  const sweeperSymbol = 'scip-typescript npm fixture 1.0.0 src/`sweeper.ts`/sweepInvoice().';
  evidenceFixtureDb(dbPath)
    .document(1, 'typescript', 'src/apply.ts')
    .document(2, 'typescript', 'src/relay.ts')
    .document(3, 'typescript', 'src/sweeper.ts')
    .symbol(1, ownerSymbol, 'applyInvoiceOutcome', 12)
    .symbol(2, relaySymbol, 'relayInvoice', 12)
    .symbol(3, sweeperSymbol, 'sweepInvoice', 12)
    .definition(1, 1, 1, 0, 0, 5, 1)
    .definition(2, 2, 2, 0, 0, 5, 1)
    .definition(3, 3, 3, 0, 0, 5, 1)
    .write();
  const config: ScipQueryConfig = { dbPath, indexPath: join(root, 'index.scip'), projectRoot: root };
  const db = new ScipDatabase(config);
  databases.push(db);

  const result = diffGate(db, {
    base: 'HEAD',
    semantic: false,
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
  return result.findings.filter((finding) => finding.sourceAnalyzer === 'changed-consumer-owner');
}

function outcomeFunction(name: string, label: string): string {
  return [
    `export function ${name}(invoice: string) {`,
    '  const normalizedInvoice = normalizeInvoice(invoice);',
    `  auditInvoice('${label}', normalizedInvoice);`,
    "  emitInvoiceMetric('invoice.completed');",
    '  return normalizedInvoice;',
    '}',
    '',
  ].join('\n');
}
