import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { SymbolInformation_Kind } from '@c4312/scip';
import { ScipDatabase } from '../../../src/storage/db.js';
import { health } from '../../../src/queries/health/health.js';
import { cycles } from '../../../src/queries/graph/cycles.js';
import { dead } from '../../../src/queries/cleanup/dead.js';
import { duplicateBodies } from '../../../src/queries/cleanup/duplicate-bodies.js';
import { passthroughCandidates } from '../../../src/queries/cleanup/passthrough-candidates.js';
import { twinDrift } from '../../../src/queries/cleanup/twin-drift.js';
import { reactComponentDuplicates } from '../../../src/queries/frontend/react-component-duplicates.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../../fixtures/evidence-fixture.js';

/**
 * Recall gate. Every calibration so far removed rows from detector output;
 * this fixture plants one instance of each scored finding kind and asserts
 * that the detectors, and the health report built from them, still report
 * it. A policy that silently swallows one of these is a recall regression.
 */
const FUNCTION = SymbolInformation_Kind.Function;
const sym = (file: string, leaf: string) => `scip-typescript npm seeded 1.0.0 src/\`${file}\`/${leaf}().`;

const FILES: Record<string, string[]> = {
  // Planted cycle: a -> b -> c -> a through plain source imports.
  'src/cycle/a.ts': ["import { fromB } from './b';", 'export function fromA(): number {', '  return fromB() + 1;', '}'],
  'src/cycle/b.ts': ["import { fromC } from './c';", 'export function fromB(): number {', '  return fromC() + 1;', '}'],
  'src/cycle/c.ts': ["import { fromA } from './a';", 'export function fromC(): number {', '  return fromA() + 1;', '}'],
  // Planted exact duplicate bodies in two product files.
  'src/dup/first.ts': [
    'export function chunkFirst(items: string[], size: number) {',
    '  const out: string[][] = [];',
    '  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));',
    '  return out;',
    '}',
  ],
  'src/dup/second.ts': [
    'export function chunkSecond(items: string[], size: number) {',
    '  const out: string[][] = [];',
    '  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));',
    '  return out;',
    '}',
  ],
  // Planted dead export: defined, never referenced anywhere.
  'src/dead/orphan.ts': ['export function orphanHelper(value: number): number {', '  return value * 2;', '}'],
  // Planted drifted twins: same name, diverged bodies, two product files.
  'src/twin/left.ts': [
    'export function escapeRegex(value: string) {',
    "  return value.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&');",
    '}',
  ],
  'src/twin/right.ts': [
    'export function escapeRegex(value: string) {',
    "  return value.replace(/[.*+?^${}()\\\\]/g, '\\\\-');",
    '}',
  ],
  // Planted passthrough: literally forwards its parameters to one callee.
  'src/pass/inner.ts': ['export function innerWork(a: number, b: number): number {', '  return a + b;', '}'],
  'src/pass/outer.ts': [
    "import { innerWork } from './inner';",
    'export function outerWork(a: number, b: number): number {',
    '  return innerWork(a, b);',
    '}',
  ],
  // Planted wrapper: a forwarding callable whose only caller is widely used.
  'src/wrap/relay.ts': ['export function relayNormalize(raw: string): string {', '  return raw.trim();', '}'],
  'src/wrap/presenter.ts': [
    "import { relayNormalize } from './relay';",
    'export function present(raw: string): string {',
    '  return relayNormalize(raw);',
    '}',
  ],
  'src/wrap/consumerA.ts': ["import { present } from './presenter';", 'export const a = present("a");'],
  'src/wrap/consumerB.ts': ["import { present } from './presenter';", 'export const b = present("b");'],
  'src/wrap/consumerC.ts': ["import { present } from './presenter';", 'export const c = present("c");'],
  'src/wrap/consumerD.ts': ["import { present } from './presenter';", 'export const d = present("d");'],
  // Planted duplicated React components and a rendered-only child.
  'src/ui/IssuePanel.tsx': panel('IssuePanel'),
  'src/ui/IncidentPanel.tsx': panel('IncidentPanel'),
  'src/ui/Parent.tsx': [
    "import { Child } from './Child';",
    'export function Parent() {',
    '  return <Child total={1} />;',
    '}',
  ],
  'src/ui/Child.tsx': ['export function Child({ total }: { total: number }) {', '  return <span>{total}</span>;', '}'],
  // Planted extraction seam: one block whose callees appear nowhere else in the function.
  'src/seam/orchestrate.ts': [
    'export function orchestrateImport(rawRows: string[]) {',
    '  const started = Date.now();',
    '  const parsed = parseRows(rawRows);',
    '  const validated = validateRows(parsed);',
    '  const enriched = enrichRows(validated);',
    '  let written = 0;',
    '  if (enriched.length > 0) {',
    '    const batch = openBatch(enriched);',
    '    const receipt = stampBatch(batch);',
    '    written = writeBatch(batch);',
    '    auditBatch(batch, receipt);',
    '    notifyBatch(receipt);',
    '    closeBatch(batch);',
    '  }',
    '  const elapsed = Date.now() - started;',
    '  const report = summarizeRows(enriched, written);',
    '  report.elapsed = elapsed;',
    '  return publishReport(report);',
    '}',
    "export function parseRows(rows: string[]) { return rows.map((row) => row.split(',')); }",
    'export function validateRows(rows: string[][]) { return rows.filter((row) => row.length > 0); }',
    "export function enrichRows(rows: string[][]) { return rows.map((row) => [...row, 'x']); }",
    'export function openBatch(rows: string[][]) { return { rows }; }',
    'export function stampBatch(batch: { rows: string[][] }) { return { batch, at: 1 }; }',
    'export function writeBatch(batch: { rows: string[][] }) { return batch.rows.length; }',
    'export function auditBatch(batch: { rows: string[][] }, receipt: unknown) { return [batch, receipt]; }',
    'export function notifyBatch(receipt: unknown) { return receipt; }',
    'export function closeBatch(batch: { rows: string[][] }) { return batch.rows.length; }',
    'export function summarizeRows(rows: string[][], written: number) { return { rows: rows.length, written, elapsed: 0 }; }',
    'export function publishReport(report: { rows: number; written: number; elapsed: number }) { return report; }',
  ],
  // Consumers that keep every planted symbol except the orphan alive.
  'src/entry/use-all.ts': [
    "import { chunkFirst } from '../dup/first';",
    "import { chunkSecond } from '../dup/second';",
    "import { escapeRegex as escapeLeft } from '../twin/left';",
    "import { escapeRegex as escapeRight } from '../twin/right';",
    "import { outerWork } from '../pass/outer';",
    "import { orchestrateImport } from '../seam/orchestrate';",
    'export const useAll = [chunkFirst([], 1), chunkSecond([], 1), escapeLeft("a"), escapeRight("b"), outerWork(1, 2), orchestrateImport([])];',
  ],
  'src/ui/App.tsx': [
    "import { IssuePanel } from './IssuePanel';",
    "import { IncidentPanel } from './IncidentPanel';",
    "import { Parent } from './Parent';",
    'export function App() {',
    '  return (',
    '    <main>',
    '      <IssuePanel />',
    '      <IncidentPanel />',
    '      <Parent />',
    '    </main>',
    '  );',
    '}',
  ],
};

function panel(name: string): string[] {
  return [
    "import { useEffect, useState } from 'react';",
    `export function ${name}() {`,
    '  const [rows, setRows] = useState<unknown[]>([]);',
    "  const loadRows = () => fetch('/api/rows').then(() => setRows([]));",
    '  useEffect(() => {',
    '    loadRows();',
    '  }, []);',
    '  return (',
    `    <PanelShell title="${name}">`,
    '      <RowTable rows={rows} onRefresh={loadRows}>',
    '        <StatusPill tone="neutral">Ready</StatusPill>',
    '      </RowTable>',
    '    </PanelShell>',
    '  );',
    '}',
  ];
}

describe('seeded defect recall', () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('still reports every planted finding kind after the detector policies', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-seeded-recall-'));
    tempDirs.push(root);
    writeFixtureFiles(root, FILES);
    const dbPath = join(root, 'index.db');
    const builder = evidenceFixtureDb(dbPath);
    const docIds = new Map<string, number>();
    Object.keys(FILES)
      .sort()
      .forEach((file, index) => {
        docIds.set(file, index + 1);
        builder.document(index + 1, 'typescript', file);
      });
    const symbols: Array<[id: number, file: string, leaf: string, start: number, end: number]> = [
      [1, 'src/cycle/a.ts', 'fromA', 1, 3],
      [2, 'src/cycle/b.ts', 'fromB', 1, 3],
      [3, 'src/cycle/c.ts', 'fromC', 1, 3],
      [4, 'src/dup/first.ts', 'chunkFirst', 0, 4],
      [5, 'src/dup/second.ts', 'chunkSecond', 0, 4],
      [6, 'src/dead/orphan.ts', 'orphanHelper', 0, 2],
      [7, 'src/twin/left.ts', 'escapeRegex', 0, 2],
      [8, 'src/twin/right.ts', 'escapeRegex', 0, 2],
      [9, 'src/pass/inner.ts', 'innerWork', 0, 2],
      [10, 'src/pass/outer.ts', 'outerWork', 1, 3],
      [11, 'src/wrap/relay.ts', 'relayNormalize', 0, 2],
      [12, 'src/wrap/presenter.ts', 'present', 1, 3],
      [13, 'src/ui/IssuePanel.tsx', 'IssuePanel', 1, 14],
      [14, 'src/ui/IncidentPanel.tsx', 'IncidentPanel', 1, 14],
      [15, 'src/ui/Parent.tsx', 'Parent', 1, 3],
      [16, 'src/ui/Child.tsx', 'Child', 0, 2],
      [17, 'src/ui/App.tsx', 'App', 3, 11],
      [18, 'src/seam/orchestrate.ts', 'orchestrateImport', 0, 18],
      [19, 'src/seam/orchestrate.ts', 'parseRows', 19, 19],
      [20, 'src/seam/orchestrate.ts', 'validateRows', 20, 20],
      [21, 'src/seam/orchestrate.ts', 'enrichRows', 21, 21],
      [22, 'src/seam/orchestrate.ts', 'openBatch', 22, 22],
      [23, 'src/seam/orchestrate.ts', 'stampBatch', 23, 23],
      [24, 'src/seam/orchestrate.ts', 'writeBatch', 24, 24],
      [25, 'src/seam/orchestrate.ts', 'auditBatch', 25, 25],
      [26, 'src/seam/orchestrate.ts', 'notifyBatch', 26, 26],
      [27, 'src/seam/orchestrate.ts', 'closeBatch', 27, 27],
      [28, 'src/seam/orchestrate.ts', 'summarizeRows', 28, 28],
      [29, 'src/seam/orchestrate.ts', 'publishReport', 29, 29],
    ];
    for (const [id, file, leaf, start, end] of symbols) {
      const doc = docIds.get(file)!;
      builder.symbol(id, sym(file.replace('src/', ''), leaf), leaf, FUNCTION);
      builder.definition(id, doc, id, start, 0, end, 1);
    }
    // One chunk per document covering the whole file; definition mentions
    // (role 1) for every symbol, reference mentions (role 0) for the planted
    // consumers.
    const references: Array<[file: string, symbolId: number]> = [
      ['src/cycle/a.ts', 2],
      ['src/cycle/b.ts', 3],
      ['src/cycle/c.ts', 1],
      ['src/pass/outer.ts', 9],
      ['src/wrap/presenter.ts', 11],
      ['src/wrap/consumerA.ts', 12],
      ['src/wrap/consumerB.ts', 12],
      ['src/wrap/consumerC.ts', 12],
      ['src/wrap/consumerD.ts', 12],
      ['src/ui/Parent.tsx', 16],
      ['src/entry/use-all.ts', 4],
      ['src/entry/use-all.ts', 5],
      ['src/entry/use-all.ts', 7],
      ['src/entry/use-all.ts', 8],
      ['src/entry/use-all.ts', 10],
      ['src/ui/App.tsx', 13],
      ['src/ui/App.tsx', 14],
      ['src/ui/App.tsx', 15],
      ['src/entry/use-all.ts', 18],
      ...([19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29] as const).map((id): [string, number] => [
        'src/seam/orchestrate.ts',
        id,
      ]),
    ];
    for (const [file, doc] of docIds) {
      builder.chunk(doc, doc, 0, FILES[file]!.length);
    }
    for (const [id, file] of symbols) builder.mention(docIds.get(file)!, id, 1);
    for (const [file, symbolId] of references) builder.mention(docIds.get(file)!, symbolId, 0);
    builder.write();

    const db = new ScipDatabase({ projectRoot: root, dbPath, indexPath: join(root, 'index.scip') });
    try {
      const realCycles = cycles(db).filter((cycle) => cycle.kind === 'real');
      expect(realCycles.map((cycle) => cycle.component)).toEqual([
        ['src/cycle/a.ts', 'src/cycle/b.ts', 'src/cycle/c.ts'],
      ]);

      expect(
        duplicateBodies(db, { minLoc: 1 }).map((group) => group.functions.map((entry) => entry.file).sort()),
      ).toEqual(expect.arrayContaining([['src/dup/first.ts', 'src/dup/second.ts']]));

      // The fixture root `App` has no consumer of its own, so it is dead too;
      // the planted orphan must be reported alongside it.
      const deadSymbols = dead(db, { semantic: false }).symbols.filter((symbol) => symbol.kind === 'dead-code');
      expect(deadSymbols.map((symbol) => symbol.shortName)).toEqual(
        expect.arrayContaining([expect.stringContaining('orphanHelper')]),
      );
      // The rendered-only child is live through its JSX render edge.
      expect(deadSymbols.some((symbol) => symbol.shortName.includes('Child'))).toBe(false);

      expect(twinDrift(db).map((group) => group.leaf)).toEqual(['escapeRegex']);

      expect(passthroughCandidates(db, { semantic: false }).map((candidate) => candidate.shortName)).toEqual(
        expect.arrayContaining([expect.stringContaining('outerWork')]),
      );

      expect(
        reactComponentDuplicates(db, { minSimilarity: 0.6, minTokens: 6 }).map((pair) =>
          [pair.componentA, pair.componentB].sort().join('+'),
        ),
      ).toEqual(['IncidentPanel+IssuePanel']);

      const report = health(db, { full: true });
      expect(report.findings).toEqual(
        expect.objectContaining({
          cycles: 1,
          twinDriftGroups: 1,
          reactComponentDuplicatePairs: 1,
        }),
      );
      expect(report.findings.duplicateBodyGroups).toBeGreaterThanOrEqual(1);
      expect(report.findings.deadSymbols).toBeGreaterThanOrEqual(1);
      expect(report.findings.passthroughs).toBeGreaterThanOrEqual(1);
      expect(report.findings).not.toHaveProperty('wrappers');
      expect(report.findings).not.toHaveProperty('extractionCandidates');
    } finally {
      db.close();
    }
  });
});
