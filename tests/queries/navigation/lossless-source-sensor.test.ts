import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { codeBatch } from '../../../src/queries/navigation/code.js';
import { files } from '../../../src/queries/navigation/files.js';
import { searchSource } from '../../../src/queries/navigation/source-search.js';
import { ScipDatabase } from '../../../src/storage/db.js';
import { evidenceFixtureDb } from '../../fixtures/evidence-fixture.js';

describe('lossless repository text sensor', () => {
  let fixtureRoot: string;
  let projectRoot: string;
  let db: ScipDatabase;

  const sources = {
    'src/aligned.ts': "export const indexedMarker = 'before';\n",
    'docs/architecture.md': 'title\r\nsensorNeedle\r\nsensorBranch\r\n',
    Dockerfile: 'FROM node\nRUN echo sensorNeedle\n',
    'config/settings.yaml': 'mode: sensor\nfinal: true\n',
  } as const;

  beforeEach(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'scip-query-lossless-sensor-'));
    projectRoot = join(fixtureRoot, 'project');
    for (const [relativePath, source] of Object.entries(sources)) writeSource(relativePath, source);
    const binaryPath = join(projectRoot, 'assets/logo.bin');
    mkdirSync(dirname(binaryPath), { recursive: true });
    writeFileSync(binaryPath, Buffer.from([0, 1, 2, 3]));
    writeFileSync(join(projectRoot, 'assets/invalid-utf8.bin'), Buffer.from([0xff, 0xfe]));

    const dbPath = join(fixtureRoot, 'index.db');
    evidenceFixtureDb(dbPath).document(1, 'typescript', 'src/aligned.ts').write();
    const alignedBytes = Buffer.from(sources['src/aligned.ts']);
    writeFileSync(
      join(fixtureRoot, 'meta.json'),
      JSON.stringify({
        version: 3,
        status: 'complete',
        updatedAt: '2026-08-05T00:00:00.000Z',
        fingerprint: {
          version: 3,
          languages: ['typescript'],
          pnpmWorkspaces: false,
          typescriptProjectMode: 'single',
          typescriptProjects: [],
          files: [
            {
              path: 'src/aligned.ts',
              size: alignedBytes.byteLength,
              hash: sha256(alignedBytes),
            },
          ],
        },
        requestedLanguages: ['typescript'],
        indexedLanguages: ['typescript'],
        skipped: [],
      }),
    );
    db = new ScipDatabase({ projectRoot, dbPath, indexPath: join(fixtureRoot, 'index.scip') });
  });

  afterEach(() => {
    db.close();
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it('matches a native filesystem oracle across indexed, unindexed, and extensionless text', () => {
    expect(files(db, '*.md')).toEqual([{ relativePath: 'docs/architecture.md' }]);
    expect(files(db, 'Dockerfile')).toEqual([{ relativePath: 'Dockerfile' }]);
    expect(files(db, '*.bin')).toEqual([
      { relativePath: 'assets/invalid-utf8.bin' },
      { relativePath: 'assets/logo.bin' },
    ]);

    const literal = searchSource(db, 'sensorNeedle', { context: 0, limit: Number.MAX_SAFE_INTEGER });
    const regexp = searchSource(db, 'sensor(?:Needle|Branch)', {
      context: 0,
      limit: Number.MAX_SAFE_INTEGER,
      regexp: true,
    });

    expect(searchIdentities(literal)).toEqual(nativeSearchOracle(/sensorNeedle/u));
    expect(searchIdentities(regexp)).toEqual(nativeSearchOracle(/sensor(?:Needle|Branch)/u));
    expect(literal.identities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relativePath: 'docs/architecture.md',
          focusLine: 1,
          ownerSymbol: null,
          freshness: {
            exactText: expect.objectContaining({ state: 'current', basis: 'working-tree-read' }),
            semantic: { state: 'unavailable', basis: 'no-compiler-document' },
          },
        }),
      ]),
    );
    expect(literal.textCoverage).toMatchObject({
      basis: 'current-project-text-files',
      candidateFiles: 6,
      scannedTextFiles: 4,
      scannedBytes: Object.values(sources).reduce((sum, source) => sum + Buffer.byteLength(source), 0),
      skippedBinaryPaths: ['assets/invalid-utf8.bin', 'assets/logo.bin'],
      skippedUnreadablePaths: [],
      skippedOversizedPaths: [],
      semanticFiles: { aligned: 1, stale: 0, unavailable: 3 },
    });
  });

  it('returns exact current ranges and whole files without compiler facts', () => {
    const packet = codeBatch(db, ['docs/architecture.md:2-3', 'Dockerfile:2-2', 'config/settings.yaml']);

    expect(packet).toMatchObject({ requested: 3, matched: 3, ambiguous: 0, missing: 0 });
    expect(packet.entries[0]?.results[0]).toMatchObject({
      relativePath: 'docs/architecture.md',
      startLine: 1,
      endLine: 2,
      source: 'sensorNeedle\r\nsensorBranch\r',
      freshness: { semantic: { state: 'unavailable', basis: 'no-compiler-document' } },
    });
    expect(packet.entries[1]?.results[0]).toMatchObject({
      relativePath: 'Dockerfile',
      startLine: 1,
      endLine: 1,
      source: 'RUN echo sensorNeedle',
    });
    expect(packet.entries[2]?.results[0]?.source).toBe(readFileSync(join(projectRoot, 'config/settings.yaml'), 'utf8'));

    const wholeFile = codeBatch(db, ['docs/architecture.md']);
    expect(wholeFile.entries[0]?.results[0]?.source).toBe(
      readFileSync(join(projectRoot, 'docs/architecture.md'), 'utf8'),
    );
    expect(wholeFile.entries[0]?.fileCoverage).toMatchObject({ basis: 'complete-file-source', omittedDefinitions: 0 });
    expect(codeBatch(db, ['assets/logo.bin']).entries[0]?.status).toBe('missing');
    expect(codeBatch(db, ['Dockerfile:99-100']).entries[0]?.status).toBe('missing');
  });

  it('returns current text but refuses stale compiler ownership after a working-tree edit', () => {
    const changed = "export const indexedMarker = 'after';\n";
    writeSource('src/aligned.ts', changed);

    const result = searchSource(db, 'after', { context: 0, limit: Number.MAX_SAFE_INTEGER });
    expect(result.matches[0]).toMatchObject({
      source: "export const indexedMarker = 'after';",
      ownerSymbol: null,
      freshness: {
        exactText: { state: 'current', basis: 'working-tree-read', sha256: sha256(Buffer.from(changed)) },
        semantic: { state: 'stale', basis: 'indexed-input-fingerprint' },
      },
    });
    const range = codeBatch(db, ['src/aligned.ts:1-1']).entries[0]?.results[0];
    expect(range).toMatchObject({
      source: "export const indexedMarker = 'after';",
      freshness: { semantic: { state: 'stale', basis: 'indexed-input-fingerprint' } },
    });
    expect(range?.bindingClosure).toBeUndefined();
  });

  function writeSource(relativePath: string, source: string): void {
    const absolutePath = join(projectRoot, relativePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, source);
  }

  function nativeSearchOracle(pattern: RegExp): Array<{ relativePath: string; focusLine: number }> {
    return Object.keys(sources)
      .flatMap((relativePath) => {
        const text = readFileSync(join(projectRoot, relativePath), 'utf8');
        const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
        return lines.flatMap((line, focusLine) =>
          pattern.test(line.endsWith('\r') ? line.slice(0, -1) : line) ? [{ relativePath, focusLine }] : [],
        );
      })
      .sort(compareIdentity);
  }
});

function searchIdentities(result: ReturnType<typeof searchSource>): Array<{ relativePath: string; focusLine: number }> {
  return (result.identities ?? [])
    .map(({ relativePath, focusLine }) => ({ relativePath, focusLine }))
    .sort(compareIdentity);
}

function compareIdentity(
  left: { relativePath: string; focusLine: number },
  right: { relativePath: string; focusLine: number },
): number {
  return left.relativePath.localeCompare(right.relativePath) || left.focusLine - right.focusLine;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
