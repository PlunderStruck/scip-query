import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const CAPTURE_SCRIPT = join(process.cwd(), 'skills/scip-explore/scripts/capture-evidence.mjs');
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('scip-explore external evidence capture', () => {
  it('projects every search identity losslessly and interns a repeated observation checkpoint', () => {
    const fixture = createFixture();
    const identities = [
      searchIdentity('src/example.ts', 9, 'example/run', 5, 15),
      searchIdentity('src/example.ts', 12, 'example/run', 5, 15),
      searchIdentity('src/example.ts', 30, 'example/finish', 28, 34),
    ];
    const first = runCapture(
      fixture,
      'first-search',
      ['search', 'firstExactText'],
      searchEnvelope('firstExactText', identities, '2026-08-23T10:00:00.000Z'),
    );

    expect(first.status).toBe(0);
    expect(first.receipt.observation.result).toMatchObject({
      kind: 'complete-search-identity-manifest',
      identityCoverage: { mode: 'complete', returned: 3, total: 3, omitted: 0 },
      identityManifest: { encoding: 'grouped-file-owner-lines/v1', identities: 3 },
      sourceMaterialization: { state: 'stored-in-raw-packet', excludedFromReceipt: true },
    });
    expect(first.receipt.observation.result.identityManifest.files[0].owners).toEqual([
      expect.objectContaining({ ownerSymbol: 'example/run', focusLines: [9, 12] }),
      expect.objectContaining({ ownerSymbol: 'example/finish', focusLines: [30] }),
    ]);
    expect(first.receipt.observation.result.textCoverage.skippedBinary).toMatchObject({
      count: 1,
      paths: 'stored-in-raw-packet',
    });
    expect(first.receipt.observation.result.textCoverage.skippedBinary.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.raw.result.identities).toEqual(identities);
    expect(first.raw.result.textCoverage.skippedBinaryPaths).toEqual(['assets/example.bin']);
    expect(first.receipt.observation.evidenceCalibration.observation).toBeDefined();

    const second = runCapture(
      fixture,
      'second-search',
      ['search', 'secondExactText'],
      searchEnvelope(
        'secondExactText',
        [searchIdentity('src/other.ts', 4, 'other/run', 1, 8)],
        '2026-08-23T10:01:00.000Z',
      ),
    );

    expect(second.status).toBe(0);
    expect(second.receipt.observation.evidenceCalibration.observation).toBeUndefined();
    expect(second.receipt.observation.evidenceCalibration.observationReference).toMatchObject({
      receiptId: 'first-search',
      observedAt: '2026-08-23T10:01:00.000Z',
      sha256: first.receipt.observation.evidenceCalibration.observationIdentity.sha256,
    });
  });

  it('reuses exact observations and covered code while returning only uncovered overlap selectors', () => {
    const fixture = createFixture();
    const first = runCapture(
      fixture,
      'source-one',
      ['code', 'src/example.ts:1-10'],
      codeEnvelope('src/example.ts:1-10', 'one\ntwo\nthree\n'),
    );
    expect(first.status).toBe(0);

    const duplicate = runCapture(fixture, 'source-duplicate', ['code', 'src/example.ts:1-10'], null);
    expect(duplicate.status).toBe(0);
    expect(duplicate.stdout).toMatchObject({
      status: 'already-captured',
      existingReceiptIds: ['source-one'],
    });
    expect(existsSync(join(fixture.evidenceDir, 'source-duplicate.json'))).toBe(false);

    const covered = runCapture(fixture, 'source-covered', ['code', 'src/example.ts:3-5'], null);
    expect(covered.status).toBe(0);
    expect(covered.stdout).toMatchObject({
      status: 'already-captured',
      existingReceiptIds: ['source-one'],
    });

    const overlap = runCapture(fixture, 'source-overlap', ['code', 'src/example.ts:8-15'], null);
    expect(overlap.status).toBe(2);
    expect(overlap.stdout).toMatchObject({
      status: 'overlap-requires-uncovered-query',
      existingReceiptIds: ['source-one'],
      uncoveredSelectors: ['src/example.ts:11-15'],
    });
    expect(existsSync(join(fixture.evidenceDir, 'source-overlap.json'))).toBe(false);

    const changedSnapshot = searchEnvelope(
      'newSnapshot',
      [searchIdentity('src/new.ts', 2, 'new/run', 1, 4)],
      '2026-08-23T10:02:00.000Z',
      'generation-2',
    );
    expect(runCapture(fixture, 'new-snapshot', ['search', 'newSnapshot'], changedSnapshot).status).toBe(0);
    const refreshed = runCapture(
      fixture,
      'source-refreshed',
      ['code', 'src/example.ts:1-10'],
      codeEnvelope('src/example.ts:1-10', 'changed\n', 'generation-2'),
    );
    expect(refreshed.status).toBe(0);
    expect(refreshed.stdout.kind).toBe('scip-explore-evidence-receipt');
    expect(refreshed.raw.result.code).toBe('changed\n');
  });

  it('refuses incomplete or overlarge projections without shortening the raw packet', () => {
    const incompleteFixture = createFixture();
    const identities = [searchIdentity('src/example.ts', 9, 'example/run', 5, 15)];
    const incompleteEnvelope = searchEnvelope('broadText', identities, '2026-08-23T10:00:00.000Z');
    incompleteEnvelope.result.identityCoverage = { mode: 'bounded', returned: 1, total: 2, omitted: 1 };
    const incomplete = runCapture(incompleteFixture, 'incomplete-search', ['search', 'broadText'], incompleteEnvelope);

    expect(incomplete.status).toBe(2);
    expect(incomplete.stdout.status).toBe('incomplete-locator-projection');
    expect(incomplete.raw.result.identities).toEqual(identities);
    expect(incomplete.receipt.status).toBe('incomplete-locator-projection');

    const overlargeFixture = createFixture();
    const exactSource = 'x'.repeat(40_000);
    const overlarge = runCapture(
      overlargeFixture,
      'overlarge-code',
      ['code', 'src/large.ts:1-4000'],
      codeEnvelope('src/large.ts:1-4000', exactSource),
    );

    expect(overlarge.status).toBe(2);
    expect(overlarge.stdout.status).toBe('projection-too-large');
    expect(overlarge.raw.result.code).toBe(exactSource);
    expect(overlarge.receipt.status).toBe('projection-too-large');
  });

  it('promotes a bounded command rendering only when the exhaustive packet contains the known identity total', () => {
    const fixture = createFixture();
    const identities = [
      searchIdentity('src/one.ts', 1, 'one/run', 1, 3),
      searchIdentity('src/two.ts', 2, 'two/run', 1, 4),
    ];
    const envelope = searchEnvelope('sharedName', identities, '2026-08-23T10:00:00.000Z');
    envelope.result.identityCoverage = { mode: 'bounded', returned: 1, total: 2, omitted: 1 };
    const captured = runCapture(fixture, 'exhaustive-search', ['search', 'sharedName'], envelope);

    expect(captured.status).toBe(0);
    expect(captured.receipt.observation.result.identityCoverage).toMatchObject({
      mode: 'complete-exhaustive-packet',
      returned: 2,
      total: 2,
      omitted: 0,
      commandProjection: { mode: 'bounded', returned: 1, total: 2, omitted: 1 },
    });
    expect(captured.receipt.observation.result.identityManifest.identities).toBe(2);
  });

  it('keeps exact inspect source while externalizing duplicate behavior and frontier proof text', () => {
    const fixture = createFixture();
    const exactSource = 'const observed = true;\n'.repeat(400);
    const envelope = inspectEnvelope(exactSource);
    const captured = runCapture(
      fixture,
      'inspect-behavior',
      ['inspect', '--at', 'src/example.ts:10', '--view', 'behavior'],
      envelope,
    );

    expect(captured.status).toBe(0);
    expect(captured.receipt.observation.result).toMatchObject({
      kind: 'bounded-inspect-behavior-projection',
      slices: [{ relativePath: 'src/example.ts', source: exactSource }],
      units: [{ relativePath: 'src/example.ts', behavior: { signature: 'function run()' } }],
      externalizedFields: { state: 'stored-in-raw-packet' },
    });
    expect(captured.receipt.observation.result.units[0].source).toBeUndefined();
    expect(captured.receipt.observation.result.units[0].behavior.lines).toBeUndefined();
    expect(captured.receipt.observation.result.causalFrontier.withheldAnchorManifest).toMatchObject({
      count: 1,
      state: 'stored-in-raw-packet',
    });
    expect(captured.receipt.observation.result.causalFrontier.withheldAnchorManifest.anchors).toBeUndefined();
    expect(captured.receipt.observation.result.causalFrontier.anchors[0]).not.toHaveProperty('id');
    expect(captured.receipt.observation.result.causalFrontier.anchors[0].callsite).not.toHaveProperty('text');
    expect(captured.raw.result.units[0].source).toBe(exactSource);
    expect(captured.raw.result.units[0].behavior.lines).toHaveLength(400);

    const coveredCode = runCapture(fixture, 'covered-by-inspect', ['code', 'src/example.ts:10-20'], null);
    expect(coveredCode.status).toBe(0);
    expect(coveredCode.stdout).toMatchObject({
      status: 'already-captured',
      existingReceiptIds: ['inspect-behavior'],
    });
  });
});

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'scip-explore-capture-'));
  temporaryRoots.push(root);
  const evidenceDir = join(root, 'evidence');
  const fakeScipQuery = join(root, 'scip-query');
  writeFileSync(
    fakeScipQuery,
    `#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
const outputFlag = process.argv.indexOf('--json-output');
const outputPath = process.argv[outputFlag + 1];
const envelope = readFileSync(process.env.FAKE_SCIP_ENVELOPE, 'utf8');
writeFileSync(outputPath, envelope);
process.stdout.write(JSON.stringify({
  path: outputPath,
  bytes: Buffer.byteLength(envelope),
  sha256: createHash('sha256').update(envelope).digest('hex'),
}) + '\\n');
`,
  );
  chmodSync(fakeScipQuery, 0o700);
  return { root, evidenceDir, fakeScipQuery };
}

function runCapture(
  fixture: ReturnType<typeof createFixture>,
  id: string,
  args: string[],
  envelope:
    | ReturnType<typeof searchEnvelope>
    | ReturnType<typeof codeEnvelope>
    | ReturnType<typeof inspectEnvelope>
    | null,
) {
  const envelopePath = join(fixture.root, `${id}-envelope.json`);
  if (envelope !== null) writeFileSync(envelopePath, JSON.stringify(envelope));
  const execution = spawnSync(process.execPath, [CAPTURE_SCRIPT, '--id', id, '--', ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fixture.root}${delimiter}${process.env.PATH ?? ''}`,
      SCIP_EXPLORE_EVIDENCE_DIR: fixture.evidenceDir,
      FAKE_SCIP_ENVELOPE: envelopePath,
    },
  });
  if (execution.stderr !== '') throw new Error(execution.stderr);
  const stdout = JSON.parse(execution.stdout.trim());
  const rawPath = join(fixture.evidenceDir, `${id}.json`);
  const receiptPath = join(fixture.evidenceDir, `${id}.receipt.json`);
  return {
    status: execution.status,
    stdout,
    raw: existsSync(rawPath) ? JSON.parse(readFileSync(rawPath, 'utf8')) : null,
    receipt: existsSync(receiptPath) ? JSON.parse(readFileSync(receiptPath, 'utf8')) : null,
  };
}

function searchEnvelope(
  pattern: string,
  identities: ReturnType<typeof searchIdentity>[],
  observedAt: string,
  generation = 'generation-1',
) {
  return {
    command: 'search',
    operationRole: 'locator',
    evidence: { strength: 'exact' },
    args: [pattern],
    coverage: { status: 'complete' },
    result: {
      pattern,
      mode: 'literal',
      identities,
      identityCoverage: { mode: 'complete', returned: identities.length, total: identities.length, omitted: 0 },
      scopeHints: [{ scope: 'src', matches: identities.length }],
      omittedScopeHints: 0,
      matchingLines: identities.length,
      matchingFiles: new Set(identities.map((identity) => identity.relativePath)).size,
      scannedFiles: 12,
      textCoverage: {
        basis: 'current-project-text-files',
        candidateFiles: 13,
        scannedTextFiles: 12,
        scannedBytes: 1_024,
        skippedBinaryPaths: ['assets/example.bin'],
        skippedUnreadablePaths: [],
        skippedOversizedPaths: [],
        semanticFiles: { aligned: 10, stale: 0, unavailable: 2 },
      },
      matches: [{ source: 'intentionally retained only in the exhaustive packet' }],
    },
    agentResult: { deliberately: 'not-used-for-search-identity-coverage' },
    evidenceContext: evidenceContext(observedAt, generation),
  };
}

function codeEnvelope(selector: string, code: string, generation = 'generation-1') {
  return {
    command: 'code',
    operationRole: 'source',
    evidence: { strength: 'exact' },
    args: [selector],
    coverage: { status: 'complete' },
    result: { matched: 1, suggestions: [], code },
    evidenceContext: evidenceContext('2026-08-23T10:00:00.000Z', generation),
  };
}

function inspectEnvelope(source: string) {
  const anchor = {
    id: 'verbose-anchor-identity-that-remains-in-the-raw-packet',
    status: 'exact',
    source: 'graph-call',
    direction: 'downstream',
    causalRole: 'callee',
    relationKind: 'call',
    fromStepId: 'inspect:src/example.ts:1-400',
    fromLabel: 'src/example.ts:10',
    callsite: {
      file: 'src/example.ts',
      line: 10,
      endLine: 10,
      text: 'const observed = true;',
      signals: ['binding', 'call', 'shape'],
      calleeLeaf: 'observed',
    },
    alternatives: [{ symbol: 'example/observed', label: 'observed', file: 'src/example.ts', line: 10, endLine: 10 }],
    alternativeCount: 1,
    evidence: [
      {
        method: 'compiler-callsite',
        strength: 'exact',
        identity: 'example/observed',
        location: { file: 'src/example.ts', line: 10 },
      },
    ],
  };
  return {
    command: 'inspect',
    operationRole: 'behavior',
    evidence: { strength: 'exact' },
    args: ['--at', 'src/example.ts:10', '--view', 'behavior'],
    coverage: { complete: true, returned: 1 },
    result: {
      view: 'behavior',
      locations: [{ file: 'src/example.ts', line: 10 }],
      searches: [],
      slices: [{ relativePath: 'src/example.ts', startLine: 1, endLine: 400, focusLine: 10, source }],
      units: [
        {
          kind: 'source',
          relativePath: 'src/example.ts',
          startLine: 1,
          endLine: 400,
          focusLine: 10,
          source,
          unitType: 'function',
          unitStartLine: 1,
          unitEndLine: 400,
          omittedLines: 0,
          reasons: ['exact-selector'],
          focusLines: [10],
          ownerSymbol: 'example/run',
          ownerShort: 'run',
          roles: ['exact'],
          symbols: ['example/run'],
          id: 'unit-1',
          omittedCharacters: 0,
          behavior: {
            callable: { kind: 'function' },
            representation: 'outline',
            constructKind: 'function',
            signature: 'function run()',
            lines: Array.from({ length: 400 }, (_, index) => ({ line: index + 1, text: 'const observed = true;' })),
            signals: ['branch'],
            testCases: [],
            coverage: { complete: true },
            rawCharacters: source.length,
            outlineCharacters: 1_000,
            candidateLines: 400,
            omittedLines: 0,
          },
        },
      ],
      bindingClosure: { state: 'complete' },
      packetCoverage: { mode: 'complete', candidateUnits: 1, returnedUnits: 1, omittedUnits: 0 },
      omissionGroups: [],
      continuation: null,
      causalFrontier: {
        anchors: [anchor],
        withheldAnchors: [anchor],
        candidateAnchors: 2,
        omittedAnchors: 1,
        scannedBehaviorSteps: 1,
        visibleCallsites: 1,
        graphEvidencedCallsites: 1,
        identityCandidateCallsites: 0,
        ambiguousCallsites: 0,
        unresolvedCallsites: 0,
        upstreamCandidates: 0,
        resultCandidates: 1,
        runtimeCandidates: 0,
        inspectCommand: "scip-query inspect --at 'src/example.ts:10' --view behavior",
        remainingInspectCommands: ["scip-query inspect --at 'src/example.ts:20' --view behavior"],
      },
      stoppingSummary: { terminal: true },
    },
    evidenceContext: evidenceContext('2026-08-23T10:00:00.000Z', 'generation-1'),
  };
}

function evidenceContext(observedAt: string, generation: string) {
  return {
    operationRole: 'observation',
    analysisManifest: { providers: ['text'] },
    receipt: {
      schemaVersion: 2,
      observedAt,
      facts: { index: { generation } },
      observedSources: [{ kind: 'working-tree' }],
      stabilityProofs: [{ kind: 'generation', value: generation }],
    },
  };
}

function searchIdentity(relativePath: string, focusLine: number, ownerSymbol: string, start: number, end: number) {
  return {
    relativePath,
    focusLine,
    ownerSymbol,
    ownerShort: ownerSymbol.split('/').at(-1),
    ownerStartLine: start,
    ownerEndLine: end,
    fileKind: 'source',
    freshness: 'current',
  };
}
