import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { SymbolInformation_Kind, SymbolRole } from '@c4312/scip';
import { extractCandidates } from '../../../src/queries/cleanup/extract-candidates.js';
import { health } from '../../../src/queries/health/health.js';
import { ScipDatabase } from '../../../src/storage/db.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../../fixtures/evidence-fixture.js';

const sym = (leaf: string) => `scip-typescript npm fixture 1.0.0 src/\`orchestrator.ts\`/${leaf}().`;

/**
 * `processOrder` loads and validates (lines 3-4), charges inside one block
 * (lines 11-18) using six callees nothing else uses, then summarizes.
 * `trace` runs across the whole body. `mixed` interleaves every callee so no
 * cut leaves an exclusive region.
 */
const ORCHESTRATOR = [
  'export function processOrder(orderId: string) {',
  "  trace('start');",
  '  const order = loadOrder(orderId);',
  '  const valid = validateOrder(order);',
  '  if (!valid) {',
  '    return null;',
  '  }',
  '  const normalized = normalizeOrder(order);',
  '  const total = normalized.total;',
  '  let receipt = null;',
  '  if (total > 0) {',
  '    const idempotencyKey = buildIdempotencyKey(normalized);',
  '    const charge = chargeCard(normalized, total, idempotencyKey);',
  '    receipt = sendReceipt(charge);',
  '    recordAudit(charge, receipt);',
  '    confirmCharge(charge);',
  '    scheduleFollowUp(receipt);',
  '  }',
  "  trace('charged');",
  '  const summary = summarize(receipt);',
  "  trace('done');",
  '  return finalize(summary);',
  '}',
  'export function mixed(orderId: string) {',
  '  const order = loadOrder(orderId);',
  '  const charge = chargeCard(order, 1, "k");',
  '  validateOrder(order);',
  '  sendReceipt(charge);',
  '  normalizeOrder(order);',
  '  recordAudit(charge, order);',
  '  loadOrder(orderId);',
  '  chargeCard(order, 2, "k");',
  '  validateOrder(order);',
  '  sendReceipt(charge);',
  '  normalizeOrder(order);',
  '  return recordAudit(charge, order);',
  '}',
  'export function buildReport(orderId: string) {',
  '  const order = loadOrder(orderId);',
  '  validateOrder(order);',
  '  const report = {',
  '    id: order.id,',
  '    summary: summarize(',
  '      order,',
  '    ),',
  '    audit: recordAudit(',
  '      order,',
  '      order,',
  '    ),',
  '    final: finalize(',
  '      order,',
  '    ),',
  '  };',
  '  return report;',
  '}',
  'export function trace(step: string) { return step; }',
  'export function loadOrder(id: string) { return { id, total: 1 }; }',
  'export function validateOrder(order: { id: string }) { return Boolean(order.id); }',
  'export function normalizeOrder(order: { id: string; total: number }) { return order; }',
  'export function buildIdempotencyKey(order: { id: string }) { return order.id; }',
  'export function chargeCard(order: { id: string }, total: number, key: string) { return { order, total, key }; }',
  'export function sendReceipt(charge: { total: number }) { return { charge }; }',
  'export function recordAudit(charge: unknown, receipt: unknown) { return [charge, receipt]; }',
  'export function confirmCharge(charge: unknown) { return charge; }',
  'export function scheduleFollowUp(receipt: unknown) { return receipt; }',
  'export function summarize(receipt: unknown) { return { receipt }; }',
  'export function finalize(summary: unknown) { return summary; }',
];

const HELPERS = [
  'trace',
  'loadOrder',
  'validateOrder',
  'normalizeOrder',
  'buildIdempotencyKey',
  'chargeCard',
  'sendReceipt',
  'recordAudit',
  'confirmCharge',
  'scheduleFollowUp',
  'summarize',
  'finalize',
];

function buildFixture(): { root: string; db: ScipDatabase } {
  const root = mkdtempSync(join(tmpdir(), 'scip-query-extract-candidates-'));
  writeFixtureFiles(root, { 'src/orchestrator.ts': ORCHESTRATOR });
  const dbPath = join(root, 'index.db');
  const lineOf = (prefix: string) => ORCHESTRATOR.findIndex((text) => text.startsWith(prefix));
  const endOf = (start: number) => start + ORCHESTRATOR.slice(start).findIndex((text) => text === '}');
  const processStart = lineOf('export function processOrder');
  const mixedStart = lineOf('export function mixed');
  const reportStart = lineOf('export function buildReport');
  const helpersStart = lineOf('export function trace(');
  const fixture = evidenceFixtureDb(dbPath)
    .document(1, 'typescript', 'src/orchestrator.ts')
    .chunk(1, 1, 0, ORCHESTRATOR.length);
  fixture
    .symbol(1, sym('processOrder'), 'processOrder', SymbolInformation_Kind.Function)
    .definition(1, 1, 1, processStart, 0, endOf(processStart), 1);
  fixture
    .symbol(2, sym('mixed'), 'mixed', SymbolInformation_Kind.Function)
    .definition(2, 1, 2, mixedStart, 0, endOf(mixedStart), 1);
  fixture
    .symbol(90, sym('buildReport'), 'buildReport', SymbolInformation_Kind.Function)
    .definition(90, 1, 90, reportStart, 0, endOf(reportStart), 1);
  HELPERS.forEach((leaf, index) => {
    const line = lineOf(`export function ${leaf}(`);
    fixture
      .symbol(3 + index, sym(leaf), leaf, SymbolInformation_Kind.Function)
      .definition(3 + index, 1, 3 + index, line, 0, line, 60);
  });
  // Indexer bindings at every call line, and local symbols with their declaration and use sites.
  ORCHESTRATOR.forEach((text, line) => {
    if (line >= helpersStart) return;
    for (const leaf of HELPERS) {
      const column = text.indexOf(`${leaf}(`);
      if (column >= 0) fixture.occurrence(1, sym(leaf), line, 0, column, column + leaf.length);
    }
  });
  const local = (id: number, name: string, declarationLine: number, uses: Array<[number, boolean]>) => {
    const at = (line: number) => ORCHESTRATOR[line]!.indexOf(name);
    fixture.occurrence(
      1,
      `local ${id}`,
      declarationLine,
      SymbolRole.Definition,
      at(declarationLine),
      at(declarationLine) + name.length,
    );
    for (const [line, write] of uses) {
      fixture.occurrence(1, `local ${id}`, line, write ? SymbolRole.WriteAccess : 0, at(line), at(line) + name.length);
    }
  };
  local(1, 'orderId', 0, [[2, false]]);
  local(2, 'order', 2, [
    [3, false],
    [7, false],
  ]);
  local(3, 'valid', 3, [[4, false]]);
  local(4, 'normalized', 7, [
    [8, false],
    [11, false],
    [12, false],
  ]);
  local(5, 'total', 8, [
    [10, false],
    [12, false],
  ]);
  local(6, 'receipt', 9, [
    [13, true],
    [14, false],
    [16, false],
    [19, false],
  ]);
  local(7, 'idempotencyKey', 11, [[12, false]]);
  local(8, 'charge', 12, [
    [13, false],
    [14, false],
    [15, false],
  ]);
  local(9, 'summary', 19, [[21, false]]);
  fixture.write();
  return { root, db: new ScipDatabase({ projectRoot: root, dbPath, indexPath: join(root, 'index.scip') }) };
}

describe('extractCandidates regions', () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('reports the exclusive block with the locals it would take in and hand back', () => {
    const { root, db } = buildFixture();
    tempDirs.push(root);
    try {
      const results = extractCandidates(db, { minLoc: 10, minCallees: 6, semantic: false });
      expect(results.map((result) => result.shortName)).toEqual(['src:orchestrator:processOrder()']);

      // Calls spread through one multi-line statement belong to one region:
      // no statement-level line separates them, so the three calls inside the
      // literal form one seam from the first call line to the last.
      const sparse = extractCandidates(db, { minLoc: 10, minCallees: 3, semantic: false }).find(
        (result) => result.shortName === 'src:orchestrator:buildReport()',
      );
      const reportStart = ORCHESTRATOR.findIndex((text) => text.startsWith('export function buildReport'));
      expect(
        sparse?.regions.map((region) => [
          region.startLine - reportStart,
          region.endLine - reportStart,
          region.callees.length,
        ]),
      ).toEqual([[5, 12, 3]]);
      expect(sparse?.ownReturnsInRegion).toBe(0);
      const candidate = results[0]!;
      expect(candidate).toMatchObject({
        actionTier: 'signal',
        extractionKind: 'call-region',
        totalCallees: 12,
        unpositionedCallees: 0,
        ambientCallees: ['src:orchestrator:trace()'],
        localsAvailable: true,
        ownReturnsInRegion: 0,
      });
      expect(candidate.regions).toEqual([
        {
          startLine: 10,
          endLine: 17,
          lines: 8,
          kind: 'call-region',
          callees: [
            'src:orchestrator:buildIdempotencyKey()',
            'src:orchestrator:chargeCard()',
            'src:orchestrator:sendReceipt()',
            'src:orchestrator:recordAudit()',
            'src:orchestrator:confirmCharge()',
            'src:orchestrator:scheduleFollowUp()',
          ],
          renderCallees: 0,
          inboundLocals: ['normalized', 'receipt', 'total'],
          outboundLocals: ['receipt'],
          ambientCallees: [],
        },
      ]);
      expect(candidate.recommendation).toContain('lines 11-18 as a helper');
      expect(candidate.recommendation).toContain(
        'take 3 local(s) in (normalized, receipt, total) and hand 1 back (receipt)',
      );
      expect(candidate.evidenceReasons).toEqual(
        expect.arrayContaining([
          '12 callees placed on call lines across 23 lines',
          '1 ambient callee(s) used across the body: src:orchestrator:trace()',
          'lines 11-18 (8 lines) use 6 callees exclusively; 3 local(s) in, 1 out',
          expect.stringMatching(/stay outside the region at lines \d+-\d+/),
        ]),
      );

      const report = health(db);
      // processOrder and buildReport both qualify under the health profile.
      expect(report.findings.extractionCandidates).toBe(2);
      expect(report.scoreBreakdown.some((deduction) => deduction.axis === 'extract')).toBe(false);
      expect(report.actions.find((action) => action.category === 'Extraction candidates')?.description).toContain(
        'review same-file or feature-local extraction seams',
      );
    } finally {
      db.close();
    }
  });
});
