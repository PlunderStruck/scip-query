import type { IndexedDefinition } from '../../domain/types.js';
import { getAst } from '../../source/ast/ast-core.js';
import type { SyntaxNode } from '../../source/ast/ast-types.js';
import { extractCallLeaf } from '../../source/facts/source-calls.js';
import type { ScipDatabase } from '../../storage/db.js';
import { createPerDbCache } from '../../storage/per-db-cache.js';
import { mentionReferenceChunkRows } from '../../storage/scip-mentions.js';
import { findEnclosingDefinition, getDefinitionsForFile } from '../definition-catalog.js';
import { referenceEvidenceForSymbol, type ReferenceEvidenceProvenance } from '../references/reference-sites.js';

export interface ResolvedCallSite {
  callee: IndexedDefinition;
  caller: IndexedDefinition | null;
  file: string;
  line: number;
  startLine: number;
  endLine: number;
  targetText: string;
  callNode: SyntaxNode;
  targetNode: SyntaxNode;
  arguments: SyntaxNode[];
  referenceProvenance: ReferenceEvidenceProvenance;
}

export type UnresolvedCallSiteReason = 'ast-unavailable' | 'call-not-found' | 'ambiguous-call';

export interface UnresolvedCallSite {
  callee: IndexedDefinition;
  file: string;
  line: number;
  reason: UnresolvedCallSiteReason;
  candidates: number;
  referenceProvenance: ReferenceEvidenceProvenance;
}

export interface ResolvedCallSitesResult {
  sites: ResolvedCallSite[];
  unresolved: UnresolvedCallSite[];
  filesVisited: number;
}

interface IndexedCallSyntax {
  callNode: SyntaxNode;
  targetNode: SyntaxNode;
  arguments: SyntaxNode[];
}

interface FileCallSyntaxIndex {
  byLeaf: ReadonlyMap<string, readonly IndexedCallSyntax[]>;
}

interface CompilerReferenceRange {
  file: string;
  startLine: number;
  endLine: number;
  provenance: ReferenceEvidenceProvenance;
}

// A ScipDatabase is one immutable index generation, so these derived views
// remain valid for its lifetime and need no source-file invalidation group.
const FILE_CALL_SYNTAX = createPerDbCache<string, FileCallSyntaxIndex | null>('resolved-call-syntax', {
  clearGroups: [],
});
const RESOLVED_CALL_SITES = createPerDbCache<number, ResolvedCallSitesResult>('resolved-call-sites', {
  clearGroups: [],
});
const HAS_SCIP_REFERENCE_EVIDENCE = createPerDbCache<string, boolean>('resolved-call-sites-reference-evidence', {
  clearGroups: [],
});

/**
 * Locate calls to one compiler-resolved definition while retaining the source
 * syntax needed by higher-level analyses. SCIP identity chooses the candidate
 * files and lines; the AST only recovers the exact call and its arguments.
 * A line with multiple matching calls remains explicitly unresolved.
 */
export function resolvedCallSitesForDefinition(db: ScipDatabase, callee: IndexedDefinition): ResolvedCallSitesResult {
  return RESOLVED_CALL_SITES.get(db, callee.symbolId, () =>
    resolveCallSites(db, callee, compilerReferenceSites(db, callee)),
  );
}

export function resolvedCallSitesForDefinitions(
  db: ScipDatabase,
  callees: readonly IndexedDefinition[],
): ReadonlyMap<number, ResolvedCallSitesResult> {
  const uniqueCallees = [...new Map(callees.map((callee) => [callee.symbolId, callee])).values()];
  const unresolvedCallees = uniqueCallees.filter((callee) => !RESOLVED_CALL_SITES.has(db, callee.symbolId));
  const referencesBySymbol = compilerReferenceSitesMap(db, unresolvedCallees);
  return new Map(
    uniqueCallees.map((callee) => [
      callee.symbolId,
      RESOLVED_CALL_SITES.get(db, callee.symbolId, () =>
        resolveCallSites(db, callee, referencesBySymbol.get(callee.symbolId) ?? []),
      ),
    ]),
  );
}

function resolveCallSites(
  db: ScipDatabase,
  callee: IndexedDefinition,
  references: readonly CompilerReferenceRange[],
): ResolvedCallSitesResult {
  const sites: ResolvedCallSite[] = [];
  const unresolved: UnresolvedCallSite[] = [];
  const filesVisited = new Set<string>();
  const seenCalls = new Set<string>();
  for (const reference of references) {
    filesVisited.add(reference.file);
    const syntax = FILE_CALL_SYNTAX.get(db, reference.file, () => buildFileCallSyntaxIndex(db, reference.file));
    if (!syntax) {
      unresolved.push({
        callee,
        file: reference.file,
        line: reference.startLine,
        reason: 'ast-unavailable',
        candidates: 0,
        referenceProvenance: reference.provenance,
      });
      continue;
    }

    const candidates = (syntax.byLeaf.get(callee.leaf) ?? []).filter(
      ({ callNode }) =>
        callNode.startPosition.row <= reference.endLine && callNode.endPosition.row >= reference.startLine,
    );
    if (candidates.length !== 1) {
      unresolved.push({
        callee,
        file: reference.file,
        line: reference.startLine,
        reason: candidates.length === 0 ? 'call-not-found' : 'ambiguous-call',
        candidates: candidates.length,
        referenceProvenance: reference.provenance,
      });
      continue;
    }

    const candidate = candidates[0]!;
    const callKey = `${reference.file}\0${candidate.callNode.startIndex}\0${candidate.callNode.endIndex}`;
    if (seenCalls.has(callKey)) continue;
    seenCalls.add(callKey);
    sites.push({
      callee,
      caller: findEnclosingDefinition(getDefinitionsForFile(db, reference.file), candidate.callNode.startPosition.row),
      file: reference.file,
      line: candidate.callNode.startPosition.row,
      startLine: candidate.callNode.startPosition.row,
      endLine: candidate.callNode.endPosition.row,
      targetText: candidate.targetNode.text,
      callNode: candidate.callNode,
      targetNode: candidate.targetNode,
      arguments: candidate.arguments,
      referenceProvenance: reference.provenance,
    });
  }

  return { sites, unresolved, filesVisited: filesVisited.size };
}

function compilerReferenceSites(db: ScipDatabase, callee: IndexedDefinition): CompilerReferenceRange[] {
  return compilerReferenceSitesMap(db, [callee]).get(callee.symbolId) ?? [];
}

function compilerReferenceSitesMap(
  db: ScipDatabase,
  callees: readonly IndexedDefinition[],
): ReadonlyMap<number, CompilerReferenceRange[]> {
  if (!hasScipReferenceEvidence(db)) {
    return new Map(
      callees.map((callee) => [
        callee.symbolId,
        referenceEvidenceForSymbol(db, callee, { semantic: false }).map((site) => ({
          file: site.file,
          startLine: site.line,
          endLine: site.line,
          provenance: site.provenance,
        })),
      ]),
    );
  }
  const rangesBySymbol = new Map<number, CompilerReferenceRange[]>();
  for (const row of mentionReferenceChunkRows(
    db,
    callees.map((callee) => callee.symbolId),
  )) {
    const ranges = rangesBySymbol.get(row.symbol_id) ?? [];
    ranges.push({
      file: row.relative_path,
      startLine: row.chunk_start,
      endLine: row.chunk_end,
      provenance: 'scip-reference-chunk',
    });
    rangesBySymbol.set(row.symbol_id, ranges);
  }
  return new Map(callees.map((callee) => [callee.symbolId, rangesBySymbol.get(callee.symbolId) ?? []]));
}

function hasScipReferenceEvidence(db: ScipDatabase): boolean {
  return HAS_SCIP_REFERENCE_EVIDENCE.get(db, 'project', () =>
    Boolean(db.get<{ present: number }>('SELECT 1 AS present FROM mentions WHERE role != 1 LIMIT 1')),
  );
}

function buildFileCallSyntaxIndex(db: ScipDatabase, file: string): FileCallSyntaxIndex | null {
  const root = getAst(db, file)?.rootNode;
  if (!root) return null;
  const byLeaf = new Map<string, IndexedCallSyntax[]>();
  walk(root, (node) => {
    if (node.type !== 'call_expression' && node.type !== 'call') return;
    const targetNode = node.childForFieldName('function') ?? node.namedChild(0);
    if (!targetNode) return;
    const leaf = extractCallLeaf(targetNode);
    if (!leaf) return;
    const argsNode =
      node.childForFieldName('arguments') ?? node.namedChildren.find((child) => child.type === 'arguments');
    const call: IndexedCallSyntax = {
      callNode: node,
      targetNode,
      arguments: argsNode?.namedChildren ?? [],
    };
    const existing = byLeaf.get(leaf);
    if (existing) existing.push(call);
    else byLeaf.set(leaf, [call]);
  });
  return { byLeaf };
}

function walk(node: SyntaxNode, visit: (node: SyntaxNode) => void): void {
  visit(node);
  for (const child of node.namedChildren) walk(child, visit);
}
