import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { create, fromBinary } from '@bufbuild/protobuf';
import { DocumentSchema, IndexSchema, MetadataSchema, ToolInfoSchema, PositionEncoding } from '@c4312/scip';
import { expect, it } from 'vitest';
import { sanitizeScipFile, sanitizeScipIndex } from '../../src/reindex/sanitize.js';
import { mergeScipIndexes } from '../../src/reindex/merge.js';
import { normalizeOccurrenceRange } from '../../src/domain/scip-range.js';

function pythonIndex(version: string, path: string, encoding = PositionEncoding.UnspecifiedPositionEncoding) {
  return create(IndexSchema, {
    metadata: create(MetadataSchema, {
      projectRoot: 'file:///project',
      toolInfo: create(ToolInfoSchema, { name: 'scip-python', version }),
    }),
    documents: [create(DocumentSchema, { relativePath: path, language: 'python', positionEncoding: encoding })],
  });
}

it.each(['0.7.4', '0.7.5'])(
  'recovers only the verified producer %s convention and retains explicit encodings',
  (version) => {
    expect(sanitizeScipIndex(pythonIndex(version, 'known.py')).index.documents[0]?.positionEncoding).toBe(2);
    expect(sanitizeScipIndex(pythonIndex('0.7.3', 'unknown.py')).index.documents[0]?.positionEncoding).toBe(0);
    expect(
      sanitizeScipIndex(pythonIndex('0.7.5', 'explicit.py', PositionEncoding.UTF8CodeUnitOffsetFromLineStart)).index
        .documents[0]?.positionEncoding,
    ).toBe(1);
  },
);

it.each([false, true])(
  'keeps mixed producer provenance from supplying another indexer version a convention (reverse=%s)',
  (reverse) => {
    const indexes = [pythonIndex('0.7.5', 'known.py'), pythonIndex('0.7.3', 'unknown.py')];
    const merged = mergeScipIndexes(reverse ? indexes.reverse() : indexes);
    expect(merged.metadata?.toolInfo).toBeUndefined();
    const repaired = sanitizeScipIndex(merged).index;
    expect(repaired.documents.find((doc) => doc.relativePath === 'known.py')?.positionEncoding).toBe(2);
    expect(repaired.documents.find((doc) => doc.relativePath === 'unknown.py')?.positionEncoding).toBe(0);
  },
);

it('aligns actual pinned Python producer occurrences after non-ASCII text without changing their identity or ranges', () => {
  const require = createRequire(import.meta.url);
  const packagePath = require.resolve('scip-python-plus/package.json');
  const pkg = JSON.parse(readFileSync(packagePath, 'utf8')) as { bin: Record<string, string> };
  const binary = join(dirname(packagePath), Object.values(pkg.bin)[0]!);
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'scip-query-python-encoding-')));
  try {
    const source = 'def target(value):\n    return value\n\nx = "é🚀"; result = target(x)\n';
    writeFileSync(join(root, 'main.py'), source);
    writeFileSync(join(root, 'pyrightconfig.json'), JSON.stringify({ include: ['main.py'], pythonVersion: '3.12' }));
    const path = join(root, 'index.scip');
    execFileSync(
      process.execPath,
      [binary, 'index', '--project-name', 'unicode-audit', '--project-version', '1', '--output', path],
      { cwd: root, timeout: 30_000, stdio: 'pipe' },
    );
    const original = fromBinary(IndexSchema, readFileSync(path));
    expect(original.metadata?.toolInfo).toMatchObject({ name: 'scip-python', version: '0.7.5' });
    const document = original.documents.find((doc) => doc.relativePath === 'main.py')!;
    expect(document.positionEncoding).toBe(0);
    const call = document.occurrences.find(
      (occurrence) => occurrence.range[0] === 3 && occurrence.symbol.endsWith('/target().'),
    )!;
    expect(call.range).toEqual([3, 20, 26]);
    expect(normalizeOccurrenceRange(call.range, undefined, source.split('\n'))).toBeUndefined();
    sanitizeScipFile(path);
    const repaired = fromBinary(IndexSchema, readFileSync(path)).documents.find(
      (doc) => doc.relativePath === 'main.py',
    )!;
    expect(repaired.positionEncoding).toBe(PositionEncoding.UTF16CodeUnitOffsetFromLineStart);
    expect(repaired.occurrences).toEqual(document.occurrences);
    const range = normalizeOccurrenceRange(call.range, 'UTF-16', source.split('\n'))!;
    expect(source.split('\n')[range.startLine]?.slice(range.startColumn, range.endColumn)).toBe('target');
    const bytes = readFileSync(path);
    expect(sanitizeScipFile(path).touchedDocuments).toBe(0);
    expect(readFileSync(path)).toEqual(bytes);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
