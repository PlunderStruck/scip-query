import { sourceBindingResolver } from '../../source/ast/source-binding-identity.js';
import { callableValueWasWritten, resolveCallableValue } from './imported-value-context.js';
import { lexicalCallOwners, sourceCallableOwnerKey } from './callable-owner-identity.js';
import { readRepositoryTextFile } from '../../source/primitives/repository-text.js';
import { getSourceLines } from '../../source/primitives/source-text.js';
import { existsSync } from 'node:fs';
import { SymbolRole } from '@c4312/scip';
import type { IndexedDefinition } from '../../domain/types.js';
import { getSourceFacts } from '../../source/facts/source-facts.js';
import type { SourceCallableOwner, SourceFacts } from '../../source/facts/source-fact-types.js';
import { callSiteOwner } from '../../source/facts/source-callables.js';
import { getAst } from '../../source/ast/ast-core.js';
import { sourceAnalysisRoot, ANALYSIS_CALLABLE_NODE_TYPES, walkNamedSyntax } from '../../source/ast/ast-callables.js';
import type { SyntaxNode } from '../../source/ast/ast-types.js';
import type { ScipDatabase } from '../../storage/db.js';
import { readScipArtifact } from '../../storage/scip-artifact.js';
import { recordUnsupportedDatabaseRead } from '../../storage/database-read-proof.js';
import { getAllDefinitions, getDefinitionsForFile } from '../definition-catalog.js';
import {
  chunkOccurrenceTargetsForFile,
  normalizeOccurrenceRange,
  sameOccurrenceRange,
  type OccurrenceSourceRange,
  indexStoresOccurrenceData,
  type FileOccurrenceTargets,
} from './scip-chunk-occurrences.js';

export interface ScipOccurrenceCallTarget {
  sourceLine: number;
  sourceRange?: OccurrenceSourceRange;
  sourceOwner?: SourceCallableOwner | null;
  sourceDefinition?: IndexedDefinition | null;
  calleeLeaf: string;
  definition: IndexedDefinition;
  implementationStatus?: 'established' | 'unresolved';
  implementationReason?: string;
}

export interface ScipOccurrenceDefinitionTarget {
  sourceLine: number;
  sourceRange?: OccurrenceSourceRange;
  definition: IndexedDefinition;
}

export interface ScipOccurrenceCallTargetsResult {
  available: boolean;
  targets: ScipOccurrenceCallTarget[];
  resolvedCallsites: number;
  unresolvedCallsites: number;
  /** Exact compiler declarations survive even when their current values cannot be established. */
  declarations?: ScipOccurrenceCallTarget[];
  implementationUnresolvedCallsites?: number;
}

export interface ScipOccurrenceCallableReferencesResult {
  available: boolean;
  targets: ScipOccurrenceCallTarget[];
}

type IndexedOccurrenceCallTarget = ScipOccurrenceDefinitionTarget;

interface ScipOccurrenceCallTargetIndex {
  byFile: Map<string, IndexedOccurrenceCallTarget[]>;
  externalByFile: Map<string, OccurrenceSourceRange[]>;
}

const SCIP_OCCURRENCE_CALL_TARGET_INDEX = new WeakMap<ScipDatabase, ScipOccurrenceCallTargetIndex | null>();

/**
 * Compiler-resolved occurrence targets for one indexed file. The per-chunk
 * occurrence blobs in the SQLite index are the primary source; the whole
 * SCIP artifact is deserialized only for an index whose chunks carry no
 * occurrence data. Null means no occurrence evidence exists for the file.
 */
export function scipOccurrenceTargetsForFile(db: ScipDatabase, relativePath: string): FileOccurrenceTargets | null {
  if (readRepositoryTextFile(db, relativePath)?.freshness.semantic.state === 'stale') return null;
  const chunkLookup = chunkOccurrenceTargetsForFile(db, relativePath);
  if (chunkLookup.available) {
    return {
      targets: chunkLookup.targets,
      externalLeafKeys: chunkLookup.externalLeafKeys,
      externalRanges: chunkLookup.externalRanges,
      locals: chunkLookup.locals,
    };
  }
  if (chunkLookup.reason === 'no-document') return null;
  // An index that stores occurrence data never justifies deserializing the
  // whole artifact; a file whose blobs failed to decode simply has no
  // occurrence evidence. The artifact path exists for occurrence-less indexes.
  if (indexStoresOccurrenceData(db)) return { targets: [], externalLeafKeys: new Set(), locals: [] };
  const index = scipOccurrenceCallTargetIndex(db);
  if (!index) return null;
  return {
    targets: index.byFile.get(relativePath) ?? [],
    externalLeafKeys: new Set(),
    externalRanges: index.externalByFile.get(relativePath) ?? [],
    locals: [],
  };
}

/**
 * Recover compiler-resolved callees for a source range that has no callable
 * symbol of its own. A target is admitted only when the source parser and the
 * SCIP occurrence identify the same callee token range; unmatched calls
 * remain explicit coverage gaps.
 */
export function scipOccurrenceCallTargetsForRange(
  db: ScipDatabase,
  relativePath: string,
  startLine: number,
  endLine: number,
  requestedSymbols?: ReadonlySet<string>,
): ScipOccurrenceCallTargetsResult {
  const facts = getSourceFacts(db, relativePath);
  const callsites = (facts?.callSites ?? []).filter((site) => site.line >= startLine && site.line <= endLine);
  if (!facts || callsites.length === 0) {
    return { available: Boolean(facts), targets: [], resolvedCallsites: 0, unresolvedCallsites: 0 };
  }

  const fileTargets = scipOccurrenceTargetsForFile(db, relativePath);
  if (!fileTargets) {
    return { available: false, targets: [], resolvedCallsites: 0, unresolvedCallsites: callsites.length };
  }
  const targets: ScipOccurrenceCallTarget[] = [];
  const declarations: ScipOccurrenceCallTarget[] = [];
  let resolvedCallsites = 0;
  let establishedImplementations = 0;
  let inspectedCallsites = 0;
  for (const site of callsites) {
    const matches = fileTargets.targets.filter((target) => sameOccurrenceRange(target.sourceRange, site.targetRange));
    const unique = new Map(matches.map((target) => [target.definition.symbol, target]));
    // Incoming queries already know the compiler declaration they seek. Other
    // calls in the same storage chunk need no value/mutation analysis. Keep all
    // matches for a selected call so ambiguous bindings remain ambiguous.
    if (requestedSymbols && ![...unique.keys()].some((symbol) => requestedSymbols.has(symbol))) continue;
    inspectedCallsites++;
    declarations.push(
      ...[...unique.values()].map((match) => ({
        ...match,
        sourceLine: site.line,
        sourceOwner: site.owner,
        calleeLeaf: match.definition.leaf,
      })),
    );
    if (sourceCallTargetWasWritten(db, relativePath, site)) continue;
    if (unique.size !== 1) continue;
    const match = [...unique.values()][0]!;
    const proof = invocationImplementationProof(db, relativePath, site, match.definition);
    if (proof.implementationStatus === 'established') establishedImplementations++;
    resolvedCallsites++;
    targets.push({
      ...match,
      ...proof,
      sourceLine: site.line,
      sourceOwner: site.owner,
      calleeLeaf: match.definition.leaf,
    });
  }
  return {
    available: true,
    targets,
    resolvedCallsites,
    unresolvedCallsites: inspectedCallsites - resolvedCallsites,
    declarations,
    implementationUnresolvedCallsites: inspectedCallsites - establishedImplementations,
  };
}

export function invocationImplementationProof(
  db: ScipDatabase,
  file: string,
  site: SourceFacts['callSites'][number],
  definition: IndexedDefinition,
): Pick<ScipOccurrenceCallTarget, 'implementationStatus' | 'implementationReason'> {
  const source = sourceCallBinding(db, file, site);
  // Keep the established contract of the other language providers.
  if (!source?.bindings.available) {
    const language = getSourceFacts(db, file)?.language;
    return language === 'typescript' || language === 'javascript'
      ? { implementationStatus: 'unresolved', implementationReason: 'source-binding-unavailable' }
      : { implementationStatus: 'established' };
  }
  if (site.kind === 'new' && !site.memberAccess && (definition.isTypeLike || definition.leaf === '<constructor>'))
    return constructorImplementationProof(db, definition);
  const value = resolveCallableValue({ db, file, root: source.root }, source.target);
  if (value && value.context.file === definition.relativePath && definitionContainsCallable(definition, value.callable))
    return { implementationStatus: 'established' };
  return {
    implementationStatus: 'unresolved',
    implementationReason: site.memberAccess
      ? 'member-value-and-runtime-dispatch-unproved'
      : 'indirect-callable-value-unproved',
  };
}

function definitionContainsCallable(definition: IndexedDefinition, node: SyntaxNode): boolean {
  const { startLine, startChar, endLine, endChar } = definition;
  if (startChar === undefined || endChar === undefined || (startLine === endLine && startChar >= endChar)) return false;
  const start = node.startPosition;
  const end = node.endPosition;
  return (
    (start.row > startLine || (start.row === startLine && start.column >= startChar)) &&
    (end.row < endLine || (end.row === endLine && end.column <= endChar))
  );
}

function constructorImplementationProof(
  db: ScipDatabase,
  definition: IndexedDefinition,
): Pick<ScipOccurrenceCallTarget, 'implementationStatus' | 'implementationReason'> {
  const root = getAst(db, definition.relativePath)?.rootNode;
  let owner: SyntaxNode | undefined;
  if (root)
    walkNamedSyntax(root, (node) => {
      if (!['class_declaration', 'abstract_class_declaration', 'class'].includes(node.type)) return;
      if (!syntaxContainsDefinition(node, definition)) return;
      if (!owner || node.endIndex - node.startIndex < owner.endIndex - owner.startIndex) owner = node;
    });
  if (!owner) return { implementationStatus: 'unresolved', implementationReason: 'constructor-source-unproved' };
  const decorated =
    owner.namedChildren.some((child) => child.type === 'decorator') ||
    (owner.parent?.type === 'export_statement' &&
      owner.parent.namedChildren.some((child) => child.type === 'decorator'));
  return decorated
    ? { implementationStatus: 'unresolved', implementationReason: 'class-decorator-runtime-constructor-unproved' }
    : { implementationStatus: 'established' };
}

function syntaxContainsDefinition(node: SyntaxNode, definition: IndexedDefinition): boolean {
  const { startLine, startChar, endLine, endChar } = definition;
  if (startChar === undefined || endChar === undefined) return false;
  return (
    (node.startPosition.row < startLine ||
      (node.startPosition.row === startLine && node.startPosition.column <= startChar)) &&
    (node.endPosition.row > endLine || (node.endPosition.row === endLine && node.endPosition.column >= endChar))
  );
}

/** A compiler reference identifies a declaration, but an observed reassignment invalidates its initial callable value. */
export function sourceCallTargetWasWritten(
  db: ScipDatabase,
  file: string,
  site: SourceFacts['callSites'][number],
): boolean {
  const source = sourceCallBinding(db, file, site);
  return source ? callableValueWasWritten({ db, file, root: source.root }, source.target) : false;
}

export function sourceCallTargetUsesParameter(
  db: ScipDatabase,
  file: string,
  site: SourceFacts['callSites'][number],
): boolean {
  const source = sourceCallBinding(db, file, site);
  return source?.bindings.isParameterBinding(source.target) ?? false;
}

function sourceCallBinding(db: ScipDatabase, file: string, site: SourceFacts['callSites'][number]) {
  const range = site.targetExpressionRange ?? site.targetRange;
  const root = getAst(db, file)?.rootNode;
  if (!range || !root) return null;
  const target = sourceAnalysisRoot(root, range.startLine, range.endLine, ANALYSIS_CALLABLE_NODE_TYPES, range);
  return target ? { root, target, bindings: sourceBindingResolver(file, root) } : null;
}

/** Return compiler-resolved repository definitions referenced by one exact source range. */
export function scipOccurrenceDefinitionTargetsForRange(
  db: ScipDatabase,
  relativePath: string,
  startLine: number,
  endLine: number,
): { available: boolean; targets: ScipOccurrenceDefinitionTarget[] } {
  const fileTargets = scipOccurrenceTargetsForFile(db, relativePath);
  if (!fileTargets) return { available: false, targets: [] };
  return {
    available: true,
    targets: fileTargets.targets.filter((target) => target.sourceLine >= startLine && target.sourceLine <= endLine),
  };
}

/**
 * Return every compiler-resolved reference to a callable definition in a
 * source range. Unlike {@link scipOccurrenceCallTargetsForRange}, this view
 * deliberately includes function values passed to higher-order operations,
 * registry entries, and other non-call references. Callers that also request
 * direct calls should deduplicate them by exact line-and-symbol identity.
 */
export function scipOccurrenceCallableReferencesForRange(
  db: ScipDatabase,
  relativePath: string,
  startLine: number,
  endLine: number,
): ScipOccurrenceCallableReferencesResult {
  const fileTargets = scipOccurrenceTargetsForFile(db, relativePath);
  if (!fileTargets) return { available: false, targets: [] };
  return {
    available: true,
    targets: fileTargets.targets
      .filter(
        (target) =>
          target.sourceLine >= startLine &&
          target.sourceLine <= endLine &&
          scipDefinitionSourceConfirmsCallable(db, target.definition),
      )
      .map((target): ScipOccurrenceCallTarget => occurrenceWithSourceOwner(db, relativePath, target)),
  };
}

/** Explicit compiler references to type declarations; this does not prove behavioral conformance. */
export function scipOccurrenceTypeReferencesForRange(
  db: ScipDatabase,
  relativePath: string,
  startLine: number,
  endLine: number,
): ScipOccurrenceCallableReferencesResult {
  const resolved = scipOccurrenceDefinitionTargetsForRange(db, relativePath, startLine, endLine);
  return {
    available: resolved.available,
    targets: resolved.targets
      .filter((target) => target.definition.isTypeLike)
      .map((target) => occurrenceWithSourceOwner(db, relativePath, target)),
  };
}

export function occurrenceWithSourceOwner(
  db: ScipDatabase,
  file: string,
  target: ScipOccurrenceDefinitionTarget,
): ScipOccurrenceCallTarget {
  const ast = getAst(db, file);
  const language = getSourceFacts(db, file)?.language;
  const range = target.sourceRange;
  const node =
    ast &&
    range &&
    sourceAnalysisRoot(ast.rootNode, range.startLine, range.endLine, ANALYSIS_CALLABLE_NODE_TYPES, range);
  const sourceOwner = node && language ? callSiteOwner(node, language) : undefined;
  if (sourceOwner) {
    const owner = lexicalCallOwners(db, file, getDefinitionsForFile(db, file)).get(sourceCallableOwnerKey(sourceOwner));
    return { ...target, calleeLeaf: target.definition.leaf, sourceOwner, sourceDefinition: owner ?? null };
  }
  const definitions = range
    ? getDefinitionsForFile(db, file).filter(
        (definition) =>
          definition.startLine <= range.startLine &&
          definition.endLine >= range.endLine &&
          (definition.startLine !== range.startLine || (definition.startChar ?? 0) <= range.startColumn) &&
          (definition.endLine !== range.endLine ||
            definition.endChar === undefined ||
            definition.endChar >= range.endColumn),
      )
    : [];
  const innermost = definitions.filter(
    (definition) =>
      !definitions.some(
        (other) =>
          other !== definition &&
          other.startLine >= definition.startLine &&
          other.endLine <= definition.endLine &&
          (other.startLine !== definition.startLine || (other.startChar ?? 0) >= (definition.startChar ?? 0)) &&
          (other.endLine !== definition.endLine || (other.endChar ?? Infinity) <= (definition.endChar ?? Infinity)),
      ),
  );
  return {
    ...target,
    calleeLeaf: target.definition.leaf,
    sourceOwner: sourceOwner ?? undefined,
    sourceDefinition: innermost.length === 1 ? innermost[0]! : null,
  };
}

function scipOccurrenceCallTargetIndex(db: ScipDatabase): ScipOccurrenceCallTargetIndex | null {
  // The separate artifact (including its absence) is not covered by SQLite reads.
  recordUnsupportedDatabaseRead();
  if (SCIP_OCCURRENCE_CALL_TARGET_INDEX.has(db)) return SCIP_OCCURRENCE_CALL_TARGET_INDEX.get(db) ?? null;
  const index = loadScipOccurrenceCallTargetIndex(db);
  SCIP_OCCURRENCE_CALL_TARGET_INDEX.set(db, index);
  return index;
}

function loadScipOccurrenceCallTargetIndex(db: ScipDatabase): ScipOccurrenceCallTargetIndex | null {
  if (!db.generation.indexPath || !existsSync(db.generation.indexPath)) return null;
  try {
    // A direct call target is proven jointly by call syntax at the source
    // token and a SCIP occurrence at that exact token range. It
    // does not need a declaration hover signature, which may degrade to
    // `any` when a function factory's dependencies are unavailable. Bare
    // callable references are filtered separately above because they lack
    // that call-syntax proof.
    const definitions = getAllDefinitions(db);
    const definitionBySymbol = new Map(definitions.map((definition) => [definition.symbol, definition]));
    const scipIndex = readScipArtifact(db.generation.indexPath, 'SCIP source-range call-target index');
    const byFile = new Map<string, IndexedOccurrenceCallTarget[]>();
    const externalByFile = new Map<string, OccurrenceSourceRange[]>();
    for (const document of scipIndex.documents ?? []) {
      const relativePath = document.relativePath;
      if (!relativePath || db.isIgnored(relativePath)) continue;
      const { targets, externalRanges } = decodeScipDocumentTargets(db, relativePath, document, definitionBySymbol);
      byFile.set(relativePath, targets);
      externalByFile.set(relativePath, externalRanges);
    }
    return { byFile, externalByFile };
  } catch {
    return null;
  }
}

/** Artifact fallback excludes definition occurrences; chunk decoding separately retains local binding definitions. */
function decodeScipDocumentTargets(
  db: ScipDatabase,
  relativePath: string,
  document: { positionEncoding: number; occurrences: { symbol: string; symbolRoles: number; range: number[] }[] },
  definitionBySymbol: ReadonlyMap<string, IndexedDefinition>,
): { targets: IndexedOccurrenceCallTarget[]; externalRanges: OccurrenceSourceRange[] } {
  const targets: IndexedOccurrenceCallTarget[] = [];
  const externalRanges: OccurrenceSourceRange[] = [];
  const sourceLines = getSourceLines(db, relativePath);
  const encoding = ({ 1: 'UTF-8', 2: 'UTF-16', 3: 'UTF-32' } as Record<number, string>)[document.positionEncoding];
  for (const occurrence of document.occurrences ?? []) {
    if (!occurrence.symbol || (occurrence.symbolRoles & SymbolRole.Definition) !== 0) continue;
    const definition = definitionBySymbol.get(occurrence.symbol);
    const sourceLine = occurrence.range?.[0];
    if (!Number.isInteger(sourceLine)) continue;
    const sourceRange = normalizeOccurrenceRange(occurrence.range, encoding, sourceLines);
    if (!definition) {
      if (sourceRange) externalRanges.push(sourceRange);
      continue;
    }
    targets.push({ sourceLine, ...(sourceRange ? { sourceRange } : {}), definition });
  }
  return { targets, externalRanges };
}

export function scipDefinitionSourceConfirmsCallable(db: ScipDatabase, definition: IndexedDefinition): boolean {
  if (!definition.isFunctionLike) return false;
  const facts = getSourceFacts(db, definition.relativePath);
  if (!facts) return true;
  if (
    facts.callables.some(
      (callable) =>
        callable.name === definition.leaf &&
        callable.startLine === definition.startLine &&
        callable.endLine === definition.endLine,
    )
  ) {
    return true;
  }
  return compilerDocumentationConfirmsCallable(definition);
}

function compilerDocumentationConfirmsCallable(definition: IndexedDefinition): boolean {
  const documentation = definition.documentation;
  if (!documentation) return false;
  const leaf = definition.leaf.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return (
    new RegExp(`\\bfunction\\s+${leaf}\\s*(?:<[^>]*>)?\\s*\\(`, 'u').test(documentation) ||
    new RegExp(`\\b(?:const|let|var)\\s+${leaf}\\s*:\\s*(?:<[^>]*>\\s*)?\\([^\\n]*\\)\\s*=>`, 'u').test(documentation)
  );
}
