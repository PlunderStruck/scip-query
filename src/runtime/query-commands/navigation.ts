import * as queries from '../../queries/index.js';
import { REPOSITORY_OBSERVATION_OPERATION } from '../command-operation.js';
import type { CommandDescriptor, InvocationCoverage } from '../command-kit/command-descriptor-types.js';
import {
  agentContract,
  collectValues,
  compactOption,
  doc,
  option,
  parseInteger,
  parseNonNegativeInteger,
  parsePositiveInteger,
  withJsonOption,
} from '../command-kit/command-spec-builders.js';
import {
  booleanOptionValue,
  budgetedDbCommand,
  budgetedListCommand,
  dbCommand,
  definedLimitOption,
  definedNumberOption,
  numberOptionValue,
  printJsonEnvelope,
  stringArg,
  stringArrayOptionValue,
  stringOptionValue,
} from '../command-kit/command-execution.js';
import {
  budgetedSectionedQueryCommand,
  listQueryCommand,
  sectionedQueryCommand,
  tableQueryCommand,
} from '../command-kit/query-command-builders.js';
import { displayLine, displayPathRange, displayRange, render } from '../render.js';
import type { ReportSection } from '../render.js';
import { renderSourceEvidence } from '../source-emission-session.js';
import {
  symbolResolutionJson,
  symbolResolutionBefore,
  symbolResolutionEmptyMessage,
  withSymbolResolutionJson,
} from './symbol-resolution.js';
import { directNavigationQueryCommandDescriptors } from './direct-navigation.js';

export function inspectSearchLimitOption(opts: Readonly<Record<string, unknown>>): number | undefined {
  const full = booleanOptionValue(opts, 'full');
  const searchLimit = definedLimitOption(opts, 'limit', 12);
  return full ? undefined : searchLimit;
}

export function inspectViewOption(opts: Readonly<Record<string, unknown>>): queries.SourceInspectionView {
  const view = stringOptionValue(opts, 'view') ?? 'source';
  if (view !== 'source' && view !== 'behavior') {
    throw new Error(`Unknown inspect view: ${view}. Use source or behavior.`);
  }
  return view;
}

function traceSections(result: queries.QualifiedTraceEvidenceResult): ReportSection[] {
  const definitionRows: string[] = [];
  for (const d of result.definitions) {
    const sig = d.signature ? `  — ${d.signature}` : '';
    if (d.source) {
      definitionRows.push(
        renderSourceEvidence({
          relativePath: d.relativePath,
          startLine: d.startLine,
          source: d.source,
          sessionPolicy: 'exact-unit',
          headerSuffix: sig,
          ownerSymbol: d.signature ?? undefined,
        }),
      );
    } else {
      definitionRows.push(`  ${displayPathRange(d.relativePath, d.startLine, d.endLine)}${sig}`);
    }
  }

  const refRows: string[] = [];
  let prevFile = '';
  for (const ref of result.referencedBy) {
    if (ref.relativePath !== prevFile) {
      if (prevFile) refRows.push('');
      refRows.push(`  ${ref.relativePath}`);
      prevFile = ref.relativePath;
    }
    const sourceKind = referenceSourceKind(result.referenceEvidence, ref.relativePath, ref.line);
    refRows.push(`    line ${displayLine(ref.line)}  in ${ref.enclosingShort}  [${referenceSourceLabel(sourceKind)}]`);
    if (
      ref.source !== undefined &&
      ref.source !== null &&
      ref.sourceStartLine !== undefined &&
      ref.sourceStartLine !== null
    ) {
      refRows.push(
        renderSourceEvidence({
          relativePath: ref.relativePath,
          startLine: ref.sourceStartLine,
          source: ref.source,
          sessionPolicy: 'preview',
          focusLines: new Set([ref.line]),
          ownerSymbol: ref.enclosingShort ?? undefined,
          indent: '      ',
          sourceIndent: '      ',
        }),
      );
    }
  }

  return [
    { title: 'DEFINITION', rows: definitionRows },
    { title: 'REFERENCED BY', rows: refRows },
    { title: 'CLAIM SUPPORT', rows: claimSupportRows(result.claimSupport), skipIfEmpty: true },
  ];
}

function referenceSourceKind(
  evidence: readonly queries.TraceReferenceEvidence[],
  relativePath: string,
  line: number,
): queries.TraceReferenceSourceKind | undefined {
  return evidence.find((item) => item.relativePath === relativePath && item.line === line)?.sourceKind;
}

function referenceSourceLabel(kind: queries.TraceReferenceSourceKind | undefined): string {
  switch (kind) {
    case 'complete-call-expression':
      return 'complete call';
    case 'non-call-reference':
      return 'non-call reference';
    case 'bounded-context':
      return 'bounded context';
    case 'unavailable':
      return 'source unavailable';
    default:
      return 'coverage unknown';
  }
}

function claimSupportRows(support: queries.TraceClaimSupport | null | undefined): string[] {
  if (!support) return [];
  return [
    claimEligibilityRow('Reference-absence claims', support.referenceAbsence),
    claimEligibilityRow('Callsite-argument claims', support.callsitePredicates),
  ];
}

function claimEligibilityRow(label: string, eligibility: queries.TraceClaimEligibility): string {
  if (eligibility.status === 'eligible') {
    return `  ${label}: eligible within ${eligibility.scope}. ${eligibility.limitations.join(' ')}`;
  }
  return [
    `  ${label}: INELIGIBLE within ${eligibility.scope}; ${eligibility.reason}`,
    ...(eligibility.followup ? [`    Inspect uncertain sites together: ${eligibility.followup}`] : []),
  ].join('\n');
}

const EVIDENCE_PARTS = [
  'definition',
  'references',
  'callers',
  'callees',
  'dependencies',
  'consumers',
] as const satisfies readonly queries.EvidencePart[];

function selectedEvidenceParts(values: readonly string[]): queries.EvidencePart[] | undefined {
  if (values.length === 0) return undefined;
  const expanded = values
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean);
  if (expanded.includes('all')) return [...EVIDENCE_PARTS];
  const invalid = expanded.filter((value) => !EVIDENCE_PARTS.includes(value as queries.EvidencePart));
  if (invalid.length > 0) {
    throw new Error(`Unknown evidence part: ${invalid.join(', ')}. Use ${EVIDENCE_PARTS.join(', ')}, or all.`);
  }
  return [...new Set(expanded as queries.EvidencePart[])];
}

function sourceSearchSections(result: queries.SourceSearchResult): ReportSection[] {
  const identities = sourceSearchRenderedIdentities(result);
  const identityCoverage = sourceSearchIdentityCoverage(result, identities);
  const sourceRows = result.matches.map((match) => {
    const owner = match.ownerShort ? `  in ${match.ownerShort}` : '';
    return renderSourceEvidence({
      relativePath: match.relativePath,
      startLine: match.startLine,
      source: match.source,
      sessionPolicy: 'preview',
      focusLines: new Set([match.focusLine]),
      ownerSymbol: match.ownerShort ?? undefined,
      headerSuffix: owner,
    });
  });
  const identityRows = sourceSearchIdentityRows(identities);
  const recoveryCommands = identityCoverage.mode === 'complete' ? sourceSearchRecoveryCommands(result, identities) : [];
  const textCoverage = result.textCoverage;
  const exactTextComplete = sourceSearchTextCoverageComplete(result);
  return [
    {
      title: `MATCH IDENTITIES (${identities.length}/${result.matchingLines}, ${identityCoverage.mode.toUpperCase()})`,
      rows: identityRows,
    },
    {
      title: `REPRESENTATIVE SOURCE (${result.matches.length}/${result.matchingLines} WINDOWS)`,
      rows: sourceRows,
    },
    {
      title: 'SEARCH COVERAGE',
      rows: [
        `  ${exactTextComplete ? 'Exact' : 'Observed'} cardinality: ${result.matchingLines} matching line(s) across ${result.matchingFiles ?? result.fileCoverage?.length ?? 0} file(s).`,
        `  Identity manifest: ${identities.length}/${result.matchingLines} matching line(s); ${identityCoverage.mode === 'complete' ? 'complete' : `${identityCoverage.omitted} lower-ranked identities withheld before rendering`}.`,
        `  Source materialization: ${result.matches.length}/${result.matchingLines} window(s); ${result.omittedMatches} exact match location(s) were not expanded into source.`,
        ...(textCoverage
          ? [
              `  Exact text: ${textCoverage.scannedTextFiles}/${textCoverage.candidateFiles} current project text file(s), ${textCoverage.scannedBytes.toLocaleString()} byte(s) scanned at query time.`,
              `  Semantic ownership overlay: ${textCoverage.semanticFiles.aligned} aligned, ${textCoverage.semanticFiles.stale} stale, ${textCoverage.semanticFiles.unavailable} unavailable file(s).`,
              `  Non-text/unreadable exclusions: ${textCoverage.skippedBinaryPaths.length} binary, ${textCoverage.skippedUnreadablePaths.length} unreadable, ${textCoverage.skippedOversizedPaths.length} oversized path(s); exact identities remain in textCoverage.`,
              ...(exactTextComplete
                ? []
                : ['  Text coverage is incomplete: unreadable or oversized text may contain additional matches.']),
            ]
          : []),
        ...(identityCoverage.mode === 'bounded'
          ? sourceSearchScopeRows(result)
          : recoveryCommands.length > 0
            ? [
                `  Recover every unmaterialized owning unit in ${recoveryCommands.length} bounded batch command(s):`,
                ...recoveryCommands.map((command) => `  ${command}`),
                `  Or inspect any chosen locations together at behavior level: scip-query inspect --at 'path:line' --at 'path:line' --view behavior`,
              ]
            : ['  Every matching source window was materialized; no drilldown remains.']),
      ],
    },
  ];
}

function sourceSearchTextCoverageComplete(result: queries.SourceSearchResult): boolean {
  const coverage = result.textCoverage;
  return Boolean(
    coverage && coverage.skippedUnreadablePaths.length === 0 && coverage.skippedOversizedPaths.length === 0,
  );
}

function sourceSearchIdentityCoverage(
  result: queries.SourceSearchResult,
  identities: readonly queries.SourceSearchIdentity[],
): queries.SourceSearchIdentityCoverage {
  return (
    result.identityCoverage ?? {
      mode: identities.length === result.matchingLines ? 'complete' : 'bounded',
      returned: identities.length,
      total: result.matchingLines,
      omitted: Math.max(0, result.matchingLines - identities.length),
    }
  );
}

function sourceSearchScopeRows(result: queries.SourceSearchResult): string[] {
  const hints = result.scopeHints ?? [];
  return [
    '  Broad selector: identity enumeration stopped before output transport; there is no cursor to drain.',
    ...(hints.length > 0
      ? [
          '  Highest-coverage scopes available for focused re-query:',
          ...hints.map(
            (hint) =>
              `    ${hint.scope}: ${hint.matchingLines} matching line(s) across ${hint.matchingFiles} file(s); scip-query search ${shellArgument(result.pattern)} --scope ${shellArgument(hint.scope)}`,
          ),
        ]
      : []),
    ...((result.omittedScopeHints ?? 0) > 0
      ? [
          `    ... ${result.omittedScopeHints} additional matching scope(s) remain recoverable by narrowing the selector.`,
        ]
      : []),
    '  Prefer a more distinctive literal or one relevant scope; use inspect to batch the chosen anchors.',
  ];
}

function sourceSearchIdentities(result: queries.SourceSearchResult): queries.SourceSearchIdentity[] {
  return (
    result.identities ??
    result.matches.map((match) => ({
      relativePath: match.relativePath,
      focusLine: match.focusLine,
      ownerSymbol: match.ownerSymbol,
      ownerShort: match.ownerShort,
      ownerStartLine: match.ownerStartLine ?? null,
      ownerEndLine: match.ownerEndLine ?? null,
      fileKind: match.fileKind ?? 'source',
      freshness: match.freshness,
    }))
  );
}

function sourceSearchRenderedIdentities(result: queries.SourceSearchResult): queries.SourceSearchIdentity[] {
  return result.identityManifest ?? sourceSearchIdentities(result);
}

function sourceSearchIdentityRows(identities: readonly queries.SourceSearchIdentity[]): string[] {
  const byFile = new Map<string, queries.SourceSearchIdentity[]>();
  for (const identity of identities) {
    const rows = byFile.get(identity.relativePath) ?? [];
    rows.push(identity);
    byFile.set(identity.relativePath, rows);
  }
  return [...byFile.entries()].flatMap(([relativePath, fileIdentities]) => {
    const byOwner = new Map<string, { label: string; lines: number[] }>();
    for (const identity of fileIdentities) {
      const ownerKey = identity.ownerSymbol ?? '<file>';
      const ownerRange =
        identity.ownerStartLine === null || identity.ownerEndLine === null
          ? ''
          : ` ${displayLine(identity.ownerStartLine)}-${displayLine(identity.ownerEndLine)}`;
      const owner = byOwner.get(ownerKey) ?? {
        label: identity.ownerShort ? `${identity.ownerShort}${ownerRange}` : '<file scope>',
        lines: [],
      };
      owner.lines.push(displayLine(identity.focusLine));
      byOwner.set(ownerKey, owner);
    }
    return [
      `  ${relativePath}  [${fileIdentities[0]!.fileKind}; ${fileIdentities.length} match(es)]`,
      ...[...byOwner.values()].flatMap((owner) =>
        chunk(owner.lines, 24).map((lines, index) => `    ${index === 0 ? owner.label : '↳'} @ ${lines.join(',')}`),
      ),
    ];
  });
}

function sourceSearchRecoveryCommands(
  result: queries.SourceSearchResult,
  identities: readonly queries.SourceSearchIdentity[],
): string[] {
  const materialized = new Set(result.matches.map((match) => sourceSearchIdentityKey(match)));
  const selectors = new Set<string>();
  for (const identity of identities) {
    if (materialized.has(sourceSearchIdentityKey(identity))) continue;
    const startLine = displayLine(identity.ownerStartLine ?? identity.focusLine);
    const endLine = displayLine(identity.ownerEndLine ?? identity.focusLine);
    selectors.add(`${identity.relativePath}:${startLine}-${endLine}`);
  }
  return chunk([...selectors], 24).map(
    (batch) => `scip-query code ${batch.map((selector) => shellArgument(selector)).join(' ')}`,
  );
}

function sourceSearchIdentityKey(identity: Pick<queries.SourceSearchIdentity, 'relativePath' | 'focusLine'>): string {
  return `${identity.relativePath}\0${identity.focusLine}`;
}

function chunk<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

function shellArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function sourceInspectionSections(result: queries.SourceInspectionResult): ReportSection[] {
  const units = result.units ?? [];
  const searchRows = result.searches.map((search) => {
    const rows = [
      `  ${search.pattern}: ${search.returnedMatches}/${search.matchingLines} matching line(s) materialized across ${search.returnedFiles ?? 0}/${search.matchingFiles ?? 0} file(s); ${search.selectedUnits ?? 0}/${search.candidateUnits ?? 0} deduplicated unit(s) selected`,
    ];
    if (search.omittedMatches > 0 || (search.omittedUnits ?? 0) > 0) {
      rows.push(
        `    Withheld: ${search.omittedMatches} matching line(s), ${search.omittedFiles ?? 0} file(s) with no materialized match, and ${search.omittedUnits ?? 0} materialized unit(s) outside the packet ceiling.`,
      );
      if ((search.scopeHints?.length ?? 0) > 0) {
        rows.push('    Highest-coverage scopes available for focused expansion:');
        rows.push(
          ...(search.scopeHints ?? []).map(
            (scope) =>
              `      ${scope.scope}: ${scope.returnedMatches}/${scope.matchingLines} matching line(s) materialized; ${scope.exactFollowup}`,
          ),
        );
        if ((search.omittedScopeHints ?? 0) > 0)
          rows.push(`      ... ${search.omittedScopeHints} additional matching scope(s).`);
      }
      if (search.exactFollowup) {
        rows.push(
          `    Expand this selector completely only if omitted matches can change the decision: ${search.exactFollowup}`,
        );
      }
    }
    return rows.join('\n');
  });
  const locationRows = result.locations.map(
    (location) => `  ${location.matched ? 'matched' : 'missing'}  ${location.target}`,
  );
  const sourceRows = units.map(sourceInspectionUnitRow);
  const bindingRows = bindingClosureRows(result.bindingClosure);
  const omissionRows = (result.omissionGroups ?? []).map(sourceInspectionOmissionGroupRow);
  const resolutionRows = result.evidence.flatMap((item) => {
    const failure = evidenceFailureMessage(item, 'inspect');
    return failure ? [`  ${failure}`] : [];
  });
  const packet = result.packetCoverage;
  const packetRows = packet
    ? [
        `  ${packet.mode === 'complete' ? 'Complete' : 'Ranked bounded'} semantic packet: ${packet.returnedUnits}/${packet.candidateUnits} materialized unit(s), ${result.returnedLines ?? 0} underlying source line(s), and ${result.returnedViewCharacters ?? result.returnedCharacters ?? 0} displayed evidence character(s).`,
        `  Selection ceiling: ${packet.maxUnits} unit(s) or ${packet.maxCharacters} displayed evidence character(s); syntax units are never clipped.`,
        `  Exact symbol/location evidence: ${packet.exactSelectorsComplete ? 'complete within materialized compiler evidence' : 'some lower-ranked units withheld'}.`,
        ...(packet.omittedUnits > 0
          ? [`  Withheld materialized units by role: ${renderInspectionRoleCounts(packet.omittedByRole)}.`]
          : []),
        ...(packet.expansionCommand
          ? [
              `  Expand the complete selector set only if omitted evidence can change the decision: ${packet.expansionCommand}`,
            ]
          : []),
        '  Universal output transport may still page the rendered bytes; transport pages do not change this selection coverage.',
      ]
    : [
        `  Complete semantic packet: ${units.length} deduplicated unit(s), ${result.returnedLines ?? 0} source line(s), and ${result.returnedCharacters ?? 0} source character(s).`,
      ];
  const stoppingRows = result.stoppingSummary
    ? [
        `  ${result.stoppingSummary.status}: ${result.stoppingSummary.guidance}`,
        ...(result.stoppingSummary.openEvidence > 0
          ? [
              `  ${result.stoppingSummary.openEvidence} open evidence item(s); ${(result.omissionGroups ?? []).length} recoverable omission group(s).`,
            ]
          : []),
      ]
    : [];
  return [
    { title: 'SEARCH COVERAGE', rows: searchRows, skipIfEmpty: true },
    { title: 'LOCATION COVERAGE', rows: locationRows, skipIfEmpty: true },
    { title: 'SYMBOL RESOLUTION', rows: resolutionRows, skipIfEmpty: true },
    { title: 'EVIDENCE PACKET', rows: sourceRows, skipIfEmpty: true },
    { title: 'LITERAL VALUES', rows: bindingRows, skipIfEmpty: true },
    { title: 'OMISSION LEDGER', rows: omissionRows, skipIfEmpty: true },
    {
      title: 'PACKET COVERAGE',
      rows: packetRows,
    },
    { title: 'STOPPING CHECK', rows: stoppingRows, skipIfEmpty: true },
  ];
}

function renderInspectionRoleCounts(counts: Partial<Record<queries.SourceInspectionUnitRole, number>>): string {
  return Object.entries(counts)
    .map(([role, count]) => `${role}=${count}`)
    .join(', ');
}

function sourceInspectionUnitRow(unit: queries.SourceInspectionUnit): string {
  switch (unit.kind) {
    case 'source': {
      const owner = unit.ownerShort ? `  in ${unit.ownerShort}` : '';
      if (unit.behavior) {
        const coverage = unit.behavior.coverage;
        const rows = [
          `  ${displayPathRange(unit.relativePath, unit.startLine, unit.endLine)}${owner}`,
          `    roles: ${unit.roles.join(', ')}; selected by ${unit.reasons.join(', ')}`,
          `    ${unit.behavior.constructKind}: ${unit.behavior.signature}`,
          ...unit.behavior.lines.map(
            (line) =>
              `    L${displayLine(line.line)}${line.endLine > line.line ? `-${displayLine(line.endLine)}` : ''} ${'  '.repeat(line.depth)}${line.text}${line.copied ? '  [verbatim]' : ''}`,
          ),
          ...(unit.behavior.testCases.length > 0
            ? [`    related test cases: ${unit.behavior.testCases.join('; ')}`]
            : []),
          ...sourceInspectionRuntimeFactRows(unit.runtimeFacts ?? []),
          `    coverage: ${coverage.representedStatements}/${coverage.sourceStatements} source statement(s) represented; ${coverage.copiedStatements} verbatim; ${coverage.omittedStatements} omitted; ${unit.behavior.outlineCharacters}/${unit.behavior.rawCharacters} estimated characters`,
        ];
        return rows.join('\n');
      }
      const source = renderSourceEvidence({
        relativePath: unit.relativePath,
        startLine: unit.startLine,
        source: unit.source,
        sessionPolicy: 'exact-unit',
        focusLines: new Set(unit.focusLines),
        ownerSymbol: unit.ownerShort ?? undefined,
        headerSuffix: owner,
        afterHeader: [`    roles: ${unit.roles.join(', ')}; selected by ${unit.reasons.join(', ')}`],
      });
      const runtimeRows = sourceInspectionRuntimeFactRows(unit.runtimeFacts ?? []);
      return runtimeRows.length > 0 ? `${source}\n${runtimeRows.join('\n')}` : source;
    }
    case 'path':
      return [
        `  ${unit.relationship}`,
        `    ${unit.roles.join(', ')} edge source was not located. Follow up exactly: ${unit.exactFollowup}`,
      ].join('\n');
    default:
      return assertNever(unit);
  }
}

function sourceInspectionRuntimeFactRows(facts: readonly queries.SourceInspectionRuntimeFact[]): string[] {
  return facts.map((fact) => {
    const key = fact.keyParts.map((part) => `${part.name}=${part.value}`).join(', ') || 'no resolved key';
    return (
      `    runtime L${displayLine(fact.line)} [${fact.strength}] ${fact.action} (${fact.role}; ${fact.resolution}) ` +
      `${key}; proof=${fact.derivation.rule}`
    );
  });
}

function sourceInspectionOmissionGroupRow(group: queries.SourceInspectionOmissionGroup): string {
  const anchors = group.anchors.slice(0, 4).map((anchor) => {
    const owner = anchor.ownerShort ? ` in ${anchor.ownerShort}` : '';
    const signals = anchor.behaviorSignals.length > 0 ? ` [${anchor.behaviorSignals.join(',')}]` : '';
    return `      ${anchor.relativePath}:${displayLine(anchor.line)}${owner}${signals}`;
  });
  if (group.anchors.length > anchors.length) {
    anchors.push(`      ... ${group.anchors.length - anchors.length} additional anchor(s) represented by this group.`);
  }
  return [
    `  ${group.id}  ${group.scope} — ${group.candidateUnits} unit(s), ${group.sourceCharacters} source character(s)`,
    `    roles: ${group.roles.join(', ')}; behavior: ${group.behaviorSignals.join(', ') || 'not summarized'}`,
    ...anchors,
    `    Drill into this group together: ${group.drillCommand}`,
  ].join('\n');
}

function assertNever(value: never): never {
  throw new Error(`Unhandled source inspection unit: ${JSON.stringify(value)}`);
}

function evidenceFailureMessage(
  result: queries.EvidenceResult,
  command: 'evidence' | 'inspect' = 'evidence',
): string | undefined {
  if (result.kind === 'missing') return `No definition matched '${result.query}'.`;
  if (result.kind !== 'ambiguous') return undefined;
  const commands = result.candidates
    .map((candidate) => {
      const target = `'${candidate.symbol.replaceAll("'", "'\\''")}'`;
      return command === 'inspect' ? `  scip-query inspect --symbol ${target}` : `  scip-query evidence ${target}`;
    })
    .join('\n');
  const shown = result.candidates.length;
  const coverage = shown < result.total ? ` Showing the highest-ranked ${shown}; narrow by path or` : '';
  return (
    `Target '${result.query}' is ambiguous across ${result.total} definitions.${coverage} ` +
    `run one listed exact command:\n${commands}`
  );
}

function evidenceSections(result: queries.QualifiedEvidenceResult): ReportSection[] {
  if (result.kind !== 'matched') return [];
  const definitionRows = result.definition
    ? [
        renderSourceEvidence({
          relativePath: result.definition.relativePath,
          startLine: result.definition.startLine,
          source: result.definition.source,
          sessionPolicy: 'exact-unit',
          ownerSymbol: result.definition.shortName,
          headerSuffix: `  ${result.definition.shortName}`,
        }),
        ...bindingClosureRows(result.definition.bindingClosure),
      ]
    : [];
  const referenceRows = result.referenceWindows.map((window) => {
    const identities = window.references
      .map(
        (reference) =>
          `${displayLine(reference.line)} in ${reference.enclosingShort} [` +
          `${referenceSourceLabel(referenceSourceKind(result.referenceEvidence, window.relativePath, reference.line))}]`,
      )
      .join(', ');
    return renderSourceEvidence({
      relativePath: window.relativePath,
      startLine: window.startLine,
      source: window.source,
      sessionPolicy: 'preview',
      focusLines: new Set(window.references.map((reference) => reference.line)),
      headerSuffix: `  references: ${identities}`,
    });
  });
  const relatedRows = (rows: readonly queries.EvidenceRelatedSymbol[]) =>
    rows.map((row) =>
      renderSourceEvidence({
        relativePath: row.relativePath,
        startLine: row.startLine,
        source: row.source,
        sessionPolicy: 'preview',
        ownerSymbol: row.shortName,
        headerSuffix: `  ${row.shortName}${row.omittedLines > 0 ? `  (${row.omittedLines} line(s) omitted)` : ''}`,
      }),
    );
  return [
    { title: 'DEFINITION', rows: definitionRows, skipIfEmpty: true },
    { title: 'REFERENCE SITES', rows: referenceRows, skipIfEmpty: true },
    { title: 'CALLERS', rows: relatedRows(result.callers), skipIfEmpty: true },
    { title: 'CALLEES', rows: relatedRows(result.callees), skipIfEmpty: true },
    { title: 'DEPENDENCIES', rows: result.dependencies.map((row) => `  ${row.relativePath}`), skipIfEmpty: true },
    { title: 'CONSUMERS', rows: result.consumers.map((row) => `  ${row.relativePath}`), skipIfEmpty: true },
    { title: 'CLAIM SUPPORT', rows: claimSupportRows(result.claimSupport), skipIfEmpty: true },
  ];
}

function bindingClosureRows(closure: queries.BindingClosure | undefined): string[] {
  if (!closure) return [];
  const rows: string[] = [];
  for (const binding of closure.inline) {
    rows.push(
      `  inline  ${binding.name} @ ${displayPathRange(binding.relativePath, binding.startLine, binding.endLine)}`,
      `    ${binding.source ?? ''}`,
    );
  }
  return rows;
}

const handleImports = budgetedListCommand('imports', {
  query: ({ db, args, budget }) => queries.imports(db, stringArg(args, 0), { semantic: budget.semantic }),
  format: (r) => `  ${r.shortName}  ← ${r.fromFile}`,
  emptyMessage: () => 'No imports found (indexer may not emit role=2 for this language).',
});

const handleDataflow = budgetedDbCommand('dataflow', ({ db, args, opts, budget }) => {
  const query = stringArg(args, 0);
  const result = queries.dataflow(db, query, { semantic: budget.semantic });
  if (booleanOptionValue(opts, 'json')) {
    printJsonEnvelope('dataflow', args, opts, withSymbolResolutionJson(db, query, result, 'dataflow'), {
      analysisBudget: budget.analysisBudget,
    });
    return;
  }
  if (!result) return render.empty(symbolResolutionEmptyMessage(db, query, 'No dataflow found.'));
  symbolResolutionBefore(db, query);
  console.log(`${result.shortName}  (${result.relativePath})\n`);
  if (result.definitionSites.length > 0) {
    console.log('  ═══ DEFINED AT ═══');
    for (const s of result.definitionSites) console.log(`    ${s.file}:${displayLine(s.line)}`);
  }
  if (result.usageSites.length > 0) {
    console.log('\n  ═══ USED AT ═══');
    for (const s of result.usageSites) console.log(`    ${s.file}:${displayLine(s.line)}  in ${s.enclosingShort}`);
  }
  if (result.producers.length > 0) {
    console.log('\n  ═══ PRODUCERS (feeds into this) ═══');
    for (const p of result.producers) console.log(`    ${p.file}  ${p.shortName}`);
  }
  if (result.consumers.length > 0) {
    console.log('\n  ═══ CONSUMERS (this feeds into) ═══');
    for (const c of result.consumers) console.log(`    ${c.file}  ${c.shortName}`);
  }
});

const handleSlice = budgetedDbCommand('slice', ({ db, args, opts, budget }) => {
  const query = stringArg(args, 0);
  const direction = booleanOptionValue(opts, 'forward') ? 'forward' : 'backward';
  const result = queries.slice(db, query, {
    direction,
    maxDepth: definedNumberOption(opts, 'depth', 3),
    semantic: budget.semantic,
  });
  if (booleanOptionValue(opts, 'json')) {
    printJsonEnvelope('slice', args, opts, withSymbolResolutionJson(db, query, result, 'slice'), {
      analysisBudget: budget.analysisBudget,
    });
    return;
  }
  if (!result) return render.empty(symbolResolutionEmptyMessage(db, query, 'No slice found.'));
  symbolResolutionBefore(db, query);
  console.log(`${result.direction} slice of ${result.shortName}\n`);
  if (result.connectedSymbols.length === 0) {
    console.log('  No connected symbols found.');
    return;
  }
  render.list(result.connectedSymbols, (s) => `  ${s.file}  ${s.shortName}\n    ${s.relationship}`);
  console.log(`\n${result.connectedSymbols.length} connected symbol(s).`);
});

const handleMethods = dbCommand(({ db, args, opts }) => {
  const className = stringArg(args, 0);
  const result = queries.resolveMethods(db, { className });
  if (booleanOptionValue(opts, 'json')) {
    printJsonEnvelope('methods', args, opts, result, {
      coverage: methodsInvocationCoverage(result),
    });
    if (result.kind !== 'matched') process.exitCode = 1;
    return;
  }
  if (result.kind === 'matched') {
    render.list(result.methods, (method) => `  ${displayRange(method.startLine, method.endLine)}  ${method.name}`);
    return;
  }
  render.empty(methodsResolutionFailureMessage(result));
  process.exitCode = 1;
});

function methodsInvocationCoverage(result: queries.MethodsResolution): InvocationCoverage {
  const returned = result.kind === 'matched' ? result.methods.length : 0;
  const resolution: NonNullable<InvocationCoverage['resolution']> =
    result.kind === 'matched'
      ? { state: 'exact', totalCandidates: 1 }
      : result.kind === 'missing'
        ? { state: 'missing', totalCandidates: 0 }
        : { state: 'ambiguous', totalCandidates: result.total };
  return {
    complete: true,
    totalKnown: true,
    returned,
    total: returned,
    omitted: 0,
    resolution,
  };
}

function methodsResolutionFailureMessage(result: Exclude<queries.MethodsResolution, { kind: 'matched' }>): string {
  if (result.kind === 'missing') {
    const base = `No class definition matched '${result.query}'.`;
    return result.suggestions.length > 0 ? `${base} Suggestions: ${result.suggestions.join(', ')}` : base;
  }
  const candidates = result.candidates
    .map((candidate) => `${candidate.relativePath}:${displayLine(candidate.startLine)}`)
    .join(', ');
  return (
    `Class '${result.query}' is ambiguous across ${result.total} definitions (${candidates}). ` +
    'Qualify it with a path or exact SCIP symbol identity.'
  );
}

export const navigationQueryCommandDescriptors: CommandDescriptor[] = [
  ...directNavigationQueryCommandDescriptors,
  listQueryCommand({
    id: 'files',
    command: 'files <pattern>',
    description: 'Find current project files matching a path pattern',
    agent: agentContract(
      'Which current project files match this path pattern?',
      'matching file paths',
      ['pattern'],
      'complete',
    ),
    docs: doc('Navigation', ['scip-query files auth']),
    query: ({ db, args }) => queries.files(db, stringArg(args, 0)),
    format: (r) => r.relativePath,
  }),
  budgetedSectionedQueryCommand({
    id: 'inspect',
    command: 'inspect',
    description: 'Batch related searches, symbols, and source locations into one deduplicated source packet',
    options: [
      option('--search <text>', 'Find this literal text; repeat for related anchors', collectValues, []),
      option(
        '--symbol <symbol>',
        'Add definition and use evidence for this symbol; repeat for related owners',
        collectValues,
        [],
      ),
      option(
        '--at <file:line>',
        'Add the smallest readable source unit around this location; repeat as needed',
        collectValues,
        [],
      ),
      option('-s, --scope <path>', 'Limit literal searches to indexed paths matching this text'),
      option('-C, --context <n>', 'Fallback lines around a match with no syntax unit', parseNonNegativeInteger, 6),
      option('-n, --limit <n>', 'Set matching lines materialized per search (default 12)', parsePositiveInteger),
      option('--max-units <n>', 'Set the ranked packet unit ceiling (default 48)', parsePositiveInteger),
      option(
        '--max-characters <n>',
        'Set the soft displayed-evidence character ceiling (default 60000)',
        parsePositiveInteger,
      ),
      option(
        '--view <view>',
        'Render exact source, or raw/normalized behavior chosen by token cost with complete statement accounting (source or behavior; default source)',
      ),
      option(
        '--unit-lines <n>',
        'Deprecated compatibility option; inspect now returns complete syntax units',
        parsePositiveInteger,
      ),
      option(
        '--total-lines <n>',
        'Deprecated compatibility option; inspect no longer has a packet line budget',
        parsePositiveInteger,
      ),
      option(
        '--include <part>',
        'Add definition, references, callers, callees, dependencies, consumers, or all to every symbol; repeat or comma-separate',
        collectValues,
        [],
      ),
      option('--full', 'Return all selector matches and materialized units, and run unbounded semantic analysis'),
    ],
    budget: 'semantic',
    agent: agentContract(
      'Which related source units across several known text, symbol, or location anchors should be read together?',
      'one ranked, deduplicated semantic packet plus exact selector cardinality and explicit expansion coverage',
      [],
      'bounded',
      'repository',
    ),
    docs: doc('Navigation', [
      "scip-query inspect --search sessionStreamEvents --search work_session_stream_events --search 'agent:work_session' --view behavior",
      'scip-query inspect --symbol appendEvent --symbol publishEvent --include definition,references,callers,callees',
      'scip-query inspect --at src/api.ts:42 --at src/web.tsx:90',
    ]),
    query: ({ db, opts, budget }) => {
      const full = booleanOptionValue(opts, 'full');
      return queries.inspectSource(db, {
        searches: stringArrayOptionValue(opts, 'search'),
        symbols: stringArrayOptionValue(opts, 'symbol'),
        locations: stringArrayOptionValue(opts, 'at'),
        scope: stringOptionValue(opts, 'scope'),
        context: definedNumberOption(opts, 'context', 6),
        searchLimit: inspectSearchLimitOption(opts),
        maxUnits: numberOptionValue(opts, 'maxUnits'),
        maxCharacters: numberOptionValue(opts, 'maxCharacters'),
        view: inspectViewOption(opts),
        full,
        unitLines: numberOptionValue(opts, 'unitLines'),
        totalLines: numberOptionValue(opts, 'totalLines'),
        evidence: {
          parts: selectedEvidenceParts(stringArrayOptionValue(opts, 'include')) ?? [...EVIDENCE_PARTS],
          referenceContext: 4,
          relatedSourceLines: 60,
          semantic: budget.semantic,
        },
      });
    },
    coverage: (result, { budget }) => {
      const omittedMatches = result.searches.reduce((total, search) => total + search.omittedMatches, 0);
      const returned = result.units?.length ?? result.slices.length;
      if (budget.analysisBudget || omittedMatches > 0 || (result.omittedUnits ?? 0) > 0) {
        return {
          complete: false,
          totalKnown: false,
          returned,
        };
      }
      return {
        complete: true,
        totalKnown: true,
        returned,
        total: returned,
        omitted: 0,
      };
    },
    agentResult: (result) => ({
      searches: result.searches,
      evidence: result.evidence.map((item) => ({ query: item.query, kind: item.kind })),
      locations: result.locations,
      returnedUnits: result.units?.length ?? result.slices.length,
      candidateUnits: result.candidateUnits ?? result.candidateSlices,
      omittedUnits: result.omittedUnits ?? result.omittedSlices,
      view: result.view,
      omissionGroups: result.omissionGroups,
    }),
    sections: sourceInspectionSections,
  }),
  sectionedQueryCommand({
    id: 'search',
    command: 'search <text>',
    description: 'Count current project text matches and preview a bounded, recoverable identity and source manifest',
    options: [
      option('-s, --scope <path>', 'Limit the search to current project paths matching this text'),
      option('-C, --context <n>', 'Source lines before and after each match', parseNonNegativeInteger, 6),
      option(
        '-n, --limit <n>',
        'Source windows to materialize; broad identity manifests remain bounded',
        parsePositiveInteger,
        12,
      ),
      option('--full', 'Materialize source for every match after deliberately narrowing broad selectors'),
      option('--regexp', 'Treat the search text as a bounded regular expression'),
      option('-i, --ignore-case', 'Ignore case'),
    ],
    agent: agentContract(
      'Where does this exact text occur in current project text, and which aligned compiler symbol owns each line?',
      'exact cardinality, bounded identities and source, and scope commands that recover withheld matches',
      ['pattern'],
      'bounded',
    ),
    docs: doc('Navigation', ["scip-query search 'eventName'", "scip-query search 'send.*event' --regexp --scope src"]),
    query: ({ db, args, opts }) =>
      queries.searchSource(db, stringArg(args, 0), {
        scope: stringOptionValue(opts, 'scope'),
        context: definedNumberOption(opts, 'context', 6),
        limit: definedLimitOption(opts, 'limit', 12),
        regexp: booleanOptionValue(opts, 'regexp'),
        ignoreCase: booleanOptionValue(opts, 'ignoreCase'),
        ranking: 'structural',
      }),
    emptyMessage: (result) =>
      result.matchingLines === 0
        ? `${sourceSearchTextCoverageComplete(result) ? 'No current project text line' : 'No scanned project text line'} matched '${result.pattern}'.`
        : undefined,
    coverage: (result) => {
      const returned = sourceSearchIdentities(result).length;
      return sourceSearchTextCoverageComplete(result)
        ? { complete: true, totalKnown: true, returned, total: result.matchingLines, omitted: 0 }
        : { complete: false, totalKnown: false, returned };
    },
    agentResult: (result) => ({
      identityCoverage: result.identityCoverage,
      mode: result.mode,
      scannedFiles: result.scannedFiles,
      returnedMatches: sourceSearchRenderedIdentities(result).length,
      totalMatches: result.matchingLines,
      omittedMatches: sourceSearchIdentityCoverage(result, sourceSearchRenderedIdentities(result)).omitted,
      materializedSourceWindows: result.matches.length,
      unmaterializedSourceWindows: result.omittedMatches,
      matchIdentities: sourceSearchRenderedIdentities(result).map(
        (match) => `${match.relativePath}:${displayLine(match.focusLine)}`,
      ),
      scopeHints: result.scopeHints,
      omittedScopeHints: result.omittedScopeHints,
      textCoverage: result.textCoverage,
    }),
    sections: sourceSearchSections,
  }),
  {
    id: 'methods',
    command: 'methods <className>',
    description: 'List methods of one exactly resolved class; ambiguity and missing targets fail explicitly',
    options: withJsonOption(),
    agent: {
      ...agentContract('Which methods belong to this class?', 'method names and line ranges', ['symbol'], 'complete'),
      resultUnits: { kind: 'field', field: 'methods' },
    },
    docs: doc('Navigation'),
    renderShape: 'list',
    handler: handleMethods,
  },
  budgetedSectionedQueryCommand({
    id: 'trace',
    command: 'trace <symbol>',
    description: 'Trace a symbol: definition + all references',
    options: [option('--full', 'Run unbounded semantic analysis on large indexes'), compactOption()],
    budget: 'semantic',
    agent: {
      operation: REPOSITORY_OBSERVATION_OPERATION,
      answers: ['Where is this symbol defined, and everywhere is it referenced?'],
      returns: ['definition sites with source and signature', 'referencing files with line numbers'],
      inputs: ['symbol'],
      coverage: 'bounded',
      contrasts: [
        {
          command: 'refs',
          distinction: 'refs returns reference sites only; trace adds the definition and its source.',
        },
        {
          command: 'call-graph',
          distinction: 'trace lists reference sites flat; call-graph separates incoming callers from outgoing callees.',
        },
      ],
    },
    docs: doc('Navigation', ['scip-query trace parseSymbol']),
    query: ({ db, args, budget }) =>
      queries.qualifiedTraceEvidence(db, stringArg(args, 0), { semantic: budget.semantic }),
    emptyMessage: (result, { db, args }) =>
      result.definitions.length === 0 && result.referencedBy.length === 0
        ? symbolResolutionEmptyMessage(db, stringArg(args, 0), 'No trace rows found.')
        : undefined,
    before: (_result, { db, args }) => symbolResolutionBefore(db, stringArg(args, 0)),
    toJson: (result, { db, args }) => ({ ...symbolResolutionJson(db, stringArg(args, 0)), ...result }),
    coverage: (result, { budget }) => {
      const returned = result.definitions.length + result.referencedBy.length;
      return budget.analysisBudget
        ? { complete: false, totalKnown: false, returned }
        : { complete: true, totalKnown: true, returned, total: returned, omitted: 0 };
    },
    agentResult: (result) => ({
      definitionCount: result.definitions.length,
      referenceCount: result.referencedBy.length,
      definitionIdentities: result.definitions.map(
        (definition) => `${definition.relativePath}:${definition.startLine}-${definition.endLine}`,
      ),
      referenceIdentities: result.referencedBy.map((reference) => `${reference.relativePath}:${reference.line}`),
    }),
    sections: traceSections,
  }),
  budgetedSectionedQueryCommand({
    id: 'evidence',
    command: 'evidence <symbol>',
    description: 'Compose related source for one exact symbol in a single evidence view',
    options: [
      option(
        '--include <part>',
        'Add definition, references, callers, callees, dependencies, consumers, or all; repeat or comma-separate',
        collectValues,
        [],
      ),
      option('-C, --context <n>', 'Source lines before and after each reference', parseNonNegativeInteger, 2),
      option('--related-source-lines <n>', 'Maximum source lines for each caller or callee', parsePositiveInteger, 80),
      option('--full', 'Run unbounded semantic analysis on large indexes'),
    ],
    budget: 'semantic',
    agent: {
      operation: REPOSITORY_OBSERVATION_OPERATION,
      answers: [
        'Where is this exact symbol defined, and what source uses it?',
        'Which related callers, callees, dependencies, or consumers must be read together?',
      ],
      returns: [
        'definition source',
        'deduplicated reference-centered source windows',
        'selected related symbol source and file relationships',
        'explicit ambiguity failure with exact rerun commands',
      ],
      inputs: ['symbol'],
      coverage: 'bounded',
    },
    docs: doc('Navigation', [
      'scip-query evidence appendEvent',
      'scip-query evidence appendEvent --include definition,references,callers,callees',
    ]),
    query: ({ db, args, opts, budget }) =>
      queries.qualifiedEvidence(db, stringArg(args, 0), {
        parts: selectedEvidenceParts(stringArrayOptionValue(opts, 'include')),
        referenceContext: definedNumberOption(opts, 'context', 2),
        relatedSourceLines: definedNumberOption(opts, 'relatedSourceLines', 80),
        semantic: budget.semantic,
      }),
    emptyMessage: (result) => evidenceFailureMessage(result),
    before: (result) => {
      if (result.kind !== 'matched') process.exitCode = 1;
    },
    coverage: (result, { budget }) => {
      if (result.kind !== 'matched') return { complete: true, totalKnown: true, returned: 0, total: 0, omitted: 0 };
      const returned =
        (result.definition ? 1 : 0) +
        result.referenceWindows.reduce((total, window) => total + window.references.length, 0) +
        result.callers.length +
        result.callees.length +
        result.dependencies.length +
        result.consumers.length;
      return budget.analysisBudget
        ? { complete: false, totalKnown: false, returned }
        : { complete: true, totalKnown: true, returned, total: returned, omitted: 0 };
    },
    agentResult: (result) =>
      result.kind === 'matched'
        ? {
            symbol: result.symbol,
            file: result.file,
            parts: result.parts,
            referenceSites: result.referenceWindows.reduce((total, window) => total + window.references.length, 0),
            sourceWindows: result.referenceWindows.length,
            callers: result.callers.length,
            callees: result.callees.length,
            dependencies: result.dependencies.length,
            consumers: result.consumers.length,
          }
        : result,
    sections: evidenceSections,
  }),
  listQueryCommand({
    id: 'deps',
    command: 'deps <file>',
    description: 'Files this file depends on (internal)',
    agent: agentContract(
      'Which internal files does this file depend on?',
      'dependency file paths',
      ['file'],
      'complete',
    ),
    docs: doc('Navigation'),
    query: ({ db, args }) => queries.deps(db, stringArg(args, 0)),
    format: (r) => r.relativePath,
  }),
  listQueryCommand({
    id: 'rdeps',
    command: 'rdeps <file>',
    description: 'Files that depend on this file/module',
    agent: agentContract(
      'Which internal files depend on this file?',
      'reverse-dependency file paths',
      ['file'],
      'complete',
    ),
    docs: doc('Navigation'),
    query: ({ db, args }) => queries.rdeps(db, stringArg(args, 0)),
    format: (r) => r.relativePath,
  }),
  sectionedQueryCommand({
    id: 'system',
    command: 'system <module>',
    description: 'Full module map: files, symbols, deps in/out',
    options: [compactOption()],
    agent: {
      operation: REPOSITORY_OBSERVATION_OPERATION,
      answers: ['What is in this module?', 'What does this module depend on, and what depends on it?'],
      returns: [
        'module file paths',
        'exported symbols with line ranges',
        'internal dependencies',
        'reverse dependencies',
      ],
      inputs: ['module'],
      // No budget and no row cap: every section is the whole set.
      coverage: 'complete',
      contrasts: [
        {
          command: 'surface',
          distinction: 'system lists everything the module exports; surface lists only what consumers actually use.',
        },
        { command: 'outline', distinction: 'system is module-scoped; outline covers a single file.' },
      ],
    },
    docs: doc('Navigation', ['scip-query system queries']),
    query: ({ db, args }) => queries.system(db, stringArg(args, 0)),
    coverage: (result) => {
      const returned =
        result.files.length + result.symbols.length + result.dependsOn.length + result.dependedOnBy.length;
      return { complete: true, totalKnown: true, returned, total: returned, omitted: 0 };
    },
    agentResult: (result) => ({
      counts: {
        files: result.files.length,
        symbols: result.symbols.length,
        dependencies: result.dependsOn.length,
        consumers: result.dependedOnBy.length,
      },
      files: result.files,
      dependsOn: result.dependsOn,
      dependedOnBy: result.dependedOnBy,
      detail: {
        location: 'result',
        symbolUnits: 'result.symbols contains every exported symbol with its line range',
      },
    }),
    sections: (result) => [
      { title: 'FILES', rows: result.files },
      {
        title: 'EXPORTED SYMBOLS',
        rows: result.symbols.map((s) => `  ${displayRange(s.startLine, s.endLine)}  ${s.shortName}`),
      },
      { title: 'DEPENDS ON (internal)', rows: result.dependsOn.map((d) => `  ${d}`) },
      { title: 'DEPENDED ON BY', rows: result.dependedOnBy.map((d) => `  ${d}`) },
    ],
  }),
  listQueryCommand({
    id: 'surface',
    command: 'surface <module>',
    description: 'What symbols consumers actually use from this module',
    agent: agentContract(
      'Which exported symbols do external consumers actually use?',
      'consumer paths and consumed symbol identities',
      ['module'],
      'complete',
    ),
    docs: doc('Navigation'),
    query: ({ db, args }) => queries.surface(db, stringArg(args, 0)),
    format: (r) => `  ${r.consumer} → ${r.shortName}`,
  }),
  {
    id: 'imports',
    command: 'imports <file>',
    description: 'What symbols does this file import?',
    agent: agentContract(
      'Which symbols does this file import?',
      'imported symbol identities and source files',
      ['file'],
      'bounded',
    ),
    options: withJsonOption([option('--full', 'Run unbounded semantic analysis on large indexes')]),
    budget: 'semantic',
    renderShape: 'list',
    docs: doc('Navigation'),
    handler: handleImports,
  },
  listQueryCommand({
    id: 'imported-by',
    command: 'imported-by <symbol>',
    description: 'Which files import this symbol?',
    agent: agentContract('Which files import this symbol?', 'importing file paths', ['symbol'], 'complete'),
    docs: doc('Navigation'),
    query: ({ db, args }) => queries.importedBy(db, stringArg(args, 0)),
    format: (r) => `  ${r.fromFile}`,
  }),
  listQueryCommand({
    id: 'members',
    command: 'members <symbol>',
    description: 'All children of a symbol (methods, fields, nested types)',
    agent: agentContract(
      'Which members or nested symbols belong to this symbol?',
      'child symbol identities, kinds, and ranges',
      ['symbol'],
      'complete',
    ),
    docs: doc('Navigation'),
    query: ({ db, args }) => queries.members(db, stringArg(args, 0)),
    format: (r) => `  ${displayRange(r.startLine, r.endLine)}  [${r.kind}]  ${r.shortName}`,
    before: (_rows, { db, args }) => symbolResolutionBefore(db, stringArg(args, 0)),
    emptyMessage: ({ db, args }) => symbolResolutionEmptyMessage(db, stringArg(args, 0), 'No child symbols found.'),
    toJson: (rows, { db, args }) => withSymbolResolutionJson(db, stringArg(args, 0), rows, 'members'),
  }),
  listQueryCommand({
    id: 'by-kind',
    command: 'by-kind <kind>',
    description: 'Find symbols by SCIP kind (class, interface, enum, function, etc.)',
    agent: agentContract(
      'Which symbols have this SCIP kind?',
      'symbol identities, kinds, files, and ranges',
      ['pattern'],
      'bounded',
    ),
    options: [
      option('-s, --scope <path>', 'Limit to files matching path'),
      option('-n, --limit <n>', 'Number of results', parseInteger, 100),
      option('--full', 'Run unbounded analysis on large indexes'),
    ],
    docs: doc('Navigation'),
    query: ({ db, args, opts }) =>
      queries.byKind(db, stringArg(args, 0), {
        scope: stringOptionValue(opts, 'scope'),
        limit: definedLimitOption(opts, 'limit', 100),
      }),
    format: (r) => `  ${displayPathRange(r.relativePath, r.startLine, r.endLine)}  [${r.kindName}]  ${r.shortName}`,
    emptyMessage: ({ args }) =>
      `No symbols found for kind "${stringArg(args, 0)}". Use "kind-counts" to see available kinds.`,
    after: (rows) => console.log(`\n${rows.length} symbol(s)`),
  }),
  tableQueryCommand({
    id: 'kind-counts',
    command: 'kind-counts',
    description: 'Histogram of symbol kinds in the codebase',
    agent: agentContract(
      'How many indexed symbols exist for each kind?',
      'symbol-kind counts',
      [],
      'complete',
      'repository',
    ),
    options: [option('-s, --scope <path>', 'Limit to files matching path')],
    docs: doc('Navigation'),
    headers: ['count', 'kind'],
    query: ({ db, opts }) => queries.kindCounts(db, { scope: stringOptionValue(opts, 'scope') }),
    format: (r) => `  ${String(r.count).padStart(5)}  ${r.kindName} (${r.kind})`,
  }),
  listQueryCommand({
    id: 'hierarchy',
    command: 'hierarchy <symbol>',
    description: "Show a symbol's ancestry chain (method → class → module)",
    agent: agentContract(
      'What lexical ownership chain contains this symbol?',
      'ancestor symbol identities and depths',
      ['symbol'],
      'complete',
    ),
    docs: doc('Navigation'),
    query: ({ db, args }) => queries.hierarchy(db, stringArg(args, 0)),
    format: (node) => `${'  '.repeat(node.depth)}${node.shortName}`,
    before: (_rows, { db, args }) => symbolResolutionBefore(db, stringArg(args, 0)),
    emptyMessage: ({ db, args }) => symbolResolutionEmptyMessage(db, stringArg(args, 0), 'Symbol not found.'),
    toJson: (rows, { db, args }) => withSymbolResolutionJson(db, stringArg(args, 0), rows, 'hierarchy'),
  }),
  {
    id: 'dataflow',
    command: 'dataflow <symbol>',
    description: 'Reference-level dataflow: definition sites, usage sites, producers, consumers',
    agent: agentContract(
      'What defines, uses, produces, and consumes this symbol?',
      'definition sites, usage sites, producer symbols, and consumer symbols',
      ['symbol'],
      'bounded',
    ),
    options: withJsonOption([option('--full', 'Run unbounded semantic analysis on large indexes')]),
    budget: 'semantic',
    renderShape: 'custom',
    docs: doc('Navigation'),
    handler: handleDataflow,
  },
  {
    id: 'slice',
    command: 'slice <symbol>',
    description: 'Reference-level program slice: what affects this (backward) or what this affects (forward)',
    agent: agentContract(
      'What transitively affects this symbol, or what does it affect?',
      'connected symbols with relationship and depth',
      ['symbol'],
      'bounded',
    ),
    options: withJsonOption([
      option('--forward', 'Forward slice (what does this affect). Default is backward.'),
      option('--depth <n>', 'Max transitive depth for backward slice', parseInteger, 3),
      option('--full', 'Run unbounded semantic analysis on large indexes'),
    ]),
    budget: 'semantic',
    renderShape: 'custom',
    docs: doc('Navigation'),
    handler: handleSlice,
  },
];
