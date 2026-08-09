import * as queries from '../../queries/index.js';
import { REPOSITORY_OBSERVATION_OPERATION } from '../command-operation.js';
import type { CommandDescriptor, InvocationCoverage } from '../command-kit/command-descriptor-types.js';
import {
  agentContract,
  collectValues,
  compactOption,
  doc,
  graphProjectionSemanticContract,
  locatorSemanticContract,
  option,
  parseInteger,
  parseNonNegativeInteger,
  parsePositiveInteger,
  withJsonOption,
  sourceReadSemanticContract,
} from '../command-kit/command-spec-builders.js';
import { GRAPH_EVIDENCE_FAMILIES } from '../../domain/graph-exploration-contract.js';
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
import { renderSessionEvidence, renderSourceEvidence } from '../source-emission-session.js';
import {
  symbolResolutionJson,
  symbolResolutionBefore,
  symbolResolutionEmptyMessage,
  withSymbolResolutionJson,
} from './symbol-resolution.js';
import { directNavigationQueryCommandDescriptors } from './direct-navigation.js';
import {
  SOURCE_INSPECTION_MAX_SELECTORS,
  SOURCE_INSPECTION_SAFE_CHARACTERS,
} from '../../domain/source-inspection-limits.js';
import { assertNavigationDetailAllowed, stageNavigationMapCommands } from '../navigation-session.js';

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

interface EvidenceGraphPacket {
  kind: 'graph-packet';
  graph: queries.GraphEvidenceResult;
  source: queries.QualifiedEvidenceResult[];
  sourceRecovery: {
    parts: queries.EvidencePart[];
    selectors: number;
    command: string;
  } | null;
}

type EvidenceCommandResult = queries.QualifiedEvidenceResult | EvidenceGraphPacket;

const INSPECTION_EVIDENCE_CHANNELS = [
  'search',
  'exact-source',
  'definition',
  'caller',
  'callee',
  'production-reference',
  'test-reference',
  'dependency',
  'consumer',
] as const satisfies readonly queries.SourceInspectionEvidenceChannel[];

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

function selectedGraphEvidenceFamilies(values: readonly string[]): queries.GraphEvidenceFamily[] | undefined {
  if (values.length === 0) return undefined;
  const expanded = values
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean);
  if (expanded.includes('all')) return [...queries.GRAPH_EVIDENCE_FAMILIES];
  const invalid = expanded.filter(
    (value) => !queries.GRAPH_EVIDENCE_FAMILIES.includes(value as queries.GraphEvidenceFamily),
  );
  if (invalid.length > 0) {
    throw new Error(
      `Unknown graph evidence family: ${invalid.join(', ')}. Use ${queries.GRAPH_EVIDENCE_FAMILIES.join(', ')}, or all.`,
    );
  }
  return [...new Set(expanded as queries.GraphEvidenceFamily[])];
}

function graphEvidenceView(value: string | undefined): queries.GraphEvidenceView | undefined {
  if (value === undefined) return undefined;
  if (queries.GRAPH_EVIDENCE_VIEWS.includes(value as queries.GraphEvidenceView)) {
    return value as queries.GraphEvidenceView;
  }
  throw new Error(`Unknown evidence view: ${value}. Use ${queries.GRAPH_EVIDENCE_VIEWS.join(', ')}.`);
}

function graphEvidenceDirection(value: string | undefined): queries.GraphProjectionDirection | undefined {
  if (value === undefined) return undefined;
  if (['incoming', 'outgoing', 'both'].includes(value)) return value as queries.GraphProjectionDirection;
  throw new Error(`Unknown evidence direction: ${value}. Use incoming, outgoing, or both.`);
}

function selectedGraphEvidenceSubtypes(values: readonly string[]): string[] | undefined {
  const selected = [
    ...new Set(
      values
        .flatMap((value) => value.split(','))
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
  return selected.length > 0 ? selected : undefined;
}

function inspectionEvidenceBudgets(values: readonly string[]): queries.SourceInspectionEvidenceBudgets | undefined {
  if (values.length === 0) return undefined;
  const budgets: queries.SourceInspectionEvidenceBudgets = {};
  for (const entry of values
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean)) {
    const separator = entry.lastIndexOf('=');
    const channel = entry.slice(0, separator) as queries.SourceInspectionEvidenceChannel;
    const rawLimit = entry.slice(separator + 1);
    if (separator <= 0 || !INSPECTION_EVIDENCE_CHANNELS.includes(channel)) {
      throw new Error(
        `Unknown inspect evidence budget '${entry}'. Use channel=n with ${INSPECTION_EVIDENCE_CHANNELS.join(', ')}.`,
      );
    }
    if (Object.hasOwn(budgets, channel)) throw new Error(`Duplicate inspect evidence budget: ${channel}.`);
    if (!/^\d+$/u.test(rawLimit)) {
      throw new Error(`Inspect evidence budget ${channel} must be a non-negative safe integer; received ${rawLimit}.`);
    }
    const limit = Number(rawLimit);
    if (!Number.isSafeInteger(limit)) {
      throw new Error(`Inspect evidence budget ${channel} must be a non-negative safe integer; received ${rawLimit}.`);
    }
    budgets[channel] = limit;
  }
  return budgets;
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

function anchorDiscoverySections(result: queries.AnchorDiscoveryResult): ReportSection[] {
  const groupRows = result.groups.flatMap((group, index) => {
    const rootLabel =
      group.kind === 'shared-callee-owners'
        ? 'shared callee'
        : group.kind === 'cross-boundary-flow' || group.kind === 'parallel-paths'
          ? 'basis root'
          : 'root';
    const renderedRoots = group.roots.slice(0, 6);
    const rootRows = renderedRoots.map((root) => {
      const terms = root.matches.map((match) => `${match.term}[${match.sources.join('+')}]`).join(', ');
      return `    ${rootLabel} ${root.label} — ${root.file}:${displayLine(root.line)} — ${terms}`;
    });
    const relationRows = group.relations.map(
      (relation) =>
        `    ${relation.fromLabel} → ${relation.toLabel} [${relation.kind}; ${relation.strength}; ${relation.evidence}; depth ${relation.depth}${relation.runtimeBoundaryKey ? `; ${relation.runtimeBoundaryKey}` : ''}]`,
    );
    return [
      `  [${index + 1}] ${group.kind}; terms: ${group.matchedTerms.join(', ') || '(structural only)'}`,
      ...(group.kind === 'shared-callee-owners'
        ? [
            `    map owners: ${group.keyAnchors.map((anchor) => anchor.label).join(', ')}`,
            ...(group.omittedCandidateOwners.length > 0
              ? [
                  `    additional candidate owners: ${group.omittedCandidateOwners.map((owner) => owner.label).join(', ')}`,
                  ...group.ownerRecoveryCommands.map(
                    (command) => `    additional owner map if those candidates can change the answer: ${command}`,
                  ),
                ]
              : []),
          ]
        : group.kind === 'cross-boundary-flow' || group.kind === 'parallel-paths'
          ? [
              `    map anchors: ${group.keyAnchors.map((anchor) => anchor.label).join(', ')}`,
              ...(group.kind === 'parallel-paths'
                ? [
                    `    shared path vocabulary: ${group.parallelSharedPathTerms?.join(', ') || '(none)'}`,
                    `    causal evidence on ${group.parallelConnectedSides ?? 0}/2 independently named path(s); matched orchestration roots on ${group.parallelOrchestrationSides ?? 0}/2; no cross-path edge is claimed.`,
                  ]
                : []),
              ...group.upstreamEntries.map(
                (entry) =>
                  `    upstream entry: ${entry.name} — ${entry.file}:${displayLine(entry.line)}; if command preconditions can change the answer, include this location in the one batched gap inspect after the map.`,
              ),
            ]
          : []),
      ...rootRows,
      ...(group.roots.length > renderedRoots.length
        ? [`    ... ${group.roots.length - renderedRoots.length} additional basis owner(s) retained in the result.`]
        : []),
      ...relationRows,
      ...(group.omittedRelations > 0
        ? [`    ... ${group.omittedRelations} additional relationship(s) withheld from this compact view.`]
        : []),
      `    next abstraction (run to completion before any inspect): ${group.systemMapCommand}`,
    ];
  });
  return [
    {
      title: 'REQUIRED NEXT STEP',
      rows: [
        '  Choose one evidence-grounded anchor set below and run its exact next-abstraction system-map command to transport completion.',
        '  inspect, code, and evidence are intentionally unavailable until that map completes.',
      ],
    },
    {
      title: 'NORMALIZED REPOSITORY VOCABULARY',
      rows: [
        `  matched: ${result.matchedTerms.join(', ') || '(none)'}`,
        `  unmatched: ${result.unmatchedTerms.join(', ') || '(none)'}`,
      ],
    },
    {
      title: `EVIDENCE-GROUNDED ANCHOR SETS (${result.groups.length} SHOWN)`,
      rows: groupRows,
    },
    {
      title: 'ANCHOR DISCOVERY COVERAGE',
      rows: [
        `  Repository scan: ${result.scannedFiles} current text file(s), ${result.scannedBytes.toLocaleString()} byte(s).`,
        `  Lexical owners: ${result.candidateRootCount}; structurally analyzed: ${result.analyzedRootCount}; lower-ranked owners not graph-expanded: ${result.omittedRootCount}.`,
        `  Displayed anchor sets: ${result.groups.length}; withheld sets or unanalyzed roots: ${result.omittedGroupCount}.`,
        '  cross-boundary-flow joins otherwise separate call groups only when an indexed runtime producer→consumer link and bounded downstream calls connect them; parallel-paths batches disconnected regions only when the query names distinct path vocabulary shared by those regions and does not claim a causal edge; connected-flow follows calls forward from matched owners; shared-callee-owners finds callable owners that converge on common callees without claiming those callees are effects.',
        '  Ranking uses repository vocabulary, compiler ownership, and bounded call connectivity; it does not establish task relevance.',
        '  Selection gate: reject a set whose roots and matched terms omit an object, branch, or stage named by a material claim. Connectivity cannot make a partial set eligible. Among sets that cover every named part, use the first ranked eligible set; use parallel-paths when no connected-flow covers them together.',
        '  Anchor roots are locator evidence, not behavior evidence. Select one set, run its next-abstraction command to transport completion, and only then decide whether source inspection is necessary. Never run a map and inspect concurrently.',
        ...(result.recoveryCommand
          ? [
              `  Expand the ranked manifest only if the shown sets cannot establish the requested flow: ${result.recoveryCommand}`,
            ]
          : ['  Every candidate owner was structurally analyzed and every resulting anchor set was shown.']),
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
  const files = result.fileCoverage ?? [];
  const identitiesByFile = new Map<string, queries.SourceSearchIdentity[]>();
  for (const identity of sourceSearchIdentities(result)) {
    const rows = identitiesByFile.get(identity.relativePath) ?? [];
    rows.push(identity);
    identitiesByFile.set(identity.relativePath, rows);
  }
  const maxScopeDepth = files.reduce((maximum, file) => {
    const directories = file.relativePath.split('/').slice(0, -1);
    return Math.max(maximum, directories.length);
  }, 1);
  const manifestAtDepth = (depth: number): string[] => {
    const byScope = new Map<string, queries.SourceSearchFileCoverage[]>();
    for (const file of files) {
      const directories = file.relativePath.split('/').slice(0, -1);
      const scope = directories.length === 0 ? '<root>' : directories.slice(0, depth).join('/');
      const rows = byScope.get(scope) ?? [];
      rows.push(file);
      byScope.set(scope, rows);
    }
    return [...byScope]
      .sort(([left], [right]) => left.localeCompare(right))
      .flatMap(([scope, scopeFiles]) => {
        const orderedFiles = [...scopeFiles].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
        const matchingLines = orderedFiles.reduce((total, file) => total + file.matchingLines, 0);
        if (orderedFiles.length > 12) {
          const recovery =
            scope === '<root>'
              ? `scip-query search ${shellArgument(result.pattern)}`
              : `scip-query search ${shellArgument(result.pattern)} --scope ${shellArgument(scope)}`;
          return [
            `    ${scope}: ${matchingLines} matching line(s) across ${orderedFiles.length} file(s); expand this structural region with ${recovery}`,
          ];
        }
        return [
          `    ${scope}: ${matchingLines} matching line(s) across ${orderedFiles.length} file(s)`,
          ...orderedFiles.map((file) => {
            const owners = [...(identitiesByFile.get(file.relativePath) ?? [])]
              .sort((left, right) => left.focusLine - right.focusLine)
              .filter(
                (identity, index, rows) =>
                  rows.findIndex(
                    (candidate) =>
                      candidate.ownerSymbol === identity.ownerSymbol &&
                      candidate.ownerStartLine === identity.ownerStartLine,
                  ) === index,
              );
            const visibleOwners = owners.slice(0, 2).map((identity) => {
              const label = identity.ownerShort ?? '<file scope>';
              const line = displayLine(identity.ownerStartLine ?? identity.focusLine);
              return `${label} @ ${line}`;
            });
            const omittedOwners = Math.max(0, owners.length - visibleOwners.length);
            const ownerSummary =
              visibleOwners.length === 0
                ? ''
                : `; exact starting construct(s): ${visibleOwners.join('; ')}${
                    omittedOwners > 0
                      ? `; +${omittedOwners} more via scip-query outline ${shellArgument(file.relativePath)}`
                      : ''
                  }`;
            return `      ${file.relativePath}: ${file.matchingLines} match(es)${ownerSummary}`;
          }),
        ];
      });
  };
  let manifestDepth = maxScopeDepth;
  let manifestRows = manifestAtDepth(manifestDepth);
  while (manifestDepth > 1 && manifestRows.join('\n').length > 12_000) {
    manifestDepth -= 1;
    manifestRows = manifestAtDepth(manifestDepth);
  }
  return [
    '  Broad selector: identity enumeration stopped before output transport; there is no cursor to drain.',
    ...(manifestRows.length > 0
      ? [
          `  Complete structural file manifest at directory depth ${manifestDepth}; small regions expose exact starting constructs and large regions remain recoverable as one scope:`,
          ...manifestRows,
        ]
      : []),
    '  Choose explicit file/line roots from this manifest or narrow one structural region; the ordering does not infer task relevance.',
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

function inspectBehaviorFallbackCommand(opts: Readonly<Record<string, unknown>>): string {
  const parts = ['scip-query inspect'];
  for (const search of stringArrayOptionValue(opts, 'search')) parts.push(`--search ${shellArgument(search)}`);
  for (const symbol of stringArrayOptionValue(opts, 'symbol')) parts.push(`--symbol ${shellArgument(symbol)}`);
  for (const location of stringArrayOptionValue(opts, 'at')) parts.push(`--at ${shellArgument(location)}`);
  const scope = stringOptionValue(opts, 'scope');
  if (scope) parts.push(`--scope ${shellArgument(scope)}`);
  parts.push('--view behavior');
  return parts.join(' ');
}

function enforceInspectSourceMaterializationContract(
  result: queries.SourceInspectionResult,
  opts: Readonly<Record<string, unknown>>,
): void {
  if (
    result.view !== 'source' ||
    booleanOptionValue(opts, 'allowLargeSource') ||
    (result.returnedCharacters ?? 0) <= SOURCE_INSPECTION_SAFE_CHARACTERS
  ) {
    return;
  }
  throw new Error(
    [
      'INSPECT SOURCE PACKET REFUSED',
      `${result.returnedCharacters ?? 0} exact source character(s) across ${result.units?.length ?? 0} selected unit(s) exceed the ${SOURCE_INSPECTION_SAFE_CHARACTERS}-character safe materialization ceiling.`,
      'No partial source was emitted.',
      `Read the same constructs with complete statement accounting: ${inspectBehaviorFallbackCommand(opts)}`,
      'Narrow to smaller exact selectors, or rerun with --allow-large-source only when the omitted syntax itself can change the decision.',
    ].join('\n'),
  );
}

function enforceInspectBehaviorFocusContract(
  result: queries.SourceInspectionResult,
  opts: Readonly<Record<string, unknown>>,
): void {
  if (result.view !== 'behavior' || booleanOptionValue(opts, 'allowLargeBehavior')) return;
  const oversizedOmissions = (result.omissionGroups ?? []).filter(
    (group) =>
      group.sourceCharacters > SOURCE_INSPECTION_SAFE_CHARACTERS &&
      group.roles.some((role) => role === 'location' || role === 'definition'),
  );
  if (oversizedOmissions.length === 0 && (result.returnedViewCharacters ?? 0) <= SOURCE_INSPECTION_SAFE_CHARACTERS) {
    return;
  }
  const broadAnchors = oversizedOmissions
    .flatMap((group) => group.anchors)
    .map((anchor) => `${anchor.relativePath}:${displayLine(anchor.line)}`);
  const selectors = broadAnchors.length > 0 ? broadAnchors.join(', ') : stringArrayOptionValue(opts, 'at').join(', ');
  throw new Error(
    [
      'INSPECT BEHAVIOR FOCUS REQUIRED',
      `The selector set resolves to behavioral constructs above the ${SOURCE_INSPECTION_SAFE_CHARACTERS}-character evidence ceiling${selectors ? ` (${selectors})` : ''}.`,
      'No partial behavior was emitted, and this refusal does not establish an exploration obligation.',
      'Use one or more interior file:line locations already visible in connected behavior, and batch only the named gaps. Do not use --full to turn a broad construct into a focus.',
      'Use --allow-large-behavior only when every statement in the construct can change the decision.',
    ].join('\n'),
  );
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
  const causalFrontierRows = sourceInspectionCausalFrontierRows(result);
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
        ...(packet.channels ? [`  Evidence channels: ${renderInspectionChannelCoverage(packet.channels)}.`] : []),
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
        `  ${result.stoppingSummary.queryStatus ?? result.stoppingSummary.status}: ${result.stoppingSummary.guidance}`,
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
    { title: 'NEXT CAUSAL FRONTIER', rows: causalFrontierRows, skipIfEmpty: true },
    {
      title: 'PACKET COVERAGE',
      rows: packetRows,
    },
    { title: 'QUERY COMPLETION', rows: stoppingRows, skipIfEmpty: true },
  ];
}

function sourceInspectionCausalFrontierRows(result: queries.SourceInspectionResult): string[] {
  const frontier = result.causalFrontier;
  if (!frontier || frontier.candidateAnchors === 0) return [];
  const selected = frontier.anchors.filter((anchor) => anchor.alternativeCount === 1);
  const rows = [
    `  ${selected.length}/${frontier.candidateAnchors} bounded downstream target(s) are uniquely resolved and visible; these targets are outside the materialized constructs, not evidence already inspected.`,
  ];
  for (const anchor of selected) {
    const target = anchor.alternatives[0]!;
    const signals = anchor.callsite.signals.length > 0 ? ` [${anchor.callsite.signals.join(',')}]` : '';
    rows.push(
      `  ${anchor.direction ?? 'downstream'} ${anchor.causalRole ?? 'callee'} from ${anchor.fromLabel} at ${anchor.callsite.file}:${displayLine(anchor.callsite.line)}${signals}`,
      `    ${target.label} — ${target.file}:${displayLine(target.line)}`,
    );
  }

  const locations = uniqueInspectionLocations([
    ...(result.omissionGroups ?? []).flatMap((group) =>
      group.anchors.map((anchor) => ({ file: anchor.relativePath, line: anchor.line })),
    ),
    ...selected.map((anchor) => ({ file: anchor.alternatives[0]!.file, line: anchor.alternatives[0]!.line })),
  ]).slice(0, SOURCE_INSPECTION_MAX_SELECTORS);
  if (locations.length > 0) {
    rows.push(
      `  If any listed target or withheld requested construct remains material, run this one final recovery batch before answering: scip-query inspect ${locations
        .map((location) => `--at ${shellArgument(`${location.file}:${displayLine(location.line)}`)}`)
        .join(' ')} --view behavior`,
    );
  }
  if (frontier.omittedAnchors > 0) {
    rows.push(
      `  ${frontier.omittedAnchors} additional downstream target(s) remain accounted in the frontier; use the printed remaining inspect commands only for a named unresolved fact.`,
    );
  }
  return rows;
}

function uniqueInspectionLocations(
  locations: readonly { file: string; line: number }[],
): Array<{ file: string; line: number }> {
  const unique = new Map<string, { file: string; line: number }>();
  for (const location of locations) unique.set(`${location.file}\0${location.line}`, location);
  return [...unique.values()];
}

function renderInspectionRoleCounts(counts: Partial<Record<queries.SourceInspectionUnitRole, number>>): string {
  return Object.entries(counts)
    .map(([role, count]) => `${role}=${count}`)
    .join(', ');
}

function renderInspectionChannelCoverage(
  channels: Readonly<Record<queries.SourceInspectionEvidenceChannel, queries.SourceInspectionChannelCoverage>>,
): string {
  return INSPECTION_EVIDENCE_CHANNELS.filter(
    (channel) => channels[channel].candidateUnits > 0 || channels[channel].omittedUnits > 0,
  )
    .map((channel) => {
      const coverage = channels[channel];
      const limit = coverage.maxUnits === Number.MAX_SAFE_INTEGER ? 'unbounded' : String(coverage.maxUnits);
      return `${channel} ${coverage.returnedUnits}/${coverage.candidateUnits} (limit ${limit})`;
    })
    .join('; ');
}

function sourceInspectionUnitRow(unit: queries.SourceInspectionUnit): string {
  switch (unit.kind) {
    case 'source': {
      const owner = unit.ownerShort ? `  in ${unit.ownerShort}` : '';
      if (unit.behavior) {
        const coverage = unit.behavior.coverage;
        const evidenceRows = [
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
        return [
          `  ${displayPathRange(unit.relativePath, unit.startLine, unit.endLine)}${owner}`,
          `    roles: ${unit.roles.join(', ')}; selected by ${unit.reasons.join(', ')}`,
          renderSessionEvidence({
            kind: 'unit',
            identity: `inspect-behavior:${unit.relativePath}:${unit.startLine}:${unit.endLine}`,
            content: evidenceRows.join('\n'),
            label: unit.ownerShort ?? `${unit.relativePath}:${displayLine(unit.startLine)}`,
            indent: '    ',
          }),
        ].join('\n');
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
    `    channel: ${group.channel ?? 'unclassified'}; roles: ${group.roles.join(', ')}; behavior: ${group.behaviorSignals.join(', ') || 'not summarized'}`,
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

function evidenceCommandSections(result: EvidenceCommandResult): ReportSection[] {
  if (result.kind !== 'graph-packet') return evidenceSections(result);
  const selection = result.graph.selection ?? {
    direction: 'both',
    subtypes: [],
    connecting: false,
    inventoryOnly: false,
    foldIds: [],
  };
  const selectionRows = [
    `  direction=${selection.direction}; subtypes=${selection.subtypes.length > 0 ? selection.subtypes.join(',') : 'all'}; ` +
      `operation=${selection.connecting ? 'connecting' : 'reachability'}; materialization=${selection.inventoryOnly ? 'inventory-only' : selection.foldIds.length > 0 ? `folds(${selection.foldIds.join(',')})` : 'edges'}`,
  ];
  const targetRows = result.graph.targets.map((target) => {
    const omitted = target.omittedCandidates > 0 ? `; ${target.omittedCandidates} candidate(s) omitted` : '';
    return `  [${target.status}] ${target.kind} ${target.query}${omitted}`;
  });
  const relationshipRows = queries.GRAPH_EVIDENCE_FAMILIES.flatMap((family) => {
    const edges = result.graph.edges.filter((edge) => edge.family === family);
    if (edges.length === 0) return [];
    return [`  ${family} (${edges.length})`, ...edges.map((edge) => `    ${graphEvidenceEdgeRow(edge)}`)];
  });
  const inventoryRows = (result.graph.inventory ?? []).map(
    (row) => `  ${row.family}/${row.subtype}: incoming=${row.incoming}; outgoing=${row.outgoing}; both=${row.both}`,
  );
  const foldRows = graphEvidenceFoldRows(result.graph.folds ?? []);
  const coverage = result.graph.coverage;
  const coverageRows = [
    `  ${coverage.status}: ${coverage.returnedEdges}/${coverage.eligibleEdges} materialized relationship(s); ${coverage.matchedEdges ?? coverage.eligibleEdges} matched the projection; depth <= ${coverage.maxDepth}; ${coverage.frontierGroups} accounted frontier group(s); ${coverage.unsupportedFrontiers} unsupported frontier(s).`,
    `  ${coverage.explanation}`,
    ...(coverage.omittedEdges > 0 && foldRows.length === 0
      ? [
          `  Expand the same selectors only if an omitted relationship is material: add --max-edges ${coverage.eligibleEdges}.`,
        ]
      : []),
    ...coverage.blindSpots.slice(0, 3).map((blindSpot) => `  Blind spot: ${blindSpot}`),
    ...(coverage.blindSpots.length > 3
      ? [`  ${coverage.blindSpots.length - 3} additional blind spot(s) remain in --json.`]
      : []),
  ];
  const sourceSections = result.source.flatMap((item) => {
    if (item.kind !== 'matched') {
      return [{ title: `SOURCE SELECTOR — ${item.query}`, rows: [`  [${item.kind}]`] } satisfies ReportSection];
    }
    return evidenceSections(item).map((section) => ({
      ...section,
      title: `${item.shortName} — ${section.title}`,
    }));
  });
  const sourceRecoveryRows = result.sourceRecovery
    ? [
        `  Graph traversal stays graph-sized; ${result.sourceRecovery.selectors} requested source selector(s) were not embedded.`,
        `  Read the named source gap separately: ${result.sourceRecovery.command}`,
      ]
    : [];
  return [
    { title: 'EXPLICIT PROJECTION', rows: selectionRows },
    { title: 'EXACT SELECTORS', rows: targetRows, skipIfEmpty: true },
    { title: 'EDGE INVENTORY', rows: inventoryRows, skipIfEmpty: true },
    { title: 'TYPED RELATIONSHIPS', rows: relationshipRows, skipIfEmpty: true },
    { title: 'FOLDED RELATIONSHIPS', rows: foldRows, skipIfEmpty: true },
    { title: 'GRAPH COVERAGE', rows: coverageRows },
    { title: 'SOURCE MATERIALIZATION DEFERRED', rows: sourceRecoveryRows, skipIfEmpty: true },
    ...sourceSections,
  ];
}

function graphEvidenceFoldRows(folds: readonly queries.GraphEvidenceFold[]): string[] {
  if (folds.length === 0) return [];
  const rows = [...folds]
    .sort(
      (left, right) =>
        left.family.localeCompare(right.family) ||
        (left.region ?? '').localeCompare(right.region ?? '') ||
        left.id.localeCompare(right.id),
    )
    .map((fold) => {
      const subtypes = fold.subtypes ?? [fold.subtype];
      const subtypeSummary = subtypes.length === 1 ? subtypes[0]! : `${subtypes.length} subtypes`;
      return `  ${fold.id}  ${fold.family}/${subtypeSummary}  ${fold.edgeCount} edge(s), ${fold.nodeIds.length} node(s), ${fold.mode}  @ ${fold.region ?? 'unscoped'}`;
    });
  return [
    '  Recovery: rerun the same selectors and bounds with --fold <id>; each ID materializes exactly that row.',
    ...rows,
  ];
}

function graphEvidenceEdgeRow(edge: queries.GraphEvidenceEdge): string {
  const context = edge.context
    ? Object.entries(edge.context)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => `${key}=${graphEvidenceQualifierValue(value)}`)
    : [];
  const attributes = edge.attributes
    ? Object.entries(edge.attributes).map(([key, value]) => `${key}=${graphEvidenceQualifierValue(value)}`)
    : [];
  const qualifiers = [...context, ...attributes];
  return (
    `[${edge.evidenceStrength}] ${graphEvidenceNodeLabel(edge.from)} -> ${graphEvidenceNodeLabel(edge.to)} — ` +
    `${edge.subtype}${qualifiers.length > 0 ? `; ${qualifiers.join(', ')}` : ''}`
  );
}

function graphEvidenceQualifierValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function graphEvidenceNodeLabel(node: queries.GraphEvidenceNode): string {
  const location = node.location
    ? ` @ ${displayPathRange(node.location.file, node.location.line, node.location.endLine ?? node.location.line)}`
    : '';
  return `${node.label}${location}`;
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

const handleReferenceNeighborhood = budgetedDbCommand('reference-neighborhood', ({ db, args, opts, budget }) => {
  const query = stringArg(args, 0);
  const result = queries.referenceNeighborhood(db, query, { semantic: budget.semantic });
  if (booleanOptionValue(opts, 'json')) {
    printJsonEnvelope(
      'reference-neighborhood',
      args,
      opts,
      withSymbolResolutionJson(db, query, result, 'reference-neighborhood'),
      { analysisBudget: budget.analysisBudget },
    );
    return;
  }
  if (!result) return render.empty(symbolResolutionEmptyMessage(db, query, 'No reference neighborhood found.'));
  symbolResolutionBefore(db, query);
  console.log(`${result.shortName}  (${result.relativePath})\n`);
  if (result.definitionSites.length > 0) {
    console.log('  ═══ DEFINITION ═══');
    for (const site of result.definitionSites) console.log(`    ${site.file}:${displayLine(site.line)}`);
  }
  if (result.referenceSites.length > 0) {
    console.log('\n  ═══ REFERENCES ═══');
    for (const site of result.referenceSites) {
      console.log(`    ${site.file}:${displayLine(site.line)}  in ${site.enclosingShort}`);
    }
  }
  if (result.incomingCalls.length > 0) {
    console.log('\n  ═══ INCOMING CALLS ═══');
    for (const caller of result.incomingCalls) console.log(`    ${caller.file}  ${caller.shortName}`);
  }
  if (result.outgoingCalls.length > 0) {
    console.log('\n  ═══ OUTGOING CALLS ═══');
    for (const callee of result.outgoingCalls) console.log(`    ${callee.file}  ${callee.shortName}`);
  }
});

const handleValueFlow = dbCommand(({ db, args, opts }) => {
  const query = stringArg(args, 0);
  const result = queries.valueFlow(
    db,
    { symbols: [query] },
    {
      maxDepth: definedNumberOption(opts, 'depth', 2),
      maxEdges: definedNumberOption(opts, 'maxEdges', 48),
    },
  );
  if (booleanOptionValue(opts, 'json')) {
    printJsonEnvelope('value-flow', args, opts, result);
    return;
  }
  symbolResolutionBefore(db, query);
  if (result.edges.length === 0) {
    render.empty(
      'No proved value transfers found. Missing output is not evidence that no value flow exists; inspect coverage.',
    );
  } else {
    render.list(result.edges, (edge) => `  ${graphEvidenceEdgeRow(edge)}`);
  }
  console.log(`\nCoverage: ${result.coverage.status}; ${result.coverage.basis}.`);
  for (const blindSpot of result.coverage.graph.blindSpots.slice(0, 3)) console.log(`  Blind spot: ${blindSpot}`);
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

const handleReferenceReachability = budgetedDbCommand('reference-reachability', ({ db, args, opts, budget }) => {
  const query = stringArg(args, 0);
  const direction = booleanOptionValue(opts, 'forward') ? 'forward' : 'backward';
  const result = queries.referenceReachability(db, query, {
    direction,
    maxDepth: definedNumberOption(opts, 'depth', 3),
    semantic: budget.semantic,
  });
  if (booleanOptionValue(opts, 'json')) {
    printJsonEnvelope(
      'reference-reachability',
      args,
      opts,
      withSymbolResolutionJson(db, query, result, 'reference-reachability'),
      { analysisBudget: budget.analysisBudget },
    );
    return;
  }
  if (!result) return render.empty(symbolResolutionEmptyMessage(db, query, 'No reference reachability found.'));
  symbolResolutionBefore(db, query);
  console.log(`${result.direction} reference/call reachability from ${result.shortName}\n`);
  render.list(result.connectedSymbols, (symbol) => `  ${symbol.file}  ${symbol.shortName}\n    ${symbol.relationship}`);
  console.log(`\n${result.connectedSymbols.length} connected symbol(s).`);
});

const handleDependenceSlice = dbCommand(({ db, args, opts }) => {
  const criterion = stringArg(args, 0);
  const result = queries.dependenceSlice(db, criterion, {
    direction: booleanOptionValue(opts, 'forward') ? 'forward' : 'backward',
    maxDepth: definedNumberOption(opts, 'depth', 3),
    maxEdges: definedNumberOption(opts, 'maxEdges', 200),
  });
  if (booleanOptionValue(opts, 'json')) {
    printJsonEnvelope('dependence-slice', args, opts, result);
    return;
  }
  console.log(`${result.direction} dependence slice of ${criterion}\n`);
  if (result.edges.length === 0) {
    render.empty('No proved dependence path found. Missing output is not evidence of absence; inspect coverage.');
  } else {
    render.list(
      result.edges,
      (edge) => `  depth ${edge.traversalDepth} ${edge.supporting ? '[support] ' : ''}${graphEvidenceEdgeRow(edge)}`,
    );
  }
  console.log(`\nCoverage: ${result.coverage.status}; ${result.coverage.basis}; ${result.coverage.criterionKind}.`);
  for (const blindSpot of result.coverage.graph.blindSpots.slice(0, 3)) console.log(`  Blind spot: ${blindSpot}`);
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
        'Set the displayed-evidence character ceiling (default 20000)',
        parsePositiveInteger,
      ),
      option(
        '--view <view>',
        'Render exact source, or raw/normalized behavior chosen by token cost with complete statement accounting (source or behavior; default source)',
      ),
      option(
        '--allow-large-source',
        `Explicitly allow an exact-source packet above the ${SOURCE_INSPECTION_SAFE_CHARACTERS}-character safety ceiling`,
      ),
      option(
        '--allow-large-behavior',
        `Explicitly allow a behavioral construct above the ${SOURCE_INSPECTION_SAFE_CHARACTERS}-character focus ceiling`,
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
        'Choose symbol evidence; defaults to definition, callers, and callees; repeat or comma-separate',
        collectValues,
        [],
      ),
      option(
        '--evidence-budget <channel=n>',
        'Set an independent unit ceiling for one evidence channel; repeat or comma-separate',
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
      REPOSITORY_OBSERVATION_OPERATION,
      sourceReadSemanticContract(
        ['behavior', 'construct', 'exact-source'],
        [
          'A source packet does not choose which implementation details are relevant to the user task.',
          'A reference mention does not establish executable reachability.',
        ],
      ),
    ),
    docs: doc('Navigation', [
      "scip-query inspect --search sessionStreamEvents --search work_session_stream_events --search 'agent:work_session' --view behavior",
      'scip-query inspect --symbol appendEvent --symbol publishEvent --include definition,references,callers,callees',
      'scip-query inspect --at src/api.ts:42 --at src/web.tsx:90',
    ]),
    query: ({ db, opts, budget }) => {
      assertNavigationDetailAllowed(db.config.projectRoot, 'inspect', opts['session'] !== false);
      const full = booleanOptionValue(opts, 'full');
      const result = queries.inspectSource(db, {
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
          parts: selectedEvidenceParts(stringArrayOptionValue(opts, 'include')),
          referenceContext: 4,
          relatedSourceLines: 60,
          semantic: budget.semantic,
        },
        evidenceBudgets: inspectionEvidenceBudgets(stringArrayOptionValue(opts, 'evidenceBudget')),
      });
      enforceInspectBehaviorFocusContract(result, opts);
      enforceInspectSourceMaterializationContract(result, opts);
      return result;
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
      causalFrontier: result.causalFrontier,
      packetCoverage: result.packetCoverage,
      stoppingSummary: result.stoppingSummary,
    }),
    sections: sourceInspectionSections,
  }),
  sectionedQueryCommand({
    id: 'search',
    command: 'search <exact-text>',
    description: 'Count current project text matches and preview a bounded, recoverable identity and source manifest',
    options: [
      option('-s, --scope <path>', 'Limit the search to current project paths matching this text'),
      option(
        '-C, --context <n>',
        'Source lines before and after each representative match',
        parseNonNegativeInteger,
        2,
      ),
      option(
        '-n, --limit <n>',
        'Representative source windows to materialize; exact identity manifests remain separately accounted',
        parsePositiveInteger,
        6,
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
      undefined,
      REPOSITORY_OBSERVATION_OPERATION,
      locatorSemanticContract(
        ['text', 'symbol', 'construct', 'runtime-key'],
        [
          'Structural source ranking orders exact matches but does not establish task relevance.',
          'A literal co-occurrence does not establish a graph relationship.',
        ],
      ),
    ),
    docs: doc('Navigation', ["scip-query search 'eventName'", "scip-query search 'send.*event' --regexp --scope src"]),
    query: ({ db, args, opts }) =>
      queries.searchSource(db, stringArg(args, 0), {
        scope: stringOptionValue(opts, 'scope'),
        context: definedNumberOption(opts, 'context', 2),
        limit: definedLimitOption(opts, 'limit', 6),
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
  sectionedQueryCommand({
    id: 'anchors',
    command: 'anchors <question>',
    description:
      'Deprecated compatibility view for query-vocabulary candidate groups; use exact locators plus evidence',
    options: [
      option('-s, --scope <path>', 'Limit candidate ownership and text evidence to indexed paths matching this text'),
      option(
        '-n, --limit <n>',
        'Connected anchor sets to return; omitted candidates remain counted',
        parsePositiveInteger,
        4,
      ),
      option('--full', 'Analyze every candidate anchor group with semantic enrichment'),
    ],
    agent: agentContract(
      'Which small graph-connected code regions contain repository vocabulary from this question?',
      'ranked candidate owners, two-hop compiler call evidence, exact map commands, and an omission ledger',
      ['pattern'],
      'bounded',
      undefined,
      REPOSITORY_OBSERVATION_OPERATION,
      locatorSemanticContract(
        ['text', 'symbol', 'construct'],
        [
          'Connected candidate groups are compatibility navigation hints, not inferred task relevance.',
          'Candidate grouping does not establish implementation behavior.',
        ],
        { ranking: 'identity-only', compatibility: 'deprecated' },
      ),
    ),
    docs: doc('Compatibility'),
    query: ({ db, args, opts }) => {
      const result = queries.discoverAnchors(db, stringArg(args, 0), {
        scope: stringOptionValue(opts, 'scope'),
        limit: definedLimitOption(opts, 'limit', 4),
        full: booleanOptionValue(opts, 'full'),
        semantic: booleanOptionValue(opts, 'full'),
      });
      stageNavigationMapCommands(
        db.config.projectRoot,
        result.groups.map((group) => group.systemMapCommand),
        opts['session'] !== false,
      );
      return result;
    },
    emptyMessage: (result) =>
      result.candidateRootCount === 0
        ? `No compiler-owned repository construct matched the normalized terms: ${result.normalizedTerms.join(', ')}.`
        : undefined,
    coverage: (result) =>
      result.omittedRootCount === 0 && result.omittedGroupCount === 0
        ? {
            complete: true,
            totalKnown: true,
            returned: result.candidateRootCount,
            total: result.candidateRootCount,
            omitted: 0,
          }
        : {
            complete: false,
            totalKnown: true,
            returned: result.analyzedRootCount,
            total: result.candidateRootCount,
            omitted: result.omittedRootCount,
          },
    agentResult: (result) => ({
      normalizedTerms: result.normalizedTerms,
      matchedTerms: result.matchedTerms,
      unmatchedTerms: result.unmatchedTerms,
      candidateRoots: result.candidateRootCount,
      analyzedRoots: result.analyzedRootCount,
      omittedRoots: result.omittedRootCount,
      omittedAnchorSets: result.omittedGroupCount,
      anchorSets: result.groups.map((group) => ({
        roots: group.roots.map((root) => ({
          symbol: root.symbol,
          file: root.file,
          line: displayLine(root.line),
          matchedTerms: root.matchedTerms,
        })),
        keyAnchors: group.keyAnchors.map((anchor) => ({ file: anchor.file, line: displayLine(anchor.line) })),
        relations: group.relations,
        systemMapCommand: group.systemMapCommand,
      })),
      recoveryCommand: result.recoveryCommand,
    }),
    sections: anchorDiscoverySections,
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
    command: 'evidence [symbol]',
    description: 'Traverse selected typed relationships around exact referents; recover source separately when needed',
    options: [
      option('--symbol <symbol>', 'Add an exact compiler symbol; repeat to batch', collectValues, []),
      option(
        '--at <file:line>',
        'Add the construct owning an exact source location; repeat to batch',
        collectValues,
        [],
      ),
      option('--search <literal>', 'Add an exact source or runtime literal; repeat to batch', collectValues, []),
      option('--view <view>', 'Select causal, structure, or complete graph evidence'),
      option(
        '--edge <family>',
        'Select execution, runtime, dataflow, state, temporal, contract, identity, ownership, dependencies, or all; repeat or comma-separate',
        collectValues,
        [],
      ),
      option('--direction <direction>', 'Traverse incoming, outgoing, or both directed relationships'),
      option('--subtype <subtype>', 'Select exact relationship subtypes; repeat or comma-separate', collectValues, []),
      option('--connecting', 'Return deterministic shortest paths connecting the resolved roots'),
      option('--inventory-only', 'Count relationships by family, subtype, and direction without rendering edges'),
      option(
        '--fold <id>',
        'Materialize an exact recoverable fold from the same projection; repeat to batch',
        collectValues,
        [],
      ),
      option('--depth <n>', 'Required maximum graph traversal depth', parseNonNegativeInteger),
      option('--max-edges <n>', 'Required maximum typed relationships to render', parsePositiveInteger),
      option(
        '--include <part>',
        'Legacy positional source evidence; graph projections defer it to an exact inspect recovery command',
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
        'Which exact execution, runtime, data, state, temporal, contract, identity, ownership, or dependency relationships surround these referents?',
        'Which related source must be read only when graph evidence leaves a named implementation gap?',
      ],
      returns: [
        'batched exact selectors and typed graph relationships',
        'compact endpoints with exact locations and follow-up commands',
        'coverage and recoverable omissions',
        'exact source-recovery command when source was requested with a graph projection',
        'explicit ambiguity failure with exact rerun commands',
      ],
      inputs: ['symbol'],
      scope: 'repository',
      coverage: 'bounded',
      semantic: graphProjectionSemanticContract({
        rootKinds: ['text', 'symbol', 'construct', 'runtime-key', 'state-resource'],
        edgeFamilies: GRAPH_EVIDENCE_FAMILIES,
        directions: ['incoming', 'outgoing', 'both'],
        operations: ['adjacency', 'reachability', 'connecting', 'slice'],
        compression: ['none', 'linear', 'scc', 'topology'],
        nonClaims: [
          'The projection does not infer which relationships are relevant to the user task.',
          'Reference, dependency, data, state, temporal, contract, and identity edges do not become execution claims.',
        ],
      }),
    },
    docs: doc('Navigation', [
      'scip-query evidence appendEvent',
      "scip-query evidence --symbol 'exact-symbol' --edge execution --edge dataflow --direction both --depth 2 --max-edges 32",
      "scip-query evidence --symbol 'first' --symbol 'second' --edge runtime --direction both --depth 3 --max-edges 32 --connecting",
      "scip-query evidence --at 'src/file.ts:40' --edge runtime --edge state --edge contract --direction outgoing --depth 2 --inventory-only",
      'scip-query evidence appendEvent --include definition,references,callers,callees',
    ]),
    query: ({ db, args, opts, budget }): EvidenceCommandResult => {
      const positional = typeof args[0] === 'string' && args[0].trim() !== '' ? [args[0]] : [];
      const symbols = [...positional, ...stringArrayOptionValue(opts, 'symbol')];
      const locations = stringArrayOptionValue(opts, 'at');
      const searches = stringArrayOptionValue(opts, 'search');
      const view = graphEvidenceView(stringOptionValue(opts, 'view'));
      const families = selectedGraphEvidenceFamilies(stringArrayOptionValue(opts, 'edge'));
      const direction = graphEvidenceDirection(stringOptionValue(opts, 'direction'));
      const subtypes = selectedGraphEvidenceSubtypes(stringArrayOptionValue(opts, 'subtype'));
      const connecting = booleanOptionValue(opts, 'connecting');
      const inventoryOnly = booleanOptionValue(opts, 'inventoryOnly');
      const foldIds = stringArrayOptionValue(opts, 'fold');
      const maxDepth = numberOptionValue(opts, 'depth');
      const maxEdges = numberOptionValue(opts, 'maxEdges');
      const graphRequested =
        view !== undefined ||
        families !== undefined ||
        direction !== undefined ||
        subtypes !== undefined ||
        connecting ||
        inventoryOnly ||
        foldIds.length > 0 ||
        stringArrayOptionValue(opts, 'symbol').length > 0 ||
        locations.length > 0 ||
        searches.length > 0;
      if (!graphRequested) {
        assertNavigationDetailAllowed(db.config.projectRoot, 'evidence', opts['session'] !== false);
        return queries.qualifiedEvidence(db, stringArg(args, 0), {
          parts: selectedEvidenceParts(stringArrayOptionValue(opts, 'include')),
          referenceContext: definedNumberOption(opts, 'context', 2),
          relatedSourceLines: definedNumberOption(opts, 'relatedSourceLines', 80),
          semantic: budget.semantic,
        });
      }
      if (families === undefined) {
        throw new Error(
          'Graph evidence requires at least one explicit --edge <family>; repeat --edge to select several relationship families.',
        );
      }
      if (direction === undefined) {
        throw new Error('Graph evidence requires explicit --direction incoming, outgoing, or both.');
      }
      if (maxDepth === undefined) {
        throw new Error('Graph evidence requires an explicit finite --depth <n>.');
      }
      if (!inventoryOnly && maxEdges === undefined) {
        throw new Error('Materialized graph evidence requires an explicit finite --max-edges <n>.');
      }
      const sourceParts = selectedEvidenceParts(stringArrayOptionValue(opts, 'include'));
      const sourceSelectors = [...symbols, ...locations];
      const sourceRecovery =
        sourceParts === undefined
          ? null
          : {
              parts: sourceParts,
              selectors: sourceSelectors.length,
              command: [
                'scip-query inspect',
                ...symbols.map((symbol) => `--symbol ${shellArgument(symbol)}`),
                ...locations.map((location) => `--at ${shellArgument(location)}`),
                '--view source',
                `--include ${shellArgument(sourceParts.join(','))}`,
              ].join(' '),
            };
      return {
        kind: 'graph-packet',
        graph: queries.graphEvidence(
          db,
          { symbols, locations, searches },
          {
            view,
            families,
            direction,
            subtypes,
            connecting,
            inventoryOnly,
            foldIds,
            maxDepth,
            maxEdges: maxEdges ?? 1,
          },
        ),
        source: [],
        sourceRecovery,
      };
    },
    emptyMessage: (result) => (result.kind === 'graph-packet' ? undefined : evidenceFailureMessage(result)),
    before: (result) => {
      if (result.kind === 'graph-packet') {
        if (result.graph.targets.some((target) => target.status !== 'matched')) process.exitCode = 1;
        return;
      }
      if (result.kind !== 'matched') process.exitCode = 1;
    },
    coverage: (result, { budget }) => {
      if (result.kind === 'graph-packet') {
        const returned =
          result.graph.edges.length +
          result.source.reduce(
            (total, item) =>
              total +
              (item.kind === 'matched'
                ? (item.definition ? 1 : 0) +
                  item.referenceWindows.length +
                  item.callers.length +
                  item.callees.length +
                  item.dependencies.length +
                  item.consumers.length
                : 0),
            0,
          );
        const targetsComplete = result.graph.targets.every((target) => target.status === 'matched');
        const sourceMayBeBudgeted = result.source.length > 0 && Boolean(budget.analysisBudget);
        const sourceDeferred = result.sourceRecovery !== null;
        const complete =
          result.graph.coverage.status === 'accounted' && targetsComplete && !sourceMayBeBudgeted && !sourceDeferred;
        if (complete) return { complete: true, totalKnown: true, returned, total: returned, omitted: 0 };
        if (
          result.graph.coverage.status === 'incomplete' ||
          !targetsComplete ||
          sourceMayBeBudgeted ||
          sourceDeferred
        ) {
          return { complete: false, totalKnown: false, returned };
        }
        return {
          complete: false,
          totalKnown: true,
          returned,
          total: returned + result.graph.coverage.omittedEdges,
          omitted: result.graph.coverage.omittedEdges,
        };
      }
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
      result.kind === 'graph-packet'
        ? {
            view: result.graph.view,
            families: result.graph.families,
            selection: result.graph.selection,
            targets: result.graph.targets,
            inventory: result.graph.inventory,
            relationshipCount: result.graph.edges.length,
            coverage: result.graph.coverage,
            sourceSelectors: result.source.length,
            sourceRecovery: result.sourceRecovery,
          }
        : result.kind === 'matched'
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
    sections: evidenceCommandSections,
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
    description: 'One-hop module summary: matched files, documented symbols, and file reference dependencies',
    options: [compactOption()],
    agent: {
      operation: REPOSITORY_OBSERVATION_OPERATION,
      answers: [
        'Which files and documented symbols match this module selector?',
        'What one-hop file reference dependencies cross the selected module?',
      ],
      returns: [
        'module file paths',
        'documented indexed symbols with line ranges',
        'internal dependencies',
        'reverse dependencies',
      ],
      inputs: ['module'],
      // No budget and no row cap: every section is the whole set.
      coverage: 'complete',
      contrasts: [
        {
          command: 'surface',
          distinction:
            'system lists documented indexed symbols; surface lists callable symbols that external consumers actually use.',
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
        symbolUnits: 'result.symbols contains documented indexed symbols with their line ranges',
      },
    }),
    sections: (result) => [
      { title: 'FILES', rows: result.files },
      {
        title: 'DOCUMENTED INDEXED SYMBOLS',
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
    query: ({ db, args }) => queries.consumerSurface(db, stringArg(args, 0)),
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
    description: 'Deprecated compatibility alias for a reference/call neighborhood; use value-flow',
    agent: agentContract(
      'What definitions, references, incoming calls, and outgoing calls surround this symbol?',
      'legacy reference sites and call-neighborhood rows; no value-flow claim',
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
    id: 'reference-neighborhood',
    command: 'reference-neighborhood <symbol>',
    description: 'Show definition/reference sites and incoming/outgoing static calls without value-flow claims',
    agent: agentContract(
      'What exact references and static calls surround this symbol?',
      'definition sites, reference sites, incoming calls, and outgoing calls',
      ['symbol'],
      'bounded',
    ),
    options: withJsonOption([option('--full', 'Run unbounded semantic analysis on large indexes')]),
    budget: 'semantic',
    renderShape: 'custom',
    docs: doc('Navigation'),
    handler: handleReferenceNeighborhood,
  },
  {
    id: 'value-flow',
    command: 'value-flow <symbol>',
    description: 'Show only proved argument/parameter and bounded static-value transfers around a symbol',
    agent: agentContract(
      'Which values are proved to flow into or through this symbol?',
      'typed value-transfer edges with evidence strength and explicit unsupported relations',
      ['symbol'],
      'bounded',
    ),
    options: withJsonOption([
      option('--depth <n>', 'Maximum graph depth', parseInteger, 2),
      option('--max-edges <n>', 'Maximum typed value-transfer edges', parseInteger, 48),
    ]),
    renderShape: 'custom',
    docs: doc('Navigation'),
    handler: handleValueFlow,
  },
  {
    id: 'slice',
    command: 'slice <symbol>',
    description: 'Deprecated compatibility alias for reference/call reachability; use dependence-slice',
    agent: agentContract(
      'Which calls or reference owners are reachable from this symbol under the legacy traversal?',
      'legacy connected symbols; no program-dependence claim',
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
  {
    id: 'reference-reachability',
    command: 'reference-reachability <symbol>',
    description: 'Traverse legacy callee or reference-owner reachability without calling it a program slice',
    agent: agentContract(
      'Which call/reference nodes are reachable from this symbol?',
      'connected symbols with relationship and traversal depth',
      ['symbol'],
      'bounded',
    ),
    options: withJsonOption([
      option('--forward', 'Traverse reference owners. Default traverses callees.'),
      option('--depth <n>', 'Maximum callee depth', parseInteger, 3),
      option('--full', 'Run unbounded semantic analysis on large indexes'),
    ]),
    budget: 'semantic',
    renderShape: 'custom',
    docs: doc('Navigation'),
    handler: handleReferenceReachability,
  },
  {
    id: 'dependence-slice',
    command: 'dependence-slice <symbol-or-location>',
    description: 'Directional slice over proved data/control dependencies with explicit supporting call edges',
    agent: agentContract(
      'What proved program dependencies can affect this criterion, or be affected by it?',
      'directional dependence edges, supporting connectors, and coverage limits',
      [['symbol', 'path']],
      'bounded',
    ),
    options: withJsonOption([
      option('--forward', 'Compute a forward slice. Default is backward.'),
      option('--depth <n>', 'Maximum dependence traversal depth', parseInteger, 3),
      option('--max-edges <n>', 'Maximum topology edges considered', parseInteger, 200),
    ]),
    renderShape: 'custom',
    docs: doc('Navigation'),
    handler: handleDependenceSlice,
  },
];
