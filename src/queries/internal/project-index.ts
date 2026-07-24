import type { ScipDatabase } from '../../storage/db.js';
import type { IndexedDefinition, SymbolMatch } from '../../domain/types.js';
import { classifyFile } from '../../analysis/file-classifier.js';
import { getDefinitionsForFile, getScopedDefinitions } from '../../symbols/definition-catalog.js';
import { buildCalleeMap } from '../../symbols/graph/call-graph-evidence.js';
import type { CalleeRow } from '../../symbols/graph/call-graph-evidence.js';
import { buildFileDepGraph } from '../../symbols/graph/file-dep-graph.js';
import {
  callerFileEvidenceMap,
  crossFileCallerEvidenceMap,
  sourceFallbackCallerEvidenceMap,
} from '../../symbols/references/caller-evidence.js';
import { detectAstLanguage, frameworkSourceReferences } from '../../source/ast.js';
import { sourceEvidence } from '../../source/source-evidence.js';
import { getSourceFiles } from '../../source/source-fileset.js';
import { hasSuppressionComment } from '../../source/source-text.js';
import { scanSourceReferences } from '../../symbols/references/source-reference-scan.js';
import { indexedDocumentPaths } from '../../storage/scip-documents.js';
import { symbolSemanticEvidence } from '../../semantic/symbol-evidence.js';
import { productionCallableDefinitions } from './production-callables.js';

export class ProjectIndex {
  constructor(private readonly db: ScipDatabase) {}

  scopedDefinitions(scope?: string): IndexedDefinition[] {
    return getScopedDefinitions(this.db, scope);
  }

  definitionsForFile(relativePath: string): IndexedDefinition[] {
    return getDefinitionsForFile(this.db, relativePath);
  }

  // scip-query: ignore-passthrough — ProjectIndex is the stable facade, while
  // production-callables owns the shared detector policy.
  productionCallableDefinitions(
    opts: NonNullable<Parameters<typeof productionCallableDefinitions>[1]> = {},
  ): IndexedDefinition[] {
    return productionCallableDefinitions(this.db, opts);
  }

  calleeMap(
    definitions: ReadonlyArray<SymbolMatch>,
    opts: { additive?: boolean; semantic?: boolean } = {},
  ): Map<number, CalleeRow[]> {
    return buildCalleeMap(this.db, definitions, { ...opts, semanticEvidence: symbolSemanticEvidence });
  }

  crossFileCallerMap(
    definitions?: ReadonlyArray<SymbolMatch>,
    opts: { semantic?: boolean } = {},
  ): Map<number, Set<string>> {
    return crossFileCallerEvidenceMap(this.db, definitions, {
      ...opts,
      semanticEvidence: symbolSemanticEvidence,
    });
  }

  sourceFallbackCallerFiles(
    definitions: ReadonlyArray<IndexedDefinition>,
    opts: { skipPath?: (relativePath: string) => boolean } = {},
  ): ReturnType<typeof sourceFallbackCallerEvidenceMap> {
    return sourceFallbackCallerEvidenceMap(this.db, definitions, opts);
  }

  callerFileMap(
    definitions: ReadonlyArray<IndexedDefinition>,
    opts: { semantic?: boolean; sourceFallback?: boolean } = {},
  ): Map<number, Set<string>> {
    return callerFileEvidenceMap(this.db, definitions, {
      ...opts,
      semanticEvidence: symbolSemanticEvidence,
    });
  }

  frameworkReferencedSymbolIds(definitions: ReadonlyArray<IndexedDefinition>): Set<number> {
    const candidateIdsByLeaf = new Map<string, number[]>();
    for (const definition of definitions) {
      if (!definition.leaf) continue;
      const bucket = candidateIdsByLeaf.get(definition.leaf) ?? [];
      bucket.push(definition.symbolId);
      candidateIdsByLeaf.set(definition.leaf, bucket);
    }

    const referenced = new Set<number>();
    for (const doc of indexedDocumentPaths(this.db, { includeIgnored: false })) {
      if (detectAstLanguage(doc) !== 'rust') continue;
      for (const { name } of frameworkSourceReferences(this.db, doc, { includeRustAttributeNames: true })) {
        for (const symbolId of candidateIdsByLeaf.get(name) ?? []) {
          referenced.add(symbolId);
        }
      }
    }
    return referenced;
  }

  // Candidate definitions whose callee evidence includes any symbol other
  // than themselves. This keeps self-recursive functions from looking
  // connected only because they call themselves.
  symbolsWithNonSelfCallees(
    definitions: ReadonlyArray<IndexedDefinition>,
    opts: { additive?: boolean; semantic?: boolean } = {},
  ): Set<number> {
    if (definitions.length === 0) return new Set();

    const symbolBySymbolId = new Map(definitions.map((definition) => [definition.symbolId, definition.symbol]));
    const calleeMap = this.calleeMap(definitions, opts);
    return new Set(
      [...calleeMap.entries()]
        .filter(([symbolId, callees]) => {
          const ownSymbol = symbolBySymbolId.get(symbolId);
          return callees.some((callee) => callee.symbol !== ownSymbol);
        })
        .map(([symbolId]) => symbolId),
    );
  }

  fileDependencyGraph(scope?: string): Map<string, Set<string>> {
    return buildFileDepGraph(this.db, scope);
  }

  // scip-query: ignore-passthrough — facade method keeps query modules on ProjectIndex.
  fileKind(relativePath: string): ReturnType<typeof classifyFile> {
    return classifyFile(relativePath);
  }

  // scip-query: ignore-wrapper — query modules stay on ProjectIndex instead of
  // reaching into source-text caches directly.
  hasSuppressionComment(definition: Pick<IndexedDefinition, 'relativePath' | 'startLine'>): boolean {
    return hasSuppressionComment(this.db, definition.relativePath, definition.startLine);
  }

  // scip-query: ignore-wrapper — query modules stay on ProjectIndex instead of
  // reaching into source-file caches directly.
  sourceFiles(): string[] {
    return getSourceFiles(this.db);
  }

  scanSourceReferences(
    opts: Parameters<typeof scanSourceReferences>[1],
    visit: Parameters<typeof scanSourceReferences>[2],
  ): void {
    scanSourceReferences(this.db, opts, visit);
  }

  // scip-query: ignore-wrapper — facade method keeps query modules on
  // ProjectIndex instead of reaching into source facts (same idiom as
  // fileKind / hasSuppressionComment above).
  callableSignature(
    definition: Pick<IndexedDefinition, 'relativePath' | 'startLine' | 'endLine'>,
  ): { paramCount: number } | null {
    const callable = sourceEvidence(this.db)
      .forFile(definition.relativePath, { facts: true })
      .facts?.callables.find(
        (candidate) => candidate.startLine === definition.startLine && candidate.endLine === definition.endLine,
      );
    return callable ? { paramCount: callable.paramCount } : null;
  }
}
