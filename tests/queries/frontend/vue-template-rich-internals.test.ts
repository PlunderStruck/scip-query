import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ScipDatabase } from '../../../src/storage/db.js';
import { buildVueComponentBehaviorProfile, getCallSites, getVueSfcUnit, getVueTemplateFacts } from '../../../src/source/ast.js';
import { vueComposableCandidates } from '../../../src/queries/frontend/vue-composable-candidates.js';
import { vueComponentDuplicates } from '../../../src/queries/frontend/vue-component-duplicates.js';
import { vueLargeViewPressure } from '../../../src/queries/frontend/vue-large-view-pressure.js';
import { health } from '../../../src/queries/health/health.js';
import type { ScipQueryConfig } from '../../../src/domain/types.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../../fixtures/evidence-fixture.js';

const ISSUE_PANEL = `<template>
  <PageShell :title="title">
    <ToolbarPanel v-if="hasFilters" :filters="filters" @reset="resetFilters">
      <StatusPill :tone="statusTone">Ready</StatusPill>
    </ToolbarPanel>
    <RecordTable :rows="rows" :columns="columns" :loading="isLoading" @select="selectRecord">
      <template #status="{ row }">
        <StatusPill :tone="row.statusTone">Status</StatusPill>
      </template>
      <template #actions="{ row }">
        <UiButton class="ghostClass" data-testid="save-record" :icon="'mdi-plus'" :disabled="isSaving" @click="saveRecord(row)">Save</UiButton>
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

const INCIDENT_PANEL = ISSUE_PANEL
  .replace("const title = 'Issues';", "const title = 'Incidents';");

const CALENDAR_PANEL = `<template>
  <CalendarShell>
    <MonthGrid :days="days" @change="selectDate">
      <template #cell="{ day }">
        <TimeBadge :value="day.window" />
      </template>
    </MonthGrid>
  </CalendarShell>
</template>
<script setup lang="ts">
const days: unknown[] = [];
function selectDate(day: unknown) {
  return formatDate(day);
}
</script>
`;

const SHARED_BEHAVIOR_PANEL = `<template>
  <section v-if="isOpen">
    <button @click="loadRecords">Load</button>
    <ResultList :items="visibleRows" />
  </section>
</template>
<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useResource } from '../resource';
import { useToast } from '../toast';

const resource = useResource('records');
const toast = useToast();
const isOpen = ref(false);
const rows = ref<unknown[]>([]);
const visibleRows = computed(() => rows.value);

watch(rows, () => toast.info('changed'));
onMounted(loadRecords);

function loadRecords() {
  return runRequest(() => fetch('/records'));
}
</script>
`;

const SHARED_BEHAVIOR_EXTERNAL = `<template>
  <article v-if="isOpen">
    <button @click="loadRecords">Refresh</button>
    <ResultGrid :items="visibleRows" />
  </article>
</template>
<script lang="ts" src="./SharedBehaviorExternal.script.ts"></script>
<style>
.panel { display: grid; }
</style>
`;

const SHARED_BEHAVIOR_EXTERNAL_SCRIPT = `import { computed, onMounted, ref, watch } from 'vue';
import { useResource } from '../resource';
import { useToast } from '../toast';

const resource = useResource('external-records');
const toast = useToast();
const isOpen = ref(false);
const rows = ref<unknown[]>([]);
const visibleRows = computed(() => rows.value);

watch(rows, () => toast.info('changed'));
onMounted(loadRecords);

function loadRecords() {
  return runRequest(() => fetch('/external-records'));
}
`;

describe('Vue template rich internals', () => {
  let tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    tempDirs = [];
  });

  it('extracts template components, bindings, slots, directives, and script call sites from a Vue SFC', () => {
    const { db } = createVueFixture({
      'src/components/IssuePanel.vue': ISSUE_PANEL,
    });
    try {
      const facts = getVueTemplateFacts(db, 'src/components/IssuePanel.vue');

      expect(facts.template).toEqual(expect.objectContaining({ startLine: 0 }));
      expect(facts.componentTags.map((tag) => tag.normalized)).toEqual([
        'PageShell',
        'ToolbarPanel',
        'StatusPill',
        'RecordTable',
        'StatusPill',
        'UiButton',
      ]);
      expect(facts.props.map((prop) => prop.name)).toEqual(
        expect.arrayContaining(['title', 'filters', 'tone', 'rows', 'columns', 'loading', 'disabled']),
      );
      expect(facts.events.map((event) => event.name)).toEqual(expect.arrayContaining(['reset', 'select', 'click']));
      expect(facts.slots.map((slot) => slot.name)).toEqual(expect.arrayContaining(['status', 'actions']));
      expect(facts.directives.map((directive) => directive.name)).toContain('if');
      expect(facts.expressionIdentifiers.map((identifier) => identifier.name)).toEqual(
        expect.arrayContaining(['title', 'hasFilters', 'rows', 'row', 'saveRecord', 'isSaving']),
      );
      expect(facts.expressionIdentifiers.map((identifier) => identifier.name)).not.toEqual(
        expect.arrayContaining(['ghostClass', 'save', 'record', 'mdi', 'plus']),
      );
      expect(facts.structuralTokens).toEqual(
        expect.arrayContaining([
          'component:RecordTable',
          'component:UiButton',
          'event:click',
          'prop:rows',
          'slot:actions',
        ]),
      );
      expect(facts.structuralTokens).not.toEqual(expect.arrayContaining(['id:ghostClass', 'id:save']));

      const callSites = getCallSites(db, 'src/components/IssuePanel.vue');
      expect(callSites?.map((site) => site.calleeLeaf)).toContain('normalizeRow');
    } finally {
      db.close();
    }
  });

  it('resolves external Vue scripts into component behavior profiles', () => {
    const { db } = createVueFixture({
      'src/components/SharedBehaviorPanel.vue': SHARED_BEHAVIOR_PANEL,
      'src/components/SharedBehaviorExternal.vue': SHARED_BEHAVIOR_EXTERNAL,
      'src/components/SharedBehaviorExternal.script.ts': SHARED_BEHAVIOR_EXTERNAL_SCRIPT,
    });
    try {
      const unit = getVueSfcUnit(db, 'src/components/SharedBehaviorExternal.vue');
      expect(unit.scripts).toHaveLength(1);
      expect(unit.scripts[0]).toEqual(expect.objectContaining({
        external: true,
        sourcePath: 'src/components/SharedBehaviorExternal.script.ts',
        startLine: 0,
      }));

      const profile = buildVueComponentBehaviorProfile(db, 'src/components/SharedBehaviorExternal.vue');
      expect(profile.scriptFacts.composables).toEqual(expect.arrayContaining(['useResource', 'useToast']));
      expect(profile.scriptFacts.requests).toEqual(expect.arrayContaining(['fetch', 'runRequest', 'useResource']));
      expect(profile.scriptFacts.lifecycle).toContain('onMounted');
      expect(profile.externalScriptPaths).toEqual(['src/components/SharedBehaviorExternal.script.ts']);
      expect(profile.externalScriptLines).toBeGreaterThan(0);
      expect([...profile.behaviorTokens]).toEqual(expect.arrayContaining([
        'composable:useResource',
        'request:runRequest',
        'template-binding:visibleRows',
      ]));

      const candidates = vueComposableCandidates(db, {
        limit: 10,
        minSimilarity: 0.4,
        minSharedBehaviors: 6,
      });
      expect(candidates).toEqual([
        expect.objectContaining({
          fileA: 'src/components/SharedBehaviorExternal.vue',
          fileB: 'src/components/SharedBehaviorPanel.vue',
          sharedComposables: expect.arrayContaining(['useResource', 'useToast']),
          sharedRequests: expect.arrayContaining(['fetch', 'runRequest', 'useResource']),
          sharedLifecycle: expect.arrayContaining(['onMounted']),
        }),
      ]);

      const pressure = vueLargeViewPressure(db, {
        limit: 10,
        minTotalLines: 10,
        minScriptLines: 10,
        minTemplateLines: 100,
        minStyleLines: 100,
      });
      expect(pressure).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file: 'src/components/SharedBehaviorExternal.vue',
            externalScriptPaths: ['src/components/SharedBehaviorExternal.script.ts'],
            externalScriptLines: expect.any(Number),
            dominantPressure: 'external-script',
          }),
        ]),
      );

      const report = health(db, { full: true });
      expect(report.findings.vueComposableCandidatePairs).toBe(1);
      expect(report.findings.vueComposableCandidateScoreCount).toBe(0.5);
      expect(report.scoreBreakdown).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            axis: 'vue-composable-candidates',
            detail: expect.stringContaining('0.5 score-weighted'),
            kind: 'hygiene',
          }),
        ]),
      );
    } finally {
      db.close();
    }
  });

  it('finds duplicated Vue component structures and feeds them into health scoring', () => {
    const { db } = createVueFixture({
      'src/components/IssuePanel.vue': ISSUE_PANEL,
      'src/components/IncidentPanel.vue': INCIDENT_PANEL,
      'src/components/CalendarPanel.vue': CALENDAR_PANEL,
    });
    try {
      const duplicates = vueComponentDuplicates(db, {
        limit: 10,
        minSimilarity: 0.6,
        minTokens: 8,
      });

      expect(duplicates).toHaveLength(1);
      expect(duplicates[0]).toEqual(expect.objectContaining({
        fileA: 'src/components/IncidentPanel.vue',
        fileB: 'src/components/IssuePanel.vue',
      }));
      expect(duplicates[0]?.sharedComponents).toEqual(
        expect.arrayContaining(['PageShell', 'RecordTable', 'ToolbarPanel', 'UiButton']),
      );
      expect(duplicates[0]?.sharedSlots).toEqual(expect.arrayContaining(['actions', 'status']));

      const report = health(db, { full: true });
      expect(report.findings.vueComponentDuplicatePairs).toBe(1);
      expect(report.actions.map((action) => action.category)).toContain('Duplicated Vue components');
      expect(report.scoreBreakdown).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            axis: 'vue-component-duplicates',
            kind: 'hygiene',
          }),
        ]),
      );
    } finally {
      db.close();
    }
  });

  function createVueFixture(files: Record<string, string>): { db: ScipDatabase; projectRoot: string } {
    const projectRoot = mkdtempSync(join(tmpdir(), 'scip-query-vue-template-'));
    tempDirs.push(projectRoot);
    const dbPath = join(projectRoot, 'index.db');
    writeFixtureFiles(projectRoot, files);
    const builder = evidenceFixtureDb(dbPath);
    let id = 1;
    for (const relativePath of Object.keys(files).sort()) {
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
});
