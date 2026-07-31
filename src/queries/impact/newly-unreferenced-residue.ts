import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  classifyFile,
  getInactiveBarrelPaths,
  isEntrySurface,
  isRootedSymbol,
} from '../../analysis/file-classifier.js';
import {
  RESIDUE_EVIDENCE_CONTRACT_VERSION,
  evaluateResidueObservation,
  residueObservationId,
  type CurrentRoleProof,
  type ResidueChangeEvidence,
  type ResidueEvaluation,
  type ResidueEvidenceCoverage,
  type ResidueReferent,
} from '../../domain/residue.js';
import type { IndexedDefinition } from '../../domain/types.js';
import { pathsResolveSame } from '../../domain/path-normalization.js';
import { getParserForPath } from '../../language-parsers/registry.js';
import { readProjectFileText } from '../../platform/project-files.js';
import { detectAstLanguage, isVueSfcPath } from '../../source/ast.js';
import { sourceFactsFromText, type SourceFacts } from '../../source/facts/source-facts.js';
import { escapeRegex } from '../../source/primitives/regex-utils.js';
import type { ScipDatabase } from '../../storage/db.js';
import { definitionsGroupedByLeaf } from '../../symbols/definition-catalog.js';
import { leafName } from '../../symbols/symbol-parser.js';
import {
  GIT_DIFF_UNAVAILABLE_NOTE,
  createBaseContentResultReader,
  diffImpactPlan,
  type BaseContentResultReader,
  type DiffImpactPlan,
} from './diff-impact.js';
import { ProjectIndex } from '../internal/project-index.js';

export interface NewlyUnreferencedResidueResult {
  available: boolean;
  base: string;
  coverage: ResidueEvidenceCoverage;
  evaluations: ResidueEvaluation[];
  note?: string;
}

interface ReferenceCounts {
  identifiers: number;
  calls: number;
}

interface RemovedReference {
  leaf: string;
  evidence: ResidueChangeEvidence;
  basePath: string;
  importedFrom: readonly string[];
}

/**
 * Find current callables whose former route into behavior disappeared in this
 * change. The producer compares fixed Git-base source facts with current source
 * facts, resolves only unambiguous current production callables, and then asks
 * the current caller graph and repository root policy whether each callable
 * still has a role. Its negative claim is deliberately bounded to that scope.
 */
export function newlyUnreferencedResidue(
  db: ScipDatabase,
  opts: {
    base?: string;
    diffPlan?: DiffImpactPlan;
    baseContentResultAt?: BaseContentResultReader;
    semantic?: boolean;
  } = {},
): NewlyUnreferencedResidueResult {
  const base = opts.base ?? 'HEAD';
  const plan = opts.diffPlan ?? diffImpactPlan(db, { base });
  const coverageState = coverageBuilder();
  if (plan.note === GIT_DIFF_UNAVAILABLE_NOTE) {
    coverageState.omitted.push({ file: '<git-diff>', reason: GIT_DIFF_UNAVAILABLE_NOTE });
    return {
      available: false,
      base,
      coverage: finishCoverage(coverageState),
      evaluations: [],
      note: GIT_DIFF_UNAVAILABLE_NOTE,
    };
  }
  const changedFiles = [...new Set(plan.changedFileLines)].sort();
  if (changedFiles.length === 0) {
    return {
      available: true,
      base,
      coverage: finishCoverage(coverageState),
      evaluations: [],
      ...(plan.note ? { note: plan.note } : {}),
    };
  }

  const renamedFrom = new Map(plan.renamedFiles.map((rename) => [rename.to, rename.from]));
  const baseContentAt =
    opts.baseContentResultAt ??
    createBaseContentResultReader({
      projectRoot: db.config.projectRoot,
      base,
      preloadPaths: changedFiles.map((file) => renamedFrom.get(file) ?? file),
    });
  const removedReferences = collectRemovedReferences(db, changedFiles, renamedFrom, baseContentAt, coverageState);
  const index = new ProjectIndex(db);
  const definitions = index.productionCallableDefinitions({
    requireCallableSymbol: true,
    excludeRustTraitImplMembers: true,
    includeSuppressed: true,
  });
  const definitionsByLeaf = definitionsGroupedByLeaf(definitions);
  const unresolved = coverageState.unresolvedReferences;
  const resolved = new Map<number, { definition: IndexedDefinition; evidence: ResidueChangeEvidence[] }>();

  for (const removed of removedReferences) {
    const candidates = definitionsByLeaf.get(removed.leaf) ?? [];
    if (candidates.length !== 1) {
      unresolved.push({
        changedFile: removed.evidence.changedFile,
        leaf: removed.leaf,
        reason: candidates.length === 0 ? 'no-current-callable' : 'ambiguous-current-callable',
      });
      continue;
    }
    const definition = candidates[0]!;
    const baseDefinitionPath = renamedFrom.get(definition.relativePath) ?? definition.relativePath;
    if (
      !pathsResolveSame(removed.basePath, baseDefinitionPath) &&
      !removed.importedFrom.some((sourcePath) => pathsResolveSame(sourcePath, baseDefinitionPath))
    ) {
      unresolved.push({
        changedFile: removed.evidence.changedFile,
        leaf: removed.leaf,
        reason: 'base-reference-not-attributed',
      });
      continue;
    }
    const baseDefinition = baseContentAt(baseDefinitionPath);
    if (baseDefinition.state === 'unavailable') {
      coverageState.omitted.push({ file: baseDefinitionPath, reason: baseDefinition.reason });
      continue;
    }
    if (baseDefinition.state === 'absent' || !containsIdentifier(baseDefinition.content, removed.leaf)) {
      continue;
    }
    const entry = resolved.get(definition.symbolId) ?? { definition, evidence: [] };
    entry.evidence.push(removed.evidence);
    resolved.set(definition.symbolId, entry);
  }

  const resolvedDefinitions = [...resolved.values()].map((entry) => entry.definition);
  const callerMap = index.callerFileMap(resolvedDefinitions, {
    semantic: opts.semantic !== false,
    sourceFallback: true,
  });
  const frameworkReferenced = index.frameworkReferencedSymbolIds(resolvedDefinitions);
  const inactiveBarrels = new Set(getInactiveBarrelPaths(db));
  const coverage = finishCoverage(coverageState);
  const evaluations = [...resolved.values()]
    .sort(
      (left, right) =>
        left.definition.relativePath.localeCompare(right.definition.relativePath) ||
        left.definition.startLine - right.definition.startLine,
    )
    .map(({ definition, evidence }) => {
      const referent = residueReferent(definition);
      const currentRoleProofs = currentRoleProofsFor(
        db,
        definition,
        referent,
        callerMap.get(definition.symbolId) ?? new Set(),
        frameworkReferenced.has(definition.symbolId),
        inactiveBarrels,
      );
      return evaluateResidueObservation({
        observationId: residueObservationId(referent),
        contractVersion: RESIDUE_EVIDENCE_CONTRACT_VERSION,
        referent,
        changeEvidence: evidence,
        currentRoleProofs,
        coverage,
      });
    });

  return {
    available: true,
    base,
    coverage,
    evaluations,
    ...(plan.note ? { note: plan.note } : {}),
  };
}

function collectRemovedReferences(
  db: ScipDatabase,
  changedFiles: readonly string[],
  renamedFrom: ReadonlyMap<string, string>,
  baseContentAt: BaseContentResultReader,
  coverage: ReturnType<typeof coverageBuilder>,
): RemovedReference[] {
  const removed: RemovedReference[] = [];
  for (const currentPath of changedFiles) {
    const basePath = renamedFrom.get(currentPath) ?? currentPath;
    if (!detectAstLanguage(basePath) && !isVueSfcPath(basePath)) {
      coverage.notApplicableFiles.push(currentPath);
      continue;
    }
    const baseContent = baseContentAt(basePath);
    if (baseContent.state === 'unavailable') {
      coverage.omitted.push({ file: basePath, reason: baseContent.reason });
      continue;
    }
    if (baseContent.state === 'absent') {
      coverage.analyzedFiles.push(currentPath);
      continue;
    }
    const baseFacts = sourceFactsFromText(db, basePath, baseContent.content);
    if (!baseFacts.facts) {
      coverage.omitted.push({
        file: basePath,
        reason: baseFacts.unavailable?.reason ?? 'source facts unavailable',
      });
      continue;
    }
    const currentAbsolute = resolve(db.config.projectRoot, currentPath);
    const currentSource = existsSync(currentAbsolute) ? readProjectFileText(db.config.projectRoot, currentPath) : null;
    const currentFacts =
      currentSource === null
        ? { facts: emptyFacts(baseFacts.facts) }
        : sourceFactsFromText(db, currentPath, currentSource);
    if (!currentFacts.facts) {
      coverage.omitted.push({
        file: currentPath,
        reason: currentFacts.unavailable?.reason ?? 'source facts unavailable',
      });
      continue;
    }
    coverage.analyzedFiles.push(currentPath);
    const baseCounts = referenceCounts(baseFacts.facts);
    const currentCounts = referenceCounts(currentFacts.facts);
    const baseImportPaths = importPathsByLocalName(db, basePath, baseContent.content);
    for (const [leaf, before] of baseCounts) {
      const after = currentCounts.get(leaf) ?? { identifiers: 0, calls: 0 };
      const removedCalls = Math.max(0, before.calls - after.calls);
      const removedIdentifiers = Math.max(0, before.identifiers - after.identifiers);
      if (removedCalls > 0) {
        removed.push({
          leaf,
          basePath,
          importedFrom: [...(baseImportPaths.get(leaf) ?? [])].sort(),
          evidence: {
            kind: 'removed-call',
            changedFile: currentPath,
            baseOccurrences: before.calls,
            currentOccurrences: after.calls,
          },
        });
      } else if (removedIdentifiers > 0) {
        removed.push({
          leaf,
          basePath,
          importedFrom: [...(baseImportPaths.get(leaf) ?? [])].sort(),
          evidence: {
            kind: 'removed-reference',
            changedFile: currentPath,
            baseOccurrences: before.identifiers,
            currentOccurrences: after.identifiers,
          },
        });
      }
    }
  }
  return removed;
}

function importPathsByLocalName(db: ScipDatabase, relativePath: string, source: string): Map<string, Set<string>> {
  const parser = getParserForPath(relativePath);
  const result = new Map<string, Set<string>>();
  if (!parser) return result;
  for (const entry of parser.parseImports(db, relativePath, source)) {
    if (!entry.sourcePath) continue;
    const names = new Set<string>();
    const localName = entry.localName ?? entry.importedName;
    if (localName) names.add(localName);
    if (entry.kind === 'namespace') {
      for (const member of entry.usedMembers) names.add(member);
    }
    for (const name of names) {
      const paths = result.get(name) ?? new Set<string>();
      paths.add(entry.sourcePath);
      result.set(name, paths);
    }
  }
  return result;
}

function currentRoleProofsFor(
  db: ScipDatabase,
  definition: IndexedDefinition,
  referent: ResidueReferent,
  callers: ReadonlySet<string>,
  frameworkReferenced: boolean,
  inactiveBarrels: ReadonlySet<string>,
): CurrentRoleProof[] {
  const productionConsumers = [...callers]
    .filter((file) => classifyFile(file) !== 'test' && !inactiveBarrels.has(file))
    .sort();
  const proofs: CurrentRoleProof[] = [];
  if (productionConsumers.length > 0) {
    proofs.push({
      kind: 'production-consumers',
      referent,
      evidencePaths: productionConsumers,
      consumers: productionConsumers,
      reasons: [`Current production consumers: ${productionConsumers.join(', ')}.`],
    });
  }
  if (isRootedSymbol(db, definition.symbol, definition.relativePath)) {
    const policyReferent = db.config.entryRoots ? '.scipquery.json#entryRoots' : 'package-or-language-public-surface';
    proofs.push({
      kind: 'declared-external-root',
      referent,
      evidencePaths: [definition.relativePath],
      policyReferents: [policyReferent],
      reasons: [`Repository external-root policy keeps ${referent.displayName} live.`],
    });
  }
  if (isEntrySurface(db, definition.relativePath)) {
    proofs.push({
      kind: 'entry-surface',
      referent,
      evidencePaths: [definition.relativePath],
      reasons: [`${definition.relativePath} is a current entry surface.`],
    });
  }
  if (frameworkReferenced) {
    proofs.push({
      kind: 'framework-dispatch',
      referent,
      evidencePaths: [definition.relativePath],
      reasons: [`Current framework-dispatch evidence names ${referent.displayName}.`],
    });
  }
  return proofs;
}

function referenceCounts(facts: SourceFacts): Map<string, ReferenceCounts> {
  const counts = new Map<string, ReferenceCounts>();
  for (const [leaf, lines] of facts.identifierLineMap) {
    counts.set(leaf, { identifiers: lines.length, calls: 0 });
  }
  for (const call of facts.callSites) {
    const entry = counts.get(call.calleeLeaf) ?? { identifiers: 0, calls: 0 };
    entry.calls += 1;
    counts.set(call.calleeLeaf, entry);
  }
  return counts;
}

function residueReferent(definition: IndexedDefinition): ResidueReferent {
  return {
    kind: 'callable',
    symbol: definition.symbol,
    file: definition.relativePath,
    displayName: leafName(definition.symbol),
  };
}

function containsIdentifier(source: string, identifier: string): boolean {
  return new RegExp(`\\b${escapeRegex(identifier)}\\b`, 'u').test(source);
}

function emptyFacts(template: SourceFacts): SourceFacts {
  return {
    language: template.language,
    callables: [],
    callSites: [],
    clojureMembers: [],
    typeContainerMap: new Map(),
    identifierLineMap: new Map(),
    identifiersByLine: [],
    fileIdentifiers: new Set(),
    rustAttrReferencedNames: new Set(),
    crossLanguageDispatchNames: new Set(),
  };
}

function coverageBuilder(): {
  analyzedFiles: string[];
  notApplicableFiles: string[];
  omitted: Array<{ file: string; reason: string }>;
  unresolvedReferences: ResidueEvidenceCoverage['unresolvedReferences'][number][];
} {
  return {
    analyzedFiles: [],
    notApplicableFiles: [],
    omitted: [],
    unresolvedReferences: [],
  };
}

function finishCoverage(input: ReturnType<typeof coverageBuilder>): ResidueEvidenceCoverage {
  return {
    state: input.omitted.length === 0 ? 'complete' : 'partial',
    scope: 'changed-source-reference-delta-to-current-production-callables',
    analyzedFiles: [...new Set(input.analyzedFiles)].sort(),
    notApplicableFiles: [...new Set(input.notApplicableFiles)].sort(),
    omitted: [...input.omitted].sort((left, right) => left.file.localeCompare(right.file)),
    unresolvedReferences: [...input.unresolvedReferences].sort(
      (left, right) => left.changedFile.localeCompare(right.changedFile) || left.leaf.localeCompare(right.leaf),
    ),
  };
}
