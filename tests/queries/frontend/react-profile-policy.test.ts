import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ScipDatabase } from '../../../src/storage/db.js';
import { reactComponentDuplicateScan } from '../../../src/queries/frontend/react-component-duplicates.js';
import { reactHookCandidateScan } from '../../../src/queries/frontend/react-hook-candidates.js';
import { reactLargeComponentPressureScan } from '../../../src/queries/frontend/react-large-component-pressure.js';
import { health } from '../../../src/queries/health/health.js';
import { uiKitDirectoryFor } from '../../../src/analysis/ui-kit-surface.js';
import type { ScipQueryConfig } from '../../../src/domain/types.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../../fixtures/evidence-fixture.js';

const SHADCN_MANIFEST = JSON.stringify({
  $schema: 'https://ui.shadcn.com/schema.json',
  aliases: { components: '@/components', ui: '@/components/ui', utils: '@/lib/utils' },
});
const TSCONFIG = JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } } });

function primitive(name: string, slot: string): string {
  return `import * as Primitive from '@radix-ui/react-${slot}';

export function ${name}({ className, align = 'center', sideOffset = 4, ...props }: Record<string, unknown>) {
  return (
    <Primitive.Portal>
      <Primitive.Content data-slot="${slot}-content" align={align} sideOffset={sideOffset} className={className} {...props}>
        <Primitive.Arrow data-slot="${slot}-arrow" />
        <span data-slot="${slot}-label">{props.label}</span>
      </Primitive.Content>
    </Primitive.Portal>
  );
}
`;
}

function routePage(name: string): string {
  return `import { HydrationBoundary } from '@tanstack/react-query';

export default async function ${name}({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await requireAuth();
  const client = getQueryClient();
  const dehydratedState = dehydrate(client);
  return (
    <HydrationBoundary state={dehydratedState}>
      <EditCampaignClient campaignId={id} isAdmin={auth.isAdmin} isAgency={auth.isAgency} role={auth.role} />
    </HydrationBoundary>
  );
}
`;
}

function mediaView(name: string): string {
  return `import { useMemo } from 'react';
import { useRouter } from 'next/navigation';

export default function ${name}({ params }: { params: { id: string } }) {
  const router = useRouter();
  const media = useMediaItemQuery(params.id);
  const title = useMemo(() => media.data?.title ?? '', [media.data]);
  const handleClose = () => router.back();
  return (
    <MediaFrame title={title} onClose={handleClose}>
      <MediaPlayer item={media.data} />
    </MediaFrame>
  );
}
`;
}

function panel(name: string): string {
  return `import { useEffect, useState } from 'react';

export function ${name}() {
  const [rows, setRows] = useState<unknown[]>([]);
  const loadRows = () => fetch('/api/rows').then(() => setRows([]));
  useEffect(() => {
    loadRows();
  }, []);
  return (
    <PanelShell title="${name}">
      <RowTable rows={rows} onRefresh={loadRows}>
        <StatusPill tone="neutral">Ready</StatusPill>
      </RowTable>
    </PanelShell>
  );
}
`;
}

const HOOK_TWIN = `import { useEffect, useState } from 'react';

export function useRows() {
  const [rows, setRows] = useState<unknown[]>([]);
  const loadRows = () => fetch('/api/rows').then(() => setRows([]));
  useEffect(() => {
    loadRows();
  }, []);
  return { rows, loadRows };
}
`;

describe('React profile role policy', () => {
  let tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    tempDirs = [];
  });

  it('resolves the shadcn ui directory from components.json through tsconfig paths', () => {
    const { db } = createFixture({
      'components.json': SHADCN_MANIFEST,
      'tsconfig.json': TSCONFIG,
      'src/components/ui/popover.tsx': primitive('PopoverContent', 'popover'),
    });
    try {
      expect(uiKitDirectoryFor(db, 'src/components/ui/popover.tsx')).toEqual({
        directory: 'src/components/ui',
        source: 'shadcn-components-manifest',
        manifest: 'components.json',
      });
      expect(uiKitDirectoryFor(db, 'src/components/Panel.tsx')).toBeNull();
    } finally {
      db.close();
    }
  });

  it('excludes test scaffolding and kit-primitive pairs from duplicate structure, and demotes route pairs', () => {
    const { db } = createFixture({
      'components.json': SHADCN_MANIFEST,
      'tsconfig.json': TSCONFIG,
      'src/components/ui/popover.tsx': primitive('PopoverContent', 'popover'),
      'src/components/ui/hover-card.tsx': primitive('HoverCardContent', 'hover-card'),
      'src/features/issues/IssuePanel.tsx': panel('IssuePanel'),
      'src/features/issues/IssuePanel.test.tsx': panel('IssuePanelHarness'),
      'src/features/incidents/IncidentPanel.tsx': panel('IncidentPanel'),
      'src/app/(dashboard)/campaigns/edit/[id]/page.tsx': routePage('EditCampaignPage'),
      'src/app/(dashboard)/campaigns/edit/[id]/[taskId]/page.tsx': routePage('EditCampaignTaskPage'),
    });
    try {
      const scan = reactComponentDuplicateScan(db, { limit: 20, minSimilarity: 0.6, minTokens: 6 });
      const pairs = scan.results.map((result) => [result.componentA, result.componentB].sort().join('+'));

      expect(pairs).toContain('IncidentPanel+IssuePanel');
      expect(pairs).toContain('EditCampaignPage+EditCampaignTaskPage');
      expect(pairs).not.toContain('HoverCardContent+PopoverContent');
      expect(pairs.some((pair) => pair.includes('IssuePanelHarness'))).toBe(false);

      const product = scan.results.find((result) => result.componentA === 'IncidentPanel');
      expect(product).toEqual(expect.objectContaining({ pairContext: 'product', actionTier: 'signal' }));
      const routePair = scan.results.find((result) =>
        [result.componentA, result.componentB].includes('EditCampaignPage'),
      );
      expect(routePair).toEqual(
        expect.objectContaining({
          pairContext: 'framework-route-pair',
          actionTier: 'support',
          recommendation: expect.stringContaining('route entries share routing scaffolding'),
        }),
      );
      expect(scan.results[0]?.actionTier).toBe('signal');
      expect(scan.exclusions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ reason: 'test-files', count: 1 }),
          expect.objectContaining({ reason: 'ui-kit-pairs', count: 1 }),
        ]),
      );
    } finally {
      db.close();
    }
  });

  it('keeps intercepting-route pairs as shared-view findings and drops hook-component pairs', () => {
    const { db } = createFixture({
      'src/app/(dashboard)/media/[id]/page.tsx': mediaView('MediaPage'),
      'src/app/(dashboard)/@modal/(.)media/[id]/page.tsx': mediaView('MediaModalPage'),
      'src/features/rows/RowsPanel.tsx': panel('RowsPanel'),
      'src/features/rows/useRows.tsx': HOOK_TWIN,
    });
    try {
      const scan = reactHookCandidateScan(db, { limit: 20, minSimilarity: 0.4, minSharedBehaviors: 4 });
      const intercepting = scan.results.find(
        (result) => result.componentA === 'MediaModalPage' || result.componentB === 'MediaModalPage',
      );
      expect(intercepting).toEqual(
        expect.objectContaining({
          pairContext: 'intercepting-route-pair',
          actionTier: 'signal',
          unitKind: 'component',
          recommendation: expect.stringContaining('one shared view component'),
        }),
      );
      expect(scan.results.some((result) => result.componentA === 'useRows' || result.componentB === 'useRows')).toBe(
        false,
      );
      expect(scan.exclusions).toEqual(
        expect.arrayContaining([expect.objectContaining({ reason: 'hook-component-pairs', count: 1 })]),
      );
    } finally {
      db.close();
    }
  });

  it('discloses excluded pressure rows and health policy exclusions', () => {
    const { db } = createFixture({
      'components.json': SHADCN_MANIFEST,
      'tsconfig.json': TSCONFIG,
      'src/components/ui/sidebar.tsx': primitive('SidebarContent', 'sidebar'),
      'src/features/issues/IssuePanel.tsx': panel('IssuePanel'),
      'src/features/issues/IssuePanel.test.tsx': panel('IssuePanelHarness'),
      'src/features/incidents/IncidentPanel.tsx': panel('IncidentPanel'),
    });
    try {
      const pressure = reactLargeComponentPressureScan(db, {
        limit: 20,
        minComponentLines: 1,
        minFileLines: 1,
        minJsxTokens: 1,
        minBehaviorTokens: 1,
      });
      expect(pressure.results.map((result) => result.component).sort()).toEqual(['IncidentPanel', 'IssuePanel']);
      expect(pressure.exclusions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ reason: 'test-files', count: 1 }),
          expect.objectContaining({ reason: 'ui-kit-files', count: 1 }),
        ]),
      );

      const report = health(db, { full: true });
      expect(report.findings.reactComponentDuplicatePairs).toBe(1);
      expect(report.policyExclusions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ detector: 'react-component-duplicates', reason: 'test-files', count: 1 }),
          expect.objectContaining({ detector: 'react-hook-candidates', reason: 'test-files', count: 1 }),
        ]),
      );
    } finally {
      db.close();
    }
  });

  function createFixture(files: Record<string, string>): { db: ScipDatabase; projectRoot: string } {
    const projectRoot = mkdtempSync(join(tmpdir(), 'scip-query-react-policy-'));
    tempDirs.push(projectRoot);
    const dbPath = join(projectRoot, 'index.db');
    writeFixtureFiles(projectRoot, files);
    const builder = evidenceFixtureDb(dbPath);
    let id = 1;
    for (const relativePath of Object.keys(files).sort()) {
      if (!/\.(?:tsx|ts)$/.test(relativePath)) continue;
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
