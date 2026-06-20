import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ScipQueryConfig } from '../../../src/domain/types.js';
import { recentDuplicates } from '../../../src/queries/cleanup/recent-duplicates.js';
import { ScipDatabase } from '../../../src/storage/db.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../../fixtures/evidence-fixture.js';

const REACT_ISSUE_PANEL = `import { useEffect, useMemo, useState } from 'react';
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

const REACT_INCIDENT_PANEL = REACT_ISSUE_PANEL.replace('IssuePanel', 'IncidentPanel')
  .replace("useResource('issues')", "useResource('incidents')")
  .replaceAll("fetch('/issues')", "fetch('/incidents')")
  .replace('title="Issues"', 'title="Incidents"');

const VUE_ISSUE_PANEL = `<template>
  <PageShell :title="title">
    <ToolbarPanel v-if="hasFilters" :filters="filters" @reset="resetFilters">
      <StatusPill :tone="statusTone">Ready</StatusPill>
    </ToolbarPanel>
    <RecordTable :rows="rows" :columns="columns" :loading="isLoading" @select="selectRecord">
      <template #status="{ row }">
        <StatusPill :tone="row.statusTone">Status</StatusPill>
      </template>
      <template #actions="{ row }">
        <UiButton :disabled="isSaving" @click="saveRecord(row)">Save</UiButton>
      </template>
    </RecordTable>
  </PageShell>
</template>
<script setup lang="ts">
const title = 'Issues';
const hasFilters = true;
const filters: string[] = [];
const statusTone = 'neutral';
const rows: unknown[] = [];
const columns: string[] = [];
const isLoading = false;
const isSaving = false;

function resetFilters() {}
function selectRecord() {}
function saveRecord(row: unknown) {
  return normalizeRow(row);
}
</script>
`;

const VUE_INCIDENT_PANEL = VUE_ISSUE_PANEL.replace("const title = 'Issues';", "const title = 'Incidents';");

describe('frontend recent duplicates', () => {
  let tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    tempDirs = [];
  });

  it('orients newly added React and Vue frontend duplicates toward established files', () => {
    const { db } = createGitFixture({
      established: {
        'src/components/IssuePanel.tsx': REACT_ISSUE_PANEL,
        'src/components/IssuePanel.vue': VUE_ISSUE_PANEL,
      },
      recent: {
        'src/components/IncidentPanel.tsx': REACT_INCIDENT_PANEL,
        'src/components/IncidentPanel.vue': VUE_INCIDENT_PANEL,
      },
    });

    try {
      const result = recentDuplicates(db, {
        windowCommits: 0,
        limit: 20,
        scope: 'src/components',
      });

      expect(result.available).toBe(true);
      expect(result.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'echo',
            domain: 'react-component',
            basis: 'jsx-structure',
            echoFile: 'src/components/IncidentPanel.tsx',
            echoSymbol: 'IncidentPanel',
            establishedFile: 'src/components/IssuePanel.tsx',
            establishedSymbol: 'IssuePanel',
            sharedEvidence: expect.arrayContaining(['component:RecordTable', 'event:click', 'prop:rows']),
            sharedCallees: [],
          }),
          expect.objectContaining({
            kind: 'echo',
            domain: 'vue-component',
            basis: 'vue-template',
            echoFile: 'src/components/IncidentPanel.vue',
            echoSymbol: 'IncidentPanel',
            establishedFile: 'src/components/IssuePanel.vue',
            establishedSymbol: 'IssuePanel',
            sharedEvidence: expect.arrayContaining(['component:RecordTable', 'event:click', 'slot:actions']),
            sharedCallees: [],
          }),
        ]),
      );
    } finally {
      db.close();
    }
  });

  function createGitFixture(input: { established: Record<string, string>; recent: Record<string, string> }): {
    db: ScipDatabase;
    projectRoot: string;
  } {
    const projectRoot = mkdtempSync(join(tmpdir(), 'scip-query-frontend-recent-'));
    tempDirs.push(projectRoot);

    execGit(projectRoot, ['init']);
    execGit(projectRoot, ['config', 'user.email', 'scip-query-test@example.com']);
    execGit(projectRoot, ['config', 'user.name', 'scip-query test']);

    writeFixtureFiles(projectRoot, input.established);
    execGit(projectRoot, ['add', 'src']);
    execGit(projectRoot, ['commit', '-m', 'Add established frontend concepts']);

    writeFixtureFiles(projectRoot, input.recent);
    execGit(projectRoot, ['add', 'src']);
    execGit(projectRoot, ['commit', '-m', 'Add recent frontend echoes']);

    const allFiles = { ...input.established, ...input.recent };
    const dbPath = join(projectRoot, 'index.db');
    const builder = evidenceFixtureDb(dbPath);
    let id = 1;
    for (const relativePath of Object.keys(allFiles).sort()) {
      builder.document(id, relativePath.endsWith('.vue') ? 'vue' : 'typescript', relativePath);
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

  function execGit(projectRoot: string, args: readonly string[]): void {
    execFileSync('git', args, {
      cwd: projectRoot,
      stdio: 'ignore',
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: '1',
      },
    });
  }
});
