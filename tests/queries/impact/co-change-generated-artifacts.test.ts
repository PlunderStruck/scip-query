import { describe, expect, it } from 'vitest';
import { classifyCoChangePartner, isGeneratedArtifactPath } from '../../../src/queries/cleanup/co-change.js';

describe('co-change generated artifacts', () => {
  it('recognizes migration journals, snapshots, emitted SQL, and codegen output', () => {
    expect(isGeneratedArtifactPath('src/db/migrations/meta/_journal.json')).toBe(true);
    expect(isGeneratedArtifactPath('src/db/migrations/meta/0042_snapshot.json')).toBe(true);
    expect(isGeneratedArtifactPath('drizzle/0042_wide_moon.sql')).toBe(true);
    expect(isGeneratedArtifactPath('prisma/migrations/20240101_init/migration.sql')).toBe(true);
    expect(isGeneratedArtifactPath('src/graphql/__generated__/types.ts')).toBe(true);
    expect(isGeneratedArtifactPath('src/api/client.generated.ts')).toBe(true);
    expect(isGeneratedArtifactPath('src/db/migrations/relations.ts')).toBe(true);
    expect(isGeneratedArtifactPath('drizzle/schema.ts')).toBe(true);
    expect(isGeneratedArtifactPath('src/db/schema/index.ts')).toBe(false);
    expect(isGeneratedArtifactPath('src/lib/campaigns/migrate-offers.ts')).toBe(false);
  });

  it('classifies a journal that co-changes with its schema as a generated-artifact pair', () => {
    expect(classifyCoChangePartner('src/db/migrations/meta/_journal.json', 'src/db/schema/index.ts')).toEqual({
      partnerClass: 'generated-artifact',
      reasons: [expect.stringContaining('generated artifact')],
    });
    expect(classifyCoChangePartner('src/db/schema/index.ts', 'src/db/migrations/meta/_journal.json').partnerClass).toBe(
      'generated-artifact',
    );
  });

  it('still classifies a hand-written schema next to a script as schema-script', () => {
    expect(classifyCoChangePartner('schema/user.schema.json', 'scripts/generate-user.ts').partnerClass).toBe(
      'schema-script',
    );
  });
});
