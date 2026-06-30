import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ScipDatabase } from '../../../src/storage/db.js';
import { buildReactComponentBehaviorProfilesForFile, frontendBehaviorProduct } from '../../../src/source/ast.js';
import { reactComponentDuplicates } from '../../../src/queries/frontend/react-component-duplicates.js';
import { reactHookCandidates } from '../../../src/queries/frontend/react-hook-candidates.js';
import { reactLargeComponentPressure } from '../../../src/queries/frontend/react-large-component-pressure.js';
import { health } from '../../../src/queries/health/health.js';
import type { ScipQueryConfig } from '../../../src/domain/types.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../../fixtures/evidence-fixture.js';

const ISSUE_PANEL = `import { useEffect, useMemo, useState } from 'react';
import { useResource } from '../resource';

export function IssuePanel() {
  const resource = useResource('issues');
  const [rows, setRows] = useState<unknown[]>([]);
  const filters: string[] = [];
  const columns: string[] = [];
  const visibleRows = useMemo(() => rows.filter(Boolean), [rows]);

  useEffect(() => {
    fetch('/issues').then(() => setRows([]));
  }, []);

  const handleRefresh = () => fetch('/issues');
  const handleSelect = (row: unknown) => row;

  return (
    <PageShell title="Issues">
      <ToolbarPanel filters={filters} onReset={handleRefresh}>
        <StatusPill tone="neutral">Ready</StatusPill>
      </ToolbarPanel>
      <RecordTable rows={visibleRows} columns={columns} loading={resource.loading} onSelect={handleSelect}>
        <UiButton disabled={resource.loading} onClick={handleRefresh}>Save</UiButton>
      </RecordTable>
    </PageShell>
  );
}
`;

const INCIDENT_PANEL = ISSUE_PANEL.replace('IssuePanel', 'IncidentPanel')
  .replace("useResource('issues')", "useResource('incidents')")
  .replace("fetch('/issues')", "fetch('/incidents')")
  .replace("fetch('/issues')", "fetch('/incidents')")
  .replace('title="Issues"', 'title="Incidents"');

const CALENDAR_PANEL = `export function CalendarPanel() {
  const days: unknown[] = [];
  const handleDateChange = (day: unknown) => day;

  return (
    <CalendarShell>
      <MonthGrid days={days} onChange={handleDateChange}>
        <TimeBadge value="morning" />
      </MonthGrid>
    </CalendarShell>
  );
}
`;

const LARGE_DASHBOARD = `export function LargeDashboard() {
  return (
    <section>
${Array.from({ length: 305 }, (_entry, index) => `      <div data-row="${index}">{${index}}</div>`).join('\n')}
    </section>
  );
}
`;

const ROUTE_PAGE = `export function AccountPage() {
  return (
    <main>
${Array.from({ length: 40 }, (_entry, index) => `      <section data-panel="${index}"><h2>Panel ${index}</h2></section>`).join('\n')}
    </main>
  );
}
`;

const ROUTE_LOCAL_COMPONENT = `export function AccountModal() {
  return (
    <dialog>
${Array.from({ length: 40 }, (_entry, index) => `      <section data-step="${index}"><h2>Step ${index}</h2></section>`).join('\n')}
    </dialog>
  );
}
`;

const ROUTE_SIBLING_COMPONENT = `export function AccountDialog() {
  return (
    <dialog>
${Array.from({ length: 40 }, (_entry, index) => `      <section data-row="${index}"><h2>Row ${index}</h2></section>`).join('\n')}
    </dialog>
  );
}
`;

describe('React frontend rich internals', () => {
  let tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    tempDirs = [];
  });

  it('extracts JSX structure and hook behavior from TSX components', () => {
    const { db, projectRoot } = createReactFixture({
      'src/components/IssuePanel.tsx': ISSUE_PANEL,
    });
    try {
      const profiles = buildReactComponentBehaviorProfilesForFile(db, 'src/components/IssuePanel.tsx');
      const frontend = frontendBehaviorProduct(db);
      expect(frontend.capability('react-component-behavior-profiles', 'src/components/IssuePanel.tsx')).toEqual(
        expect.objectContaining({ available: true, framework: 'react' }),
      );
      expect(frontend.capability('react-component-behavior-profiles', 'src/components/IssuePanel.vue')).toEqual(
        expect.objectContaining({ available: false, framework: 'react' }),
      );
      expect(frontend.reactProfilesForFile('src/components/IssuePanel.tsx')).toEqual(profiles);
      const profile = profiles.find((candidate) => candidate.name === 'IssuePanel');

      expect(profile).toEqual(
        expect.objectContaining({
          kind: 'component',
          file: 'src/components/IssuePanel.tsx',
        }),
      );
      expect(profile?.componentNames).toEqual(
        expect.arrayContaining(['PageShell', 'RecordTable', 'StatusPill', 'ToolbarPanel', 'UiButton']),
      );
      expect(profile?.propNames).toEqual(
        expect.arrayContaining(['columns', 'disabled', 'filters', 'loading', 'rows', 'title', 'tone']),
      );
      expect(profile?.eventNames).toEqual(expect.arrayContaining(['click', 'reset', 'select']));
      expect(profile?.hookNames).toEqual(expect.arrayContaining(['useEffect', 'useMemo', 'useResource', 'useState']));
      expect(profile?.requestNames).toEqual(expect.arrayContaining(['fetch', 'useResource']));
      expect(profile?.stateNames).toContain('rows');
      expect(profile?.handlerNames).toEqual(expect.arrayContaining(['handleRefresh', 'handleSelect']));
      expect([...(profile?.jsxTokens ?? [])]).toEqual(
        expect.arrayContaining(['component:RecordTable', 'component:UiButton', 'event:click', 'prop:rows']),
      );
      expect([...(profile?.behaviorTokens ?? [])]).toEqual(
        expect.arrayContaining(['hook:useResource', 'request:fetch', 'state:rows', 'handler-verb:refresh']),
      );

      const evidenceDb = new Database(join(projectRoot, 'evidence.db'), { readonly: true });
      try {
        const row = evidenceDb
          .prepare('SELECT COUNT(*) AS count FROM file_evidence WHERE kind = ?')
          .get('react-component-behavior-profiles') as { count: number };
        expect(row.count).toBe(1);
      } finally {
        evidenceDb.close();
      }

      const reopened = new ScipDatabase({
        dbPath: join(projectRoot, 'index.db'),
        indexPath: join(projectRoot, 'index.scip'),
        projectRoot,
      });
      try {
        const cachedProfiles = buildReactComponentBehaviorProfilesForFile(reopened, 'src/components/IssuePanel.tsx');
        expect(cachedProfiles).toEqual(profiles);
      } finally {
        reopened.close();
      }
    } finally {
      db.close();
    }
  });

  it('finds duplicated React component structure, hook candidates, and health pressure', () => {
    const { db } = createReactFixture({
      'src/components/CalendarPanel.tsx': CALENDAR_PANEL,
      'src/components/IncidentPanel.tsx': INCIDENT_PANEL,
      'src/components/IssuePanel.tsx': ISSUE_PANEL,
      'src/components/LargeDashboard.tsx': LARGE_DASHBOARD,
      'src/pages/AccountPage.tsx': ROUTE_PAGE,
      'src/routes/account/components/AccountModal.tsx': ROUTE_LOCAL_COMPONENT,
      'src/routes/account/AccountDialog.tsx': ROUTE_SIBLING_COMPONENT,
    });
    try {
      const duplicates = reactComponentDuplicates(db, {
        limit: 10,
        minSimilarity: 0.6,
        minTokens: 8,
      });
      expect(duplicates).toEqual([
        expect.objectContaining({
          fileA: 'src/components/IncidentPanel.tsx',
          componentA: 'IncidentPanel',
          fileB: 'src/components/IssuePanel.tsx',
          componentB: 'IssuePanel',
          sharedComponents: expect.arrayContaining(['PageShell', 'RecordTable', 'ToolbarPanel', 'UiButton']),
          sharedEvents: expect.arrayContaining(['click', 'reset', 'select']),
        }),
      ]);

      const hookCandidates = reactHookCandidates(db, {
        limit: 10,
        minSimilarity: 0.4,
        minSharedBehaviors: 5,
      });
      expect(hookCandidates).toEqual([
        expect.objectContaining({
          fileA: 'src/components/IncidentPanel.tsx',
          componentA: 'IncidentPanel',
          fileB: 'src/components/IssuePanel.tsx',
          componentB: 'IssuePanel',
          evidenceClass: 'shared-abstraction',
          actionTier: 'support',
          evidenceClassReasons: expect.arrayContaining([
            expect.stringContaining('shared hook is generic workflow: useResource'),
          ]),
          recommendation: expect.stringContaining('existing shared hook'),
          sharedHooks: expect.arrayContaining(['useResource']),
          sharedReactHooks: expect.arrayContaining(['useEffect', 'useMemo', 'useState']),
          sharedRequests: expect.arrayContaining(['fetch', 'useResource']),
          sharedState: expect.arrayContaining(['rows']),
        }),
      ]);

      const pressure = reactLargeComponentPressure(db, {
        limit: 10,
        minComponentLines: 10,
        minFileLines: 100,
        minJsxTokens: 3,
        minBehaviorTokens: 8,
      });
      expect(pressure).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file: 'src/components/IssuePanel.tsx',
            component: 'IssuePanel',
            dominantPressure: expect.any(String),
            pressureKinds: expect.arrayContaining(['component', 'jsx-structure']),
            contextKind: 'component',
            recommendationKind: expect.any(String),
            recommendation: expect.any(String),
          }),
          expect.objectContaining({
            file: 'src/pages/AccountPage.tsx',
            component: 'AccountPage',
            contextKind: 'route-page',
            pressureKinds: expect.arrayContaining(['component', 'jsx-structure']),
            recommendationKind: 'route-page-decomposition',
          }),
          expect.objectContaining({
            file: 'src/routes/account/components/AccountModal.tsx',
            component: 'AccountModal',
            contextKind: 'component',
            pressureKinds: expect.arrayContaining(['component', 'jsx-structure']),
            recommendationKind: 'jsx-decomposition',
          }),
          expect.objectContaining({
            file: 'src/routes/account/AccountDialog.tsx',
            component: 'AccountDialog',
            contextKind: 'component',
            pressureKinds: expect.arrayContaining(['component', 'jsx-structure']),
            recommendationKind: 'jsx-decomposition',
          }),
        ]),
      );

      const report = health(db, { full: true });
      expect(report.findings.reactComponentDuplicatePairs).toBe(1);
      expect(report.findings.reactHookCandidatePairs).toBe(1);
      expect(report.findings.reactHookCandidateScoreCount).toBe(0.5);
      expect(report.findings.reactLargeComponentPressureFiles).toBeGreaterThanOrEqual(1);
      expect(report.actions.map((action) => action.category)).toEqual(
        expect.arrayContaining(['Duplicated React components', 'Duplicated React hook behavior']),
      );
      expect(report.scoreBreakdown).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ axis: 'react-component-duplicates', kind: 'hygiene' }),
          expect.objectContaining({
            axis: 'react-hook-candidates',
            detail: expect.stringContaining('0.5 score-weighted'),
            kind: 'hygiene',
          }),
        ]),
      );
    } finally {
      db.close();
    }
  });

  function createReactFixture(files: Record<string, string>): { db: ScipDatabase; projectRoot: string } {
    const projectRoot = mkdtempSync(join(tmpdir(), 'scip-query-react-frontend-'));
    tempDirs.push(projectRoot);
    const dbPath = join(projectRoot, 'index.db');
    writeFixtureFiles(projectRoot, files);
    const builder = evidenceFixtureDb(dbPath);
    let id = 1;
    for (const relativePath of Object.keys(files).sort()) {
      builder.document(id, 'typescript', relativePath);
      id += 1;
    }
    builder.write();

    const config: ScipQueryConfig = {
      dbPath,
      indexPath: join(projectRoot, 'index.scip'),
      projectRoot,
    };
    return { db: new ScipDatabase(config), projectRoot };
  }
});
