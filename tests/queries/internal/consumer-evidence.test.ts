import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { ScipDatabase } from '../../../src/storage/db.js';
import { ProjectIndex } from '../../../src/core/project-index.js';
import type { IndexedDefinition } from '../../../src/domain/types.js';
import {
  consumerEvidenceProduct,
  partitionDefinitionConsumers,
} from '../../../src/queries/internal/consumer-evidence.js';
import type { ScipQueryConfig } from '../../../src/domain/types.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../../fixtures/evidence-fixture.js';

describe('definition consumer evidence', () => {
  it('separates real, re-export-only, and import-only consumers', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'scip-query-consumer-evidence-'));
    const projectRoot = join(tempDir, 'project');
    const dbPath = join(tempDir, 'index.db');

    try {
      writeFixtureFiles(projectRoot, {
        'src/lib.ts': ['export interface PublicApi {', '  id: string;', '}'],
        'src/index.ts': "export { type PublicApi } from './lib.js';\n",
        'src/unused-import.ts': "import type { PublicApi } from './lib.js';\n",
        'src/real.ts': [
          "import type { PublicApi } from './lib.js';",
          'export function usePublicApi(value: PublicApi): string {',
          '  return value.id;',
          '}',
        ],
      });

      evidenceFixtureDb(dbPath)
        .document(1, 'typescript', 'src/lib.ts')
        .document(2, 'typescript', 'src/index.ts')
        .document(3, 'typescript', 'src/unused-import.ts')
        .document(4, 'typescript', 'src/real.ts')
        .symbol(1, 'scip-typescript npm fixture 1.0.0 src/`lib.ts`/PublicApi#', 'PublicApi', 11)
        .definition(1, 1, 1, 0, 0, 2, 1)
        .chunk(1, 1, 0, 2)
        .chunk(2, 2, 0, 0)
        .chunk(3, 3, 0, 0)
        .chunk(4, 4, 0, 3)
        .mention(1, 1, 1)
        .mention(2, 1, 0)
        .mention(3, 1, 0)
        .mention(4, 1, 0)
        .write();
      writeFileSync(
        join(tempDir, 'meta.json'),
        JSON.stringify({ version: 3, status: 'complete', fingerprint: { fixture: 'consumer-evidence' } }),
      );

      const config: ScipQueryConfig = {
        projectRoot,
        dbPath,
        indexPath: join(tempDir, 'index.scip'),
      };
      const db = new ScipDatabase(config);
      try {
        const partition = partitionDefinitionConsumers(
          db,
          {
            relativePath: 'src/lib.ts',
            symbol: 'scip-typescript npm fixture 1.0.0 src/`lib.ts`/PublicApi#',
          },
          ['src/index.ts', 'src/unused-import.ts', 'src/real.ts'],
        );

        expect(partition.realConsumers).toEqual(['src/real.ts']);
        expect(partition.barrelConsumers).toBe(1);
        expect(partition.importOnlyConsumers).toBe(1);

        const definition: IndexedDefinition = {
          symbolId: 1,
          symbol: 'scip-typescript npm fixture 1.0.0 src/`lib.ts`/PublicApi#',
          documentId: 1,
          startLine: 0,
          endLine: 2,
          relativePath: 'src/lib.ts',
          leaf: 'PublicApi',
          parentTypeName: null,
          isFunctionLike: false,
          isTypeLike: true,
          kind: 11,
          documentation: null,
          enclosingSymbol: null,
        };
        const profilePath = join(tempDir, 'consumer-evidence-profile.jsonl');
        const previousProfile = process.env['SCIP_QUERY_PROFILE'];
        const previousProfileOut = process.env['SCIP_QUERY_PROFILE_OUT'];
        const previousRunId = process.env['SCIP_QUERY_PROFILE_RUN_ID'];
        process.env['SCIP_QUERY_PROFILE'] = '1';
        process.env['SCIP_QUERY_PROFILE_OUT'] = profilePath;
        process.env['SCIP_QUERY_PROFILE_RUN_ID'] = 'consumer-fixture-run';
        try {
          const productEvidence = consumerEvidenceProduct(db, new ProjectIndex(db)).forDefinitions([definition], {
            semantic: false,
            sourceFallback: false,
          });
          const evidence = productEvidence.get(1);
          expect(evidence?.realConsumers).toEqual(['src/real.ts']);
          expect(evidence?.barrelConsumers).toBe(1);
          expect(evidence?.importOnlyConsumers).toBe(1);
          expect(evidence?.files.slice().sort((left, right) => left.file.localeCompare(right.file))).toEqual([
            {
              file: 'src/index.ts',
              sources: ['indexed'],
              classification: 'reexport-only',
            },
            {
              file: 'src/real.ts',
              sources: ['indexed'],
              classification: 'real',
            },
            {
              file: 'src/unused-import.ts',
              sources: ['indexed'],
              classification: 'import-only',
            },
          ]);

          const profiledStages = readFileSync(profilePath, 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line) as Record<string, unknown>)
            .filter((event) => String(event['name']).startsWith('consumer-evidence.'));
          expect(profiledStages.map((event) => event['name']).sort()).toEqual([
            'consumer-evidence.classify',
            'consumer-evidence.product',
            'consumer-evidence.provenance',
          ]);
          expect(new Set(profiledStages.map((event) => event['workIdentity'])).size).toBe(1);
          expect(profiledStages[0]?.['workIdentity']).toMatch(/^[a-f0-9]{24}$/);
          expect(profiledStages.every((event) => event['workOutcome'] === 'computed')).toBe(true);
        } finally {
          restoreEnv('SCIP_QUERY_PROFILE', previousProfile);
          restoreEnv('SCIP_QUERY_PROFILE_OUT', previousProfileOut);
          restoreEnv('SCIP_QUERY_PROFILE_RUN_ID', previousRunId);
        }
      } finally {
        db.close();
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
