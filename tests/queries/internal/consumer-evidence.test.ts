import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { ScipDatabase } from '../../../src/storage/db.js';
import { partitionDefinitionConsumers } from '../../../src/queries/internal/consumer-evidence.js';
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
      } finally {
        db.close();
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
