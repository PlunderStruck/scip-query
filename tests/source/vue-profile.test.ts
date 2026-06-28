import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildVueComponentBehaviorProfile } from '../../src/source/vue/vue-profile.js';
import { clearRegisteredCaches } from '../../src/storage/cache-registry.js';
import { ScipDatabase } from '../../src/storage/db.js';
import { evidenceFixtureDb } from '../fixtures/evidence-fixture.js';

describe('Vue component behavior profiles', () => {
  let tempDir: string | null = null;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it('caches source-derived work without sharing mutable profile objects', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-query-vue-profile-'));
    const projectRoot = join(tempDir, 'project');
    mkdirSync(join(projectRoot, 'src'), { recursive: true });
    const vueFile = join(projectRoot, 'src', 'Panel.vue');
    writeFileSync(vueFile, panelSource('IssueTable', 'issues'));

    const dbPath = join(tempDir, 'index.db');
    evidenceFixtureDb(dbPath).document(1, 'vue', 'src/Panel.vue').write();
    const db = new ScipDatabase({
      projectRoot,
      dbPath,
      indexPath: join(tempDir, 'index.scip'),
    });

    try {
      const first = buildVueComponentBehaviorProfile(db, 'src/Panel.vue');
      first.componentNames.push('MutatedTable');
      first.templateTokens.add('component:MutatedTable');
      first.scriptFacts.requests.push('mutatedRequest');
      const second = buildVueComponentBehaviorProfile(db, 'src/Panel.vue');

      expect(second).not.toBe(first);
      expect(second.componentNames).toEqual(['IssueTable']);
      expect(second.templateTokens.has('component:MutatedTable')).toBe(false);
      expect(second.scriptFacts.requests).toEqual(['fetch']);
      expect(second.behaviorTokens.has('request:fetch')).toBe(true);

      writeFileSync(vueFile, panelSource('IncidentTable', 'incidents'));
      clearRegisteredCaches(db, { groups: ['source-file'], file: 'src/Panel.vue' });

      const refreshed = buildVueComponentBehaviorProfile(db, 'src/Panel.vue');
      expect(refreshed).not.toBe(first);
      expect(refreshed.componentNames).toEqual(['IncidentTable']);
      expect(refreshed.behaviorTokens.has('request:fetch')).toBe(true);
      expect(refreshed.sfcLines).toBe(panelSource('IncidentTable', 'incidents').split('\n').length);
    } finally {
      db.close();
    }
  });
});

function panelSource(componentName: string, endpoint: string): string {
  return `<template>
  <${componentName} :rows="rows" @refresh="loadRows" />
</template>
<script setup lang="ts">
const rows: unknown[] = [];
async function loadRows() {
  return fetch('/${endpoint}');
}
</script>
`;
}
