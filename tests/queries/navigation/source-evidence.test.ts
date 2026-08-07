import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ScipQueryConfig } from '../../../src/domain/types.js';
import { code } from '../../../src/queries/navigation/code.js';
import { evidence } from '../../../src/queries/navigation/evidence.js';
import { inspectSource } from '../../../src/queries/navigation/source-inspection.js';
import { searchSource } from '../../../src/queries/navigation/source-search.js';
import { referenceSourceSnippet } from '../../../src/queries/navigation/source-snippet.js';
import { qualifiedTraceEvidence } from '../../../src/queries/navigation/trace.js';
import {
  writeRuntimeBoundaryGraph,
  type BoundaryEvidenceStrength,
  type BoundaryObservation,
} from '../../../src/queries/internal/runtime-boundary-evidence.js';
import {
  behaviorControlAnalysis,
  behaviorReceipt,
  behaviorReceipts,
  behaviorSkeleton,
} from '../../../src/source/facts/behavior-skeleton.js';
import { ScipDatabase } from '../../../src/storage/db.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../../fixtures/evidence-fixture.js';

describe('related source evidence', () => {
  let tempDir: string | null = null;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it('shows definition source and source centered on real reference sites', () => {
    const db = createSourceEvidenceDb();
    try {
      const traced = qualifiedTraceEvidence(db, 'appendThing', { referenceContext: 1 });

      expect(traced.definitions[0]?.source).toContain('export function appendThing');
      expect(traced.referencedBy).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            relativePath: 'src/consumer.ts',
            line: 4,
            enclosingShort: 'src:consumer:run()',
            sourceStartLine: 4,
            sourceEndLine: 9,
            source: expect.stringContaining('outerTx'),
          }),
        ]),
      );
      expect(traced.referenceEvidence).toContainEqual(
        expect.objectContaining({
          relativePath: 'src/consumer.ts',
          line: 4,
          sourceKind: 'complete-call-expression',
        }),
      );
      expect(traced.claimSupport?.callsitePredicates.status).toBe('eligible');
    } finally {
      db.close();
    }
  });

  it('combines overlapping invocation windows without losing reference identities', () => {
    const db = createSourceEvidenceDb();
    try {
      const result = evidence(db, 'appendThing', { referenceContext: 2 });

      expect(result.kind).toBe('matched');
      if (result.kind !== 'matched') return;
      expect(result.definition?.source).toContain('return value.trim()');
      const consumer = result.referenceWindows.find((window) =>
        window.references.some((reference) => reference.line === 4),
      );
      expect(consumer?.references.map((reference) => reference.line)).toEqual(expect.arrayContaining([4, 10]));
      expect(consumer?.source).toContain("'one'");
      expect(consumer?.source).toContain('outerTx');
      expect(consumer?.source).toContain("appendThing('two')");
    } finally {
      db.close();
    }
  });

  it('projects runtime facts into behavior packets and suppresses a superseded unmounted candidate', () => {
    const db = createSourceEvidenceDb();
    try {
      writeRuntimeBoundaryGraph(db.config.dbPath, {
        schemaVersion: 2,
        extractorVersion: 'test',
        observations: [
          runtimeObservation('request', 'http.request', 'producer', '/api/events', 'exact', 'http.request'),
          runtimeObservation('candidate', 'http.handle', 'consumer', '/mounted', 'candidate', 'http.route'),
          runtimeObservation('mounted', 'http.handle', 'consumer', '/api/mounted', 'derived', 'http.mount-prefix'),
        ],
        relationGroups: [],
        links: [],
        frontiers: [],
        coverage: {
          filesScanned: 1,
          filesWithAst: 1,
          filesWithoutAst: 0,
          extractors: [],
          extractionErrors: [],
        },
      });

      const packet = inspectSource(db, { locations: ['src/api.ts:1'], view: 'behavior' });
      const facts = packet.units?.filter((unit) => unit.kind === 'source').flatMap((unit) => unit.runtimeFacts ?? []);
      expect(facts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: 'http.request',
            role: 'producer',
            keyParts: expect.arrayContaining([expect.objectContaining({ name: 'path', value: '/api/events' })]),
          }),
          expect.objectContaining({
            action: 'http.handle',
            strength: 'derived',
            keyParts: expect.arrayContaining([expect.objectContaining({ name: 'path', value: '/api/mounted' })]),
          }),
        ]),
      );
      expect(
        facts?.some(
          (fact) =>
            fact.strength === 'candidate' &&
            fact.keyParts.some((part) => part.name === 'path' && part.value === '/mounted'),
        ),
      ).toBe(false);
    } finally {
      db.close();
    }
  });

  it('searches indexed source and reports the owning symbol and omitted matches', () => {
    const db = createSourceEvidenceDb();
    try {
      const result = searchSource(db, 'appendThing', { context: 0, limit: 2 });

      expect(result.mode).toBe('literal');
      expect(result.matchingLines).toBeGreaterThan(2);
      expect(result.identities).toHaveLength(result.matchingLines);
      expect(result.matches).toHaveLength(2);
      expect(result.omittedMatches).toBe(result.matchingLines - 2);
      expect(result.fileCoverage!.reduce((total, file) => total + file.matchingLines, 0)).toBe(result.matchingLines);
      expect(result.fileCoverage!.reduce((total, file) => total + file.returnedMatches, 0)).toBe(result.matches.length);
      expect(result.matches[0]).toMatchObject({
        relativePath: 'src/api.ts',
        focusLine: 0,
        ownerShort: 'src:api:appendThing()',
      });
      expect(result.identities).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ relativePath: 'src/api.ts', focusLine: 0, fileKind: 'source' }),
          expect.objectContaining({ relativePath: 'src/consumer.ts', ownerShort: 'src:consumer:run()' }),
        ]),
      );
    } finally {
      db.close();
    }
  });

  it('ranks production source ahead of barrel and test matches while preserving every identity', () => {
    const db = createSourceEvidenceDb();
    try {
      const result = searchSource(db, 'tierAnchor', { context: 0, limit: 3, ranking: 'structural' });

      expect(result.identities).toHaveLength(4);
      expect(result.matches.slice(0, 2).every((match) => match.fileKind === 'source')).toBe(true);
      expect(new Set(result.matches.slice(0, 2).map((match) => match.relativePath))).toEqual(
        new Set(['src/tier-a.ts', 'src/tier-b.ts']),
      );
      expect(result.matches[2]).toMatchObject({ relativePath: 'src/lib/index.ts', fileKind: 'barrel' });
      expect(result.identities).toContainEqual(
        expect.objectContaining({ relativePath: 'src/diverse.test.ts', fileKind: 'test' }),
      );
      expect(result.omittedMatches).toBe(1);
    } finally {
      db.close();
    }
  });

  it('refuses to present one ambiguous definition as the evidence answer', () => {
    const db = createSourceEvidenceDb(true);
    try {
      const result = evidence(db, 'appendThing');

      expect(result).toMatchObject({
        kind: 'ambiguous',
        total: 2,
        candidates: expect.arrayContaining([
          expect.objectContaining({ relativePath: 'src/api.ts' }),
          expect.objectContaining({ relativePath: 'src/other-api.ts' }),
        ]),
      });

      const packet = inspectSource(db, { symbols: ['appendThing'] });
      expect(packet.evidence[0]?.kind).toBe('ambiguous');
      expect(packet.packetCoverage?.exactSelectorsComplete).toBe(false);
      expect(packet.stoppingSummary?.queryStatus).toBe('coverage-incomplete');
    } finally {
      db.close();
    }
  });

  it('recovers nested behavior when the compiler range only covers an object declaration line', () => {
    const db = createSourceEvidenceDb();
    try {
      const source = code(db, 'commandSet');
      expect(source?.source).toContain('async sessionStreamEvents');
      expect(source?.source).toContain('return events.length');

      const packet = inspectSource(db, {
        searches: ['sessionStreamEvents', 'return events.length', 'appendThing'],
        searchLimit: 2,
      });
      expect(packet.searches).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ pattern: 'sessionStreamEvents', matchingLines: 1 }),
          expect.objectContaining({ pattern: 'return events.length', matchingLines: 1 }),
          expect.objectContaining({ pattern: 'appendThing' }),
        ]),
      );
      expect(packet.slices).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            relativePath: 'src/commands.ts',
            unitType: 'method_definition',
            reasons: ['search:sessionStreamEvents', 'search:return events.length'],
            source: expect.stringContaining('return events.length'),
          }),
        ]),
      );
    } finally {
      db.close();
    }
  });

  it('returns one complete source unit for distant selected lines in the same function', () => {
    const db = createSourceEvidenceDb();
    try {
      const packet = inspectSource(db, {
        searches: ['firstAnchor', 'lastAnchor'],
        searchLimit: 2,
        unitLines: 8,
      });
      const slices = packet.slices.filter((slice) => slice.relativePath === 'src/long-command.ts');

      expect(slices).toHaveLength(1);
      expect(slices[0]?.source).toContain('firstAnchor');
      expect(slices[0]?.source).toContain('lastAnchor');
      expect(slices[0]?.omittedLines).toBe(0);
    } finally {
      db.close();
    }
  });

  it('deduplicates search and symbol evidence in one complete semantic packet', () => {
    const db = createSourceEvidenceDb();
    try {
      const packet = inspectSource(db, {
        searches: ['export function appendThing'],
        symbols: ['appendThing'],
        evidence: { parts: ['definition', 'references'] },
      });
      const definition = packet.units!.filter((unit) => unit.kind === 'source' && unit.relativePath === 'src/api.ts');

      expect(definition).toHaveLength(1);
      expect(definition[0]).toMatchObject({
        kind: 'source',
        roles: expect.arrayContaining(['search', 'definition']),
        source: expect.stringContaining('return value.trim()'),
      });
      expect(packet.returnedLines).toBe(packet.maxTotalLines);
      expect(packet.returnedCharacters).toBeLessThanOrEqual(packet.maxCharacters!);
      expect(packet.omittedUnits).toBe(0);
      expect(packet.packetCoverage).toMatchObject({ mode: 'complete', exactSelectorsComplete: true });
      expect(packet.stoppingSummary).toMatchObject({
        queryStatus: 'selection-complete',
        status: 'stop-ready',
        openEvidence: 0,
      });
      expect(packet.continuation).toBeNull();
    } finally {
      db.close();
    }
  });

  it('budgets causal and test evidence independently without hiding the omitted channel', () => {
    const db = createSourceEvidenceDb();
    try {
      const defaultPacket = inspectSource(db, { symbols: ['appendThing'] });

      expect(defaultPacket.units).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'source', roles: expect.arrayContaining(['definition']) }),
          expect.objectContaining({ kind: 'source', roles: expect.arrayContaining(['caller']) }),
        ]),
      );
      expect(defaultPacket.units?.some((unit) => unit.roles.includes('reference'))).toBe(false);
      expect(defaultPacket.packetCoverage?.channels?.['test-reference']).toMatchObject({
        candidateUnits: 0,
        returnedUnits: 0,
      });

      const references = inspectSource(db, {
        symbols: ['appendThing'],
        evidence: { parts: ['definition', 'references'] },
        evidenceBudgets: {
          'production-reference': 1,
          'test-reference': 0,
        },
      });

      expect(references.units?.some((unit) => unit.relativePath === 'src/consumer.ts')).toBe(true);
      expect(references.units?.some((unit) => unit.relativePath === 'src/api.test.ts')).toBe(false);
      expect(references.packetCoverage?.channels?.['production-reference']).toMatchObject({
        candidateUnits: 2,
        returnedUnits: 1,
        omittedUnits: 1,
        maxUnits: 1,
      });
      expect(references.packetCoverage?.channels?.['test-reference']).toMatchObject({
        candidateUnits: 1,
        returnedUnits: 0,
        omittedUnits: 1,
        maxUnits: 0,
      });
      expect(references.packetCoverage?.exactSelectorsComplete).toBe(true);
      expect(references.stoppingSummary?.queryStatus).toBe('frontier-accounted');
      expect(references.omissionGroups).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ channel: 'production-reference', roles: ['reference'], candidateUnits: 1 }),
          expect.objectContaining({ channel: 'test-reference', roles: ['reference'], candidateUnits: 1 }),
        ]),
      );
    } finally {
      db.close();
    }
  });

  it('ignores legacy line and slice budgets while retaining complete returned syntax units', () => {
    const db = createSourceEvidenceDb();
    try {
      const packet = inspectSource(db, {
        searches: ['firstAnchor', 'export function appendThing'],
        unitLines: 8,
        sliceLimit: 1,
        totalLines: 1,
      });

      expect(packet.units).toHaveLength(2);
      expect(packet.units).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'source', relativePath: 'src/api.ts' }),
          expect.objectContaining({ kind: 'source', relativePath: 'src/long-command.ts' }),
        ]),
      );
      expect(packet.returnedLines).toBeGreaterThan(1);
      expect(packet.omittedUnits).toBe(0);
      expect(packet.continuation).toBeNull();
    } finally {
      db.close();
    }
  });

  it('bounds broad searches with explicit coverage and expands them deliberately with full', () => {
    const db = createSourceEvidenceDb();
    try {
      const packet = inspectSource(db, {
        searches: ['filler'],
        unitLines: 8,
      });
      const sourceUnits = packet.units!.filter((unit) => unit.kind === 'source');

      expect(packet.searches[0]).toMatchObject({
        matchingLines: 21,
        returnedMatches: 12,
        omittedMatches: 9,
        matchingFiles: 2,
        returnedFiles: 1,
        omittedFiles: 1,
        candidateUnits: 12,
        selectedUnits: 12,
        omittedUnits: 0,
        exactFollowup: "scip-query inspect --search 'filler' --full",
      });
      expect(packet.searches[0]?.scopeHints).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            scope: 'src',
            matchingLines: 20,
            returnedMatches: 12,
            exactFollowup: "scip-query inspect --search 'filler' --scope 'src' --full",
          }),
          expect.objectContaining({
            scope: 'src/__tests__',
            matchingLines: 1,
            returnedMatches: 0,
          }),
        ]),
      );
      expect(sourceUnits).toHaveLength(12);
      expect(sourceUnits.every((unit) => unit.omittedCharacters === 0 && unit.omittedLines === 0)).toBe(true);
      expect(sourceUnits.some((unit) => unit.source.includes('filler19'))).toBe(false);
      expect(sourceUnits.some((unit) => unit.relativePath.includes('__tests__'))).toBe(false);
      expect(packet.packetCoverage).toMatchObject({
        mode: 'bounded',
        candidateUnits: 12,
        returnedUnits: 12,
        omittedUnits: 0,
        exactSelectorsComplete: true,
        expansionCommand: "scip-query inspect --search 'filler' --full",
      });
      expect(packet.stoppingSummary).toMatchObject({
        queryStatus: 'frontier-accounted',
        status: 'relevance-check-required',
        openEvidence: expect.any(Number),
      });
      expect(packet.stoppingSummary?.drillCommands).toContain("scip-query inspect --search 'filler' --full");

      const expanded = inspectSource(db, { searches: ['filler'], full: true });
      const expandedUnits = expanded.units!.filter((unit) => unit.kind === 'source');
      expect(expanded.searches[0]).toMatchObject({ matchingLines: 21, returnedMatches: 21, omittedMatches: 0 });
      expect(expandedUnits).toHaveLength(21);
      expect(expandedUnits.some((unit) => unit.source.includes('filler19'))).toBe(true);
      expect(expanded.packetCoverage).toMatchObject({ mode: 'complete', omittedUnits: 0 });
      expect(expanded.packetCoverage?.expansionCommand).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('ranks exact locations ahead of broad search units and reports packet omissions by role', () => {
    const db = createSourceEvidenceDb();
    try {
      const packet = inspectSource(db, {
        searches: ['filler'],
        locations: ['src/api.ts:1'],
        searchLimit: 20,
        maxUnits: 3,
      });

      expect(packet.units).toHaveLength(3);
      expect(packet.units?.[0]).toMatchObject({ kind: 'source', relativePath: 'src/api.ts', roles: ['location'] });
      expect(packet.packetCoverage).toMatchObject({
        mode: 'bounded',
        candidateUnits: 21,
        returnedUnits: 3,
        omittedUnits: 18,
        omittedByRole: { search: 18 },
        exactSelectorsComplete: true,
        expansionCommand: "scip-query inspect --search 'filler' --at 'src/api.ts:1' --full",
      });
      expect(packet.searches[0]).toMatchObject({ candidateUnits: 20, selectedUnits: 2, omittedUnits: 18 });
    } finally {
      db.close();
    }
  });

  it('keeps an oversized highest-ranked syntax unit whole under the soft character ceiling', () => {
    const db = createSourceEvidenceDb();
    try {
      const packet = inspectSource(db, {
        locations: ['src/long-command.ts:1', 'src/api.ts:1'],
        maxCharacters: 40,
      });

      expect(packet.units).toHaveLength(1);
      expect(packet.returnedCharacters).toBeGreaterThan(40);
      expect(packet.units?.[0]).toMatchObject({ kind: 'source', relativePath: 'src/long-command.ts' });
      expect(packet.packetCoverage).toMatchObject({
        mode: 'bounded',
        omittedUnits: 1,
        exactSelectorsComplete: false,
      });
      expect(packet.stoppingSummary).toMatchObject({
        queryStatus: 'coverage-incomplete',
        status: 'exact-evidence-withheld',
      });
    } finally {
      db.close();
    }
  });

  it('withholds an oversized behavior unit before rendering while returning a smaller requested unit', () => {
    const db = createSourceEvidenceDb();
    try {
      const packet = inspectSource(db, {
        locations: ['src/long-command.ts:1', 'src/api.ts:1'],
        maxCharacters: 120,
        view: 'behavior',
      });

      expect(packet.units).toHaveLength(1);
      expect(packet.units?.[0]).toMatchObject({ kind: 'source', relativePath: 'src/api.ts' });
      expect(packet.returnedViewCharacters).toBeLessThanOrEqual(120);
      expect(packet.packetCoverage).toMatchObject({
        mode: 'bounded',
        omittedUnits: 1,
        exactSelectorsComplete: false,
      });
      expect(packet.omissionGroups).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            anchors: expect.arrayContaining([expect.objectContaining({ relativePath: 'src/long-command.ts' })]),
          }),
        ]),
      );
    } finally {
      db.close();
    }
  });

  it('returns raw source when a compact function is cheaper than a behavioral outline', () => {
    const db = createSourceEvidenceDb();
    try {
      const packet = inspectSource(db, {
        locations: ['src/behavior.ts:1', 'src/behavior.test.ts:2'],
        view: 'behavior',
      });
      const behaviorUnit = packet.units?.find(
        (unit) => unit.kind === 'source' && unit.relativePath === 'src/behavior.ts',
      );
      const testUnit = packet.units?.find(
        (unit) => unit.kind === 'source' && unit.relativePath === 'src/behavior.test.ts',
      );

      expect(behaviorUnit).toMatchObject({
        kind: 'source',
        source: expect.stringContaining('...customHeaders'),
        behavior: undefined,
      });
      expect(testUnit).toMatchObject({
        kind: 'source',
        behavior: undefined,
      });
      expect(packet.view).toBe('behavior');
      expect(packet.returnedViewCharacters).toBeGreaterThan(0);
      expect(packet.returnedViewCharacters).toBe(packet.returnedCharacters);
    } finally {
      db.close();
    }
  });

  it('selects rare behavior combinations as a bounded second encoding of a large source unit', () => {
    const db = createSourceEvidenceDb();
    try {
      const receipt = behaviorReceipt(db, 'src/receipt.ts', 2, 27, { maxLines: 5 });

      expect(receipt).toMatchObject({
        owner: 'receipt',
        candidateLines: expect.any(Number),
        omittedLines: expect.any(Number),
        signalCounts: expect.objectContaining({ await: 1, catch: 1, mutation: 1, shape: 8 }),
      });
      expect(receipt?.lines).toHaveLength(3);
      expect(receipt?.lines.map((line) => line.text)).toEqual(
        expect.arrayContaining([
          'await Promise.allSettled(items.map((item) => send(item, payload)));',
          '} catch (error) {',
          'state.lastTriggeredAt = new Date();',
        ]),
      );
      expect(receipt?.shapes.flatMap((shape) => shape.fields.map((field) => field.name))).toContain('timestamp');
    } finally {
      db.close();
    }
  });

  it('does not add a receipt when the exact source unit is already compact', () => {
    const db = createSourceEvidenceDb();
    try {
      expect(behaviorReceipt(db, 'src/behavior.ts', 0, 14)).toBeNull();
      expect(behaviorReceipts(db, 'src/behavior.ts', 0, 14)).toEqual([
        expect.objectContaining({
          lines: expect.arrayContaining([expect.objectContaining({ signals: expect.arrayContaining(['catch']) })]),
        }),
      ]);
    } finally {
      db.close();
    }
  });

  it('retains a complete lifecycle registration rather than only its first source line', () => {
    const db = createSourceEvidenceDb();
    try {
      const receipts = behaviorReceipts(db, 'src/lifecycle.ts', 0, 5);

      expect(receipts).toEqual([
        expect.objectContaining({
          lines: [
            expect.objectContaining({
              signals: expect.arrayContaining(['lifecycle']),
              text: 'useEffect(() => { void loadDeliveries(); }, [loadDeliveries])',
            }),
          ],
        }),
      ]);
    } finally {
      db.close();
    }
  });

  it('adds literal project values without opening traversal obligations', () => {
    const db = createSourceEvidenceDb();
    try {
      const source = code(db, 'loadEvents');

      expect(source?.bindingClosure?.inline).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'SESSION_EVENTS_INITIAL_LIMIT', source: expect.stringContaining('250') }),
          expect.objectContaining({ name: 'LOAD_MORE_INCREMENT', source: expect.stringContaining('250') }),
          expect.objectContaining({ name: 'SERVER_MAX_LIMIT', source: expect.stringContaining('500') }),
          expect.objectContaining({ name: 'REALTIME_FALLBACK_POLL_MS', source: expect.stringContaining('15_000') }),
        ]),
      );
      expect(source?.bindingClosure).not.toHaveProperty('deferred');
      expect(source?.bindingClosure).not.toHaveProperty('unresolved');
      expect(source?.bindingClosure).not.toHaveProperty('recoveryCommands');

      const packet = inspectSource(db, { locations: ['src/bindings.ts:10'], view: 'behavior' });
      expect(packet.bindingClosure?.inline.map((binding) => binding.name)).toEqual(
        expect.arrayContaining([
          'SESSION_EVENTS_INITIAL_LIMIT',
          'LOAD_MORE_INCREMENT',
          'SERVER_MAX_LIMIT',
          'REALTIME_FALLBACK_POLL_MS',
        ]),
      );
      expect(packet.stoppingSummary).toMatchObject({
        queryStatus: 'selection-complete',
        status: 'stop-ready',
        openEvidence: 0,
      });
      expect(packet.stoppingSummary?.drillCommands).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('follows a barrel re-export to a literal definition', () => {
    const db = createSourceEvidenceDb();
    try {
      const source = code(db, 'readTerminalLimit');

      expect(source?.bindingClosure?.inline).toContainEqual(
        expect.objectContaining({
          name: 'TERMINAL_LIMIT',
          relativePath: 'src/terminal.ts',
          source: expect.stringContaining('42'),
        }),
      );
    } finally {
      db.close();
    }
  });

  it('keeps complete raw source when a branch-dense function cannot be compressed safely', () => {
    const db = createSourceEvidenceDb();
    try {
      const packet = inspectSource(db, { locations: ['src/anchor-heavy.ts:27'], view: 'behavior' });
      const unit = packet.units?.find(
        (candidate) => candidate.kind === 'source' && candidate.relativePath === 'src/anchor-heavy.ts',
      );

      expect(unit).toMatchObject({ kind: 'source', behavior: undefined });
      if (!unit || unit.kind !== 'source') return;
      expect(unit.source).toContain('if (value === 26) return 26;');
      expect(unit.source).toContain('if (value === 31) return 31;');
    } finally {
      db.close();
    }
  });

  it('uses a complete hierarchical outline only when it is cheaper than rendered raw source', () => {
    const db = createSourceEvidenceDb();
    try {
      const outline = behaviorSkeleton(db, 'src/outline.ts', 0, 19, [13]);

      expect(outline).toMatchObject({
        representation: 'outline',
        constructKind: 'module function',
        coverage: {
          sourceStatements: expect.any(Number),
          representedStatements: expect.any(Number),
          copiedStatements: 0,
          omittedStatements: 0,
        },
        omittedLines: 0,
      });
      expect(outline?.outlineCharacters).toBeLessThan(outline?.rawCharacters ?? 0);
      expect(outline?.lines.map((line) => line.text)).toEqual(
        expect.arrayContaining([
          'if normalized.length === 0',
          'return [];',
          'for (const item of normalized)',
          'results.push(await send(item));',
          'catch (error)',
          'throw error;',
          'return results;',
        ]),
      );
      expect(outline?.lines.find((line) => line.line <= 13 && line.endLine >= 13)?.signals).toContain('anchor');
    } finally {
      db.close();
    }
  });

  it('accounts for nested control flow and copies compression-sensitive statements verbatim', () => {
    const db = createSourceEvidenceDb();
    try {
      const outline = behaviorSkeleton(db, 'src/outline-sensitive.ts', 0, 22, [13]);

      expect(outline).toMatchObject({
        representation: 'outline',
        constructKind: 'module function',
        coverage: {
          sourceStatements: expect.any(Number),
          representedStatements: expect.any(Number),
          copiedStatements: 1,
          omittedStatements: 0,
        },
      });
      expect(outline?.coverage.representedStatements).toBe(outline?.coverage.sourceStatements);
      expect(outline?.lines).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ text: 'for (const record of records)', depth: 0, copied: false }),
          expect.objectContaining({ text: 'if record.disabled', depth: 1, copied: false }),
          expect.objectContaining({ text: 'continue;', depth: 2, copied: false }),
          expect.objectContaining({ text: expect.stringContaining('sql`'), copied: true }),
          expect.objectContaining({ text: 'finally', depth: 1, copied: false }),
        ]),
      );
      expect(outline?.lines.find((line) => line.line <= 13 && line.endLine >= 13)?.signals).toContain('anchor');
    } finally {
      db.close();
    }
  });

  it('derives sibling, loop, exception, cleanup, and terminal control facts from the behavior AST', () => {
    const db = createSourceEvidenceDb();
    try {
      const analysis = behaviorControlAnalysis(db, 'src/outline-sensitive.ts', 0, 22);
      const subtypes = analysis?.facts.map((fact) => fact.subtype) ?? [];

      expect(subtypes).toEqual(
        expect.arrayContaining([
          'predicate-consequence',
          'predicate-fallthrough',
          'loop-iteration',
          'loop-exit',
          'exception-handler',
          'finally-cleanup',
          'handler-throw',
        ]),
      );
      expect(analysis?.terminals.map((terminal) => terminal.label)).toEqual(
        expect.arrayContaining(['throw error;', 'return saved;']),
      );
      expect(analysis?.unsupported).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('preserves predicates, mutation targets, boundary arguments, regexes, and error values', () => {
    const db = createSourceEvidenceDb();
    try {
      const outline = behaviorSkeleton(db, 'src/outline-fidelity.ts', 0, 13);
      const text = outline?.lines.map((line) => line.text) ?? [];

      expect(outline).toMatchObject({
        representation: 'outline',
        coverage: { omittedStatements: 0 },
      });
      expect(text).toEqual(
        expect.arrayContaining([
          'if token && /a\\s+b/.test(token)',
          'state.count += 1;',
          "await fetch(endpoint, { method: 'POST', body: JSON.stringify({ token }), });",
          'if !token',
          'throw new Error("token is required");',
          'return state.count;',
        ]),
      );
    } finally {
      db.close();
    }
  });

  it('narrows one focused registry handler without including sibling handlers', () => {
    const db = createSourceEvidenceDb();
    try {
      const packet = inspectSource(db, { locations: ['src/registry-table.ts:3'], view: 'behavior' });
      const unit = packet.units?.find(
        (candidate) => candidate.kind === 'source' && candidate.relativePath === 'src/registry-table.ts',
      );

      expect(unit).toMatchObject({ kind: 'source', startLine: 2, endLine: 7 });
      if (!unit || unit.kind !== 'source') return;
      expect(unit.source).toContain('target: async');
      expect(unit.source).not.toContain('alpha:');
      expect(unit.source).not.toContain('omega:');
    } finally {
      db.close();
    }
  });

  it('narrows an interior behavior location to its governing control-flow construct', () => {
    const db = createSourceEvidenceDb();
    try {
      const packet = inspectSource(db, { locations: ['src/nested-focus.ts:4'], view: 'behavior' });
      const unit = packet.units?.find(
        (candidate) => candidate.kind === 'source' && candidate.relativePath === 'src/nested-focus.ts',
      );

      expect(unit).toMatchObject({ kind: 'source', startLine: 2, endLine: 6 });
      if (!unit || unit.kind !== 'source') return;
      expect(unit.source).toContain('for (const item of items)');
      expect(unit.source).toContain('result.push(item);');
      expect(unit.source).not.toContain('const result: number[] = [];');
      expect(unit.source).not.toContain('return result;');
    } finally {
      db.close();
    }
  });

  it('identifies owning construct kind and retains raw source when normalization cannot save tokens', () => {
    const db = createSourceEvidenceDb();
    try {
      const method = behaviorSkeleton(db, 'src/class-outline.ts', 5, 18);

      expect(method).toMatchObject({
        constructKind: 'class method',
        signature: expect.stringContaining('async execute'),
        coverage: { omittedStatements: 0 },
      });
      expect(behaviorSkeleton(db, 'src/api.ts', 0, 2)).toBeNull();
    } finally {
      db.close();
    }
  });

  it('retains readable raw source when one compressed statement would be too dense', () => {
    const db = createSourceEvidenceDb();
    try {
      expect(behaviorSkeleton(db, 'src/outline-dense.ts', 0, 18)).toBeNull();
    } finally {
      db.close();
    }
  });

  it('prefers marginal file coverage and exposes recoverable omission groups', () => {
    const db = createSourceEvidenceDb();
    try {
      const packet = inspectSource(db, {
        searches: ['sharedAnchor'],
        searchLimit: 10,
        maxUnits: 2,
        view: 'behavior',
      });
      const selectedPaths = packet.units?.map((unit) => unit.relativePath) ?? [];

      expect(selectedPaths).toEqual(expect.arrayContaining(['src/diverse-a.ts', 'src/diverse-b.ts']));
      expect(packet.omissionGroups).not.toHaveLength(0);
      expect(packet.omissionGroups).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            scope: 'src',
            roles: ['search'],
            candidateUnits: expect.any(Number),
            drillCommand: expect.stringContaining('--view behavior'),
          }),
        ]),
      );
      expect(packet.omissionGroups?.every((group) => group.drillCommand.startsWith('scip-query inspect'))).toBe(true);
    } finally {
      db.close();
    }
  });

  it('rejects legacy semantic packet cursors', () => {
    const db = createSourceEvidenceDb();
    try {
      expect(() => inspectSource(db, { cursor: 'legacy-cursor' })).toThrow(
        /no longer accepts semantic packet cursors/u,
      );
    } finally {
      db.close();
    }
  });

  it('includes source at a compiler-resolved consumer edge', () => {
    const db = createSourceEvidenceDb();
    try {
      const packet = inspectSource(db, {
        symbols: ['appendThing'],
        evidence: { parts: ['consumers'] },
      });
      const consumer = packet.units!.find((unit) => unit.roles.includes('consumer'));

      expect(consumer).toMatchObject({
        kind: 'source',
        relativePath: 'src/consumer.ts',
        source: expect.stringContaining("import { appendThing } from './api.js'"),
      });
    } finally {
      db.close();
    }
  });

  it('keeps complete multiline call expressions across TypeScript, Python, and Rust', () => {
    const db = createSourceEvidenceDb();
    try {
      expect(referenceSourceSnippet(db, 'src/consumer.ts', 4, 0, 'appendThing')).toMatchObject({
        kind: 'complete-call-expression',
        startLine: 4,
        endLine: 9,
        source: expect.stringContaining('outerTx'),
      });
      expect(referenceSourceSnippet(db, 'src/python-consumer.py', 1, 0, 'deliver')).toMatchObject({
        kind: 'complete-call-expression',
        startLine: 1,
        endLine: 6,
        source: expect.stringContaining('transaction'),
      });
      expect(referenceSourceSnippet(db, 'src/rust-consumer.rs', 1, 0, 'deliver')).toMatchObject({
        kind: 'complete-call-expression',
        startLine: 1,
        endLine: 6,
        source: expect.stringContaining('&transaction'),
      });
      expect(referenceSourceSnippet(db, 'src/ambiguous-calls.ts', 0, 0, 'deliver')).toMatchObject({
        kind: 'bounded-context',
      });
      expect(referenceSourceSnippet(db, 'notes/unparsed-call.txt', 0, 0, 'deliver')).toMatchObject({
        kind: 'bounded-context',
      });
    } finally {
      db.close();
    }
  });

  it('refuses callsite predicates when any reference lacks one complete invocation', () => {
    const db = createSourceEvidenceDb();
    try {
      const traced = qualifiedTraceEvidence(db, 'deliver', { referenceContext: 0 });

      expect(traced.referenceEvidence).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ relativePath: 'src/python-consumer.py', sourceKind: 'complete-call-expression' }),
          expect.objectContaining({ relativePath: 'src/rust-consumer.rs', sourceKind: 'complete-call-expression' }),
          expect.objectContaining({ relativePath: 'src/ambiguous-calls.ts', sourceKind: 'bounded-context' }),
        ]),
      );
      expect(traced.claimSupport?.callsitePredicates).toMatchObject({
        status: 'ineligible',
        reason: expect.stringContaining('lack one unambiguous complete call expression'),
        followup: expect.stringContaining("--at 'src/ambiguous-calls.ts:1'"),
      });
    } finally {
      db.close();
    }
  });

  function runtimeObservation(
    id: string,
    action: string,
    role: string,
    path: string,
    strength: BoundaryEvidenceStrength,
    rule: string,
  ): BoundaryObservation {
    return {
      id,
      extractor: 'test',
      action,
      owner: {
        file: 'src/api.ts',
        symbol: 'src:api:appendThing()',
        name: 'appendThing',
        startLine: 1,
        endLine: 3,
      },
      source: { file: 'src/api.ts', startLine: 1, endLine: 1 },
      keyParts: [
        { name: 'method', value: 'POST', evidence: 'literal' },
        { name: 'path', value: path, evidence: 'literal' },
      ],
      evidence: `${action} ${path}`,
      strength,
      protocol: 'http',
      role,
      executionDomain: 'test',
      derivation: {
        kind: strength === 'exact' ? 'direct' : strength === 'derived' ? 'mechanically-derived' : 'heuristic',
        rule,
        ruleVersion: 'test',
        inputFactIds: [],
        sourceSpans: [{ file: 'src/api.ts', startLine: 1, endLine: 1 }],
      },
      valuePrecision: 'literal',
      modality: 'may',
      resolution: 'unresolved',
      sourceScope: 'production',
    };
  }

  function createSourceEvidenceDb(ambiguous = false): ScipDatabase {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-source-evidence-'));
    writeFixtureFiles(tempDir, {
      'src/api.ts': ['export function appendThing(value: string) {', '  return value.trim();', '}'],
      'src/consumer.ts': [
        "import { appendThing } from './api.js';",
        '',
        'export function run(outerTx: unknown) {',
        '  const values = [',
        '    appendThing(',
        "      'one',",
        '      undefined,',
        '      undefined,',
        '      outerTx,',
        '    ),',
        "    appendThing('two'),",
        '  ];',
        '  return values;',
        '}',
      ],
      'src/api.test.ts': [
        "import { appendThing } from './api.js';",
        "export function testAppendThing() { return appendThing('test'); }",
      ],
      'src/python-consumer.py': [
        'def run(transaction):',
        '    return deliver(',
        "        'event',",
        '        None,',
        '        None,',
        '        transaction,',
        '    )',
      ],
      'src/rust-consumer.rs': [
        'fn run(transaction: Transaction) {',
        '    deliver(',
        '        event,',
        '        None,',
        '        None,',
        '        &transaction,',
        '    );',
        '}',
      ],
      'src/ambiguous-calls.ts': ["export const values = [deliver('one'), deliver('two')];"],
      'notes/unparsed-call.txt': ['deliver(', "  'event',", '  transaction,', ')'],
      'src/commands.ts': [
        'export const commandSet = {',
        '  async sessionStreamEvents(input: string) {',
        '    const events = JSON.parse(input);',
        '    return events.length;',
        '  },',
        '};',
      ],
      'src/long-command.ts': longCommandSource(),
      'src/nested-focus.ts': [
        'export function nestedFocus(items: number[]) {',
        '  const result: number[] = [];',
        '  for (const item of items) {',
        '    if (item < 0) continue;',
        '    result.push(item);',
        '    console.log(item);',
        '  }',
        '  return result;',
        '}',
      ],
      'src/__tests__/filler.test.ts': ['export const fillerTest = true;'],
      'src/behavior.ts': [
        'export async function deliver(enabled: boolean, customHeaders: Record<string, string>) {',
        '  if (!enabled) return false;',
        '  try {',
        '    const headers = {',
        "      'X-Generated': 'value',",
        '      ...customHeaders,',
        '    };',
        '    const response = await send(headers);',
        '    return response.ok;',
        '  } catch (error) {',
        '    throw error;',
        '  } finally {',
        '    running = false;',
        '  }',
        '}',
      ],
      'src/behavior.test.ts': [
        "import { deliver } from './behavior.js';",
        "it('retries after the lease expires', async () => expect(await deliver(true, {})).toBe(true));",
      ],
      'src/diverse-a.ts': [
        "export function alpha() { return 'sharedAnchor'; }",
        "export function beta() { return 'sharedAnchor'; }",
      ],
      'src/diverse-b.ts': ["export function gamma() { return 'sharedAnchor'; }"],
      'src/tier-a.ts': ["export const sourceAnchorA = 'tierAnchor';"],
      'src/tier-b.ts': ["export const sourceAnchorB = 'tierAnchor';"],
      'src/lib/index.ts': ["export const barrelAnchor = 'tierAnchor';"],
      'src/diverse.test.ts': ["export const testAnchor = 'tierAnchor';"],
      'src/bindings.ts': [
        'const SESSION_EVENTS_INITIAL_LIMIT = 250;',
        'const LOAD_MORE_INCREMENT = 250;',
        'const SERVER_MAX_LIMIT = 500;',
        'const REALTIME_FALLBACK_POLL_MS = 15_000;',
        '',
        'function normalize(value: number) {',
        '  return Math.max(0, value);',
        '}',
        '',
        'export function loadEvents(limit = SESSION_EVENTS_INITIAL_LIMIT) {',
        '  const next = normalize(limit + LOAD_MORE_INCREMENT);',
        '  const poll = REALTIME_FALLBACK_POLL_MS;',
        '  return Math.min(next, SERVER_MAX_LIMIT);',
        '}',
      ],
      'src/terminal.ts': ['export const TERMINAL_LIMIT = 42;'],
      'src/barrel.ts': ["export { TERMINAL_LIMIT } from './terminal.js';"],
      'src/barrel-consumer.ts': [
        "import { TERMINAL_LIMIT } from './barrel.js';",
        'export function readTerminalLimit() {',
        '  return TERMINAL_LIMIT;',
        '}',
      ],
      'src/anchor-heavy.ts': [
        'export function anchorHeavy(value: number) {',
        ...Array.from({ length: 32 }, (_, index) => `  if (value === ${index}) return ${index};`),
        '  return -1;',
        '}',
      ],
      'src/receipt.ts': [
        'const state = { lastTriggeredAt: new Date(0) };',
        'async function send(item: string, payload: object) { return { item, payload }; }',
        'export async function receipt(items: string[]) {',
        '  const payload = {',
        '    id: items.length,',
        "    event: 'created',",
        "    organizationId: 'org',",
        "    actorId: 'actor',",
        "    projectId: 'project',",
        '    timestamp: new Date().toISOString(),',
        '    data: items,',
        "    source: 'api',",
        '  };',
        '  const normalized = items.map((item) => item.trim());',
        '  const targets = normalized.filter(Boolean);',
        '  const count = targets.length;',
        '  const active = count > 0;',
        '  const label = active ? "active" : "idle";',
        '  const summary = `${label}:${count}`;',
        '  void summary;',
        '  try {',
        '    await Promise.allSettled(items.map((item) => send(item, payload)));',
        '  } catch (error) {',
        '    console.error(error);',
        '  }',
        '  state.lastTriggeredAt = new Date();',
        '  return payload;',
        '}',
      ],
      'src/lifecycle.ts': [
        'export function DeliveriesModal() {',
        '  useEffect(() => {',
        '    void loadDeliveries();',
        '  }, [loadDeliveries]);',
        '  return null;',
        '}',
      ],
      'src/outline.ts': [
        'export async function orchestrate(items: string[]) {',
        `  // ${'Detailed operational background that is useful in exact source but not behavioral triage. '.repeat(24)}`,
        '  // This deliberately verbose documentation makes raw source expensive without changing executable behavior.',
        '  // Normalize all inputs before deciding whether any externally visible work is necessary.',
        '  // The outline must remove these comments while preserving every statement, guard, call, and exit below.',
        '  // It must also retain nesting so the caller can distinguish the loop body from the surrounding function.',
        '  const normalized = items.map((item) => item.trim());',
        '  if (normalized.length === 0) {',
        '    return [];',
        '  }',
        '  const results = [];',
        '  for (const item of normalized) {',
        '    try {',
        '      results.push(await send(item));',
        '    } catch (error) {',
        '      throw error;',
        '    }',
        '  }',
        '  return results;',
        '}',
      ],
      'src/outline-sensitive.ts': [
        'export async function persistAll(records: Array<{ disabled: boolean; id: string }>) {',
        `  // ${'The exact source retains detailed operational documentation while the outline accounts for behavior. '.repeat(18)}`,
        '  // Nested control flow must remain visibly nested and in source order.',
        '  // Multi-line literals are deliberately copied because normalizing their whitespace can change meaning.',
        '  const saved = [];',
        '  for (const record of records) {',
        '    if (record.disabled) {',
        '      continue;',
        '    }',
        '    try {',
        '      const query = sql`',
        '        INSERT INTO records (id)',
        '        VALUES (${record.id})',
        '      `;',
        '      saved.push(await database.execute(query));',
        '    } catch (error) {',
        '      throw error;',
        '    } finally {',
        '      metrics.increment("records.attempted");',
        '    }',
        '  }',
        '  return saved;',
        '}',
      ],
      'src/class-outline.ts': [
        'export class DeliveryWorker {',
        `  // ${'This long comment makes the behavioral comparison economically meaningful. '.repeat(18)}`,
        '  // The method remains owned by its class rather than flattened into a generic function.',
        '  // Its guard, loop, awaited effect, and return must all remain accounted for.',
        '  // Exact source remains available at the reported range.',
        '  async execute(items: string[]) {',
        `    // ${'Operational commentary is retained in exact source while executable behavior is outlined. '.repeat(15)}`,
        '    // The early return prevents downstream calls for an empty delivery batch.',
        '    // Each remaining item is delivered in source order.',
        '    // The complete implementation remains recoverable from this method range.',
        '    if (items.length === 0) {',
        '      return [];',
        '    }',
        '    const delivered = [];',
        '    for (const item of items) {',
        '      delivered.push(await this.deliver(item));',
        '    }',
        '    return delivered;',
        '  }',
        '}',
      ],
      'src/outline-fidelity.ts': [
        'export async function transmit(token: string, endpoint: string, state: { count: number }) {',
        `  // ${'This documentation is intentionally verbose so the projection must earn a real token saving. '.repeat(20)}`,
        '  if (token && /a\\s+b/.test(token)) {',
        '    state.count += 1;',
        '    await fetch(endpoint, {',
        "      method: 'POST',",
        '      body: JSON.stringify({ token }),',
        '    });',
        '  }',
        '  if (!token) {',
        '    throw new Error("token is required");',
        '  }',
        '  return state.count;',
        '}',
      ],
      'src/outline-dense.ts': [
        'export function normalizeEvents(events: Array<{ content?: string; payload?: object }>) {',
        `  // ${'Operational explanation retained only to make compression economically useful. '.repeat(20)}`,
        '  const normalized = events',
        "    .filter((event) => event && typeof event === 'object')",
        '    .map((event) => {',
        "      const content = typeof event.content === 'string'",
        '        ? event.content.trim().slice(0, 12_000)',
        '        : null;',
        "      const payload = event.payload && typeof event.payload === 'object'",
        '        ? event.payload',
        '        : {};',
        '      return { content, payload };',
        '    })',
        '    .filter((event) => event.content || Object.keys(event.payload).length > 0)',
        '    .slice(0, 200);',
        '  return normalized;',
        '}',
      ],
      'src/registry-table.ts': [
        'export const handlers = {',
        "  alpha: () => 'alpha',",
        '  target: async (input: { valid: boolean }) => {',
        '    if (!input.valid) {',
        '      throw new Error("invalid input");',
        '    }',
        "    return await dispatch('target', input);",
        '  },',
        "  omega: () => 'omega',",
        '};',
      ],
      ...(ambiguous
        ? {
            'src/other-api.ts': ['export function appendThing(value: string) {', '  return value.toUpperCase();', '}'],
          }
        : {}),
    });
    const target = 'scip-typescript npm pkg 1.0.0 src/`api.ts`/appendThing().';
    const caller = 'scip-typescript npm pkg 1.0.0 src/`consumer.ts`/run().';
    const testCaller = 'scip-typescript npm pkg 1.0.0 src/`api.test.ts`/testAppendThing().';
    const deliver = 'scip-typescript npm pkg 1.0.0 src/`behavior.ts`/deliver().';
    const builder = evidenceFixtureDb(join(tempDir, 'index.db'))
      .document(1, 'typescript', 'src/api.ts')
      .document(2, 'typescript', 'src/consumer.ts')
      .document(4, 'typescript', 'src/commands.ts')
      .document(5, 'typescript', 'src/long-command.ts')
      .document(6, 'typescript', 'src/__tests__/filler.test.ts')
      .document(7, 'typescript', 'src/behavior.ts')
      .document(8, 'typescript', 'src/behavior.test.ts')
      .document(9, 'typescript', 'src/diverse-a.ts')
      .document(10, 'typescript', 'src/diverse-b.ts')
      .document(11, 'python', 'src/python-consumer.py')
      .document(12, 'rust', 'src/rust-consumer.rs')
      .document(13, 'typescript', 'src/ambiguous-calls.ts')
      .document(14, 'text', 'notes/unparsed-call.txt')
      .document(15, 'typescript', 'src/bindings.ts')
      .document(16, 'typescript', 'src/anchor-heavy.ts')
      .document(17, 'typescript', 'src/terminal.ts')
      .document(18, 'typescript', 'src/barrel.ts')
      .document(19, 'typescript', 'src/barrel-consumer.ts')
      .document(20, 'typescript', 'src/lib/index.ts')
      .document(21, 'typescript', 'src/diverse.test.ts')
      .document(22, 'typescript', 'src/tier-a.ts')
      .document(23, 'typescript', 'src/tier-b.ts')
      .document(24, 'typescript', 'src/receipt.ts')
      .document(25, 'typescript', 'src/lifecycle.ts')
      .document(26, 'typescript', 'src/outline-fidelity.ts')
      .document(27, 'typescript', 'src/registry-table.ts')
      .document(28, 'typescript', 'src/api.test.ts')
      .document(29, 'typescript', 'src/outline-dense.ts')
      .document(30, 'typescript', 'src/nested-focus.ts')
      .symbol(1, target, 'appendThing', 12, 'function appendThing|function appendThing(value: string): string')
      .symbol(2, caller, 'run', 12, 'function run|function run(): string[]')
      .symbol(4, 'scip-typescript npm pkg 1.0.0 src/`commands.ts`/commandSet.', 'commandSet', 13)
      .symbol(5, 'scip-typescript npm pkg 1.0.0 src/`long-command.ts`/longCommand.', 'longCommand', 13)
      .symbol(7, deliver, 'deliver', 12)
      .symbol(
        15,
        'scip-typescript npm pkg 1.0.0 src/`bindings.ts`/SESSION_EVENTS_INITIAL_LIMIT.',
        'SESSION_EVENTS_INITIAL_LIMIT',
        13,
      )
      .symbol(16, 'scip-typescript npm pkg 1.0.0 src/`bindings.ts`/LOAD_MORE_INCREMENT.', 'LOAD_MORE_INCREMENT', 13)
      .symbol(17, 'scip-typescript npm pkg 1.0.0 src/`bindings.ts`/SERVER_MAX_LIMIT.', 'SERVER_MAX_LIMIT', 13)
      .symbol(18, 'scip-typescript npm pkg 1.0.0 src/`bindings.ts`/normalize().', 'normalize', 12)
      .symbol(19, 'scip-typescript npm pkg 1.0.0 src/`bindings.ts`/loadEvents().', 'loadEvents', 12)
      .symbol(
        20,
        'scip-typescript npm pkg 1.0.0 src/`bindings.ts`/REALTIME_FALLBACK_POLL_MS.',
        'REALTIME_FALLBACK_POLL_MS',
        13,
      )
      .symbol(21, 'scip-typescript npm pkg 1.0.0 src/`terminal.ts`/TERMINAL_LIMIT.', 'TERMINAL_LIMIT', 13)
      .symbol(
        22,
        'scip-typescript npm pkg 1.0.0 src/`barrel-consumer.ts`/readTerminalLimit().',
        'readTerminalLimit',
        12,
      )
      .symbol(23, testCaller, 'testAppendThing', 12)
      .symbol(24, 'scip-typescript npm pkg 1.0.0 src/`nested-focus.ts`/nestedFocus().', 'nestedFocus', 12)
      .definition(1, 1, 1, 0, 0, 2, 1)
      .definition(2, 2, 2, 2, 0, 13, 1)
      .definition(4, 4, 4, 0, 0, 0, 32)
      .definition(5, 5, 5, 0, 0, 0, 32)
      .definition(7, 7, 7, 0, 0, 14, 1)
      .definition(15, 15, 15, 0, 0, 0, 41)
      .definition(16, 15, 16, 1, 0, 1, 32)
      .definition(17, 15, 17, 2, 0, 2, 29)
      .definition(18, 15, 18, 5, 0, 7, 1)
      .definition(19, 15, 19, 9, 0, 13, 1)
      .definition(20, 15, 20, 3, 0, 3, 42)
      .definition(21, 17, 21, 0, 0, 0, 33)
      .definition(22, 19, 22, 1, 0, 3, 1)
      .definition(23, 28, 23, 1, 0, 1, 66)
      .definition(24, 30, 24, 0, 0, 8, 1)
      .chunk(1, 1, 0, 2)
      .chunk(2, 2, 2, 13)
      .chunk(4, 4, 0, 5)
      .chunk(5, 5, 0, 26)
      .chunk(23, 28, 1, 1)
      .mention(1, 1, 1)
      .mention(2, 2, 1)
      .mention(2, 1, 0)
      .mention(4, 4, 1)
      .mention(5, 5, 1)
      .mention(23, 23, 1)
      .mention(23, 1, 0);
    if (ambiguous) {
      builder
        .document(3, 'typescript', 'src/other-api.ts')
        .symbol(3, 'scip-typescript npm pkg 1.0.0 src/`other-api.ts`/appendThing().', 'appendThing', 12)
        .definition(3, 3, 3, 0, 0, 2, 1)
        .chunk(3, 3, 0, 2)
        .mention(3, 3, 1);
    }
    builder.write();
    const config: ScipQueryConfig = {
      dbPath: join(tempDir, 'index.db'),
      indexPath: join(tempDir, 'index.scip'),
      projectRoot: tempDir,
    };
    return new ScipDatabase(config);
  }

  function longCommandSource(returnLine = '    return true;'): string[] {
    return [
      'export const longCommand = {',
      '  run() {',
      "    console.log('firstAnchor');",
      ...Array.from({ length: 20 }, (_, index) => `    const filler${index} = ${index};`),
      "    console.log('lastAnchor');",
      returnLine,
      '  },',
      '};',
    ];
  }
});
