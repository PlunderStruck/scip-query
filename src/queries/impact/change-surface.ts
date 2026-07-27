import type { ScipDatabase } from '../../storage/db.js';
import { ProjectIndex } from '../internal/project-index.js';
import { resolveIndexedFile } from '../internal/file-resolution.js';
import type { IndexedDefinition } from '../../domain/types.js';
import { semanticCallerMap } from '../../semantic/shared-primitives.js';
import { shortenSymbol } from '../../symbols/symbol-parser.js';
import {
  inspectFileChangeRiskMetadata,
  type ChangeRiskReason,
  type FileChangeRiskMetadata,
} from '../../analysis/change-risk-metadata.js';

export type ChangeSurfaceRiskReason = ChangeRiskReason | { kind: 'external-consumers'; detail: string };

export interface ChangeSurfaceEntry {
  symbol: string;
  shortName: string;
  startLine: number;
  endLine: number;
  externalConsumers: number;
  externalConsumerRiskLevel?: 'low' | 'medium' | 'high';
  riskLevel: 'low' | 'medium' | 'high';
  riskReasons?: ChangeSurfaceRiskReason[];
}

export interface ChangeSurfaceResult {
  file: string;
  symbols: ChangeSurfaceEntry[];
  totalExternalConsumers: number;
  fileRisk?: FileChangeRiskMetadata;
}

/**
 * Pre-change briefing for a file. For each symbol defined in the file,
 * reports external consumer count and blast-radius risk.
 *
 * Symbol ranges come from getDefinitionsForFile so they are source-corrected
 * and match `scip symbols` output.
 */
// scip-query: ignore-extract — this is the command-level risk projection:
// definitions, external consumer counts, and risk labels are intentionally
// assembled into the public result shape here.
export function changeSurface(
  db: ScipDatabase,
  filePattern: string,
  opts: { semantic?: boolean } = {},
): ChangeSurfaceResult | null {
  const resolvedFile = resolveIndexedFile(db, filePattern);
  if (!resolvedFile) return null;

  const doc = loadChangeSurfaceDocument(db, resolvedFile);
  if (!doc || db.isIgnored(doc.relative_path)) return null;

  const symbols: ChangeSurfaceEntry[] = [];
  let totalExternalConsumers = 0;
  const definitions = sortedChangeSurfaceDefinitions(db, doc.relative_path);
  const fileRisk = inspectFileChangeRiskMetadata(db, doc.relative_path);
  const semanticConsumers =
    opts.semantic === false ? new Map<number, Set<string>>() : semanticCallerMap(db, definitions);

  for (const def of definitions) {
    const externalConsumers = externalConsumerCount(
      db,
      doc,
      def,
      semanticConsumers.get(def.symbolId) ?? new Set<string>(),
    );
    totalExternalConsumers += externalConsumers;
    const externalConsumerRiskLevel = riskLevelForConsumers(externalConsumers);
    const riskReasons: ChangeSurfaceRiskReason[] = [
      ...fileRisk.reasons,
      ...(externalConsumers > 0
        ? [
            {
              kind: 'external-consumers' as const,
              detail: `${externalConsumers} external consumer${externalConsumers === 1 ? '' : 's'}`,
            },
          ]
        : []),
    ];

    symbols.push({
      symbol: def.symbol,
      shortName: shortenSymbol(def.symbol),
      startLine: def.startLine,
      endLine: def.endLine,
      externalConsumers,
      externalConsumerRiskLevel,
      riskLevel: aggregateRiskLevel(externalConsumerRiskLevel, fileRisk),
      riskReasons,
    });
  }

  return {
    file: doc.relative_path,
    symbols,
    totalExternalConsumers,
    fileRisk,
  };
}

function loadChangeSurfaceDocument(
  db: ScipDatabase,
  relativePath: string,
): { id: number; relative_path: string } | null {
  return (
    db.get<{ id: number; relative_path: string }>(
      `SELECT id, relative_path FROM documents
     WHERE relative_path = ?
       ${db.pathExclusionsFor('documents')}
     LIMIT 1`,
      relativePath,
    ) ?? null
  );
}

function sortedChangeSurfaceDefinitions(db: ScipDatabase, relativePath: string) {
  return new ProjectIndex(db)
    .definitionsForFile(relativePath)
    .sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
}

function externalConsumerCount(
  db: ScipDatabase,
  doc: { id: number; relative_path: string },
  def: IndexedDefinition,
  semanticConsumers: ReadonlySet<string>,
): number {
  const consumerRows = db.all<{ relative_path: string }>(
    `SELECT DISTINCT consumer_d.relative_path
    FROM mentions m
    JOIN chunks c ON m.chunk_id = c.id
    JOIN documents consumer_d ON consumer_d.id = c.document_id
    WHERE m.symbol_id = ?
      AND m.role != 1
      AND c.document_id != ?`,
    def.symbolId,
    doc.id,
  );

  return new Set([
    ...consumerRows.map((row) => row.relative_path),
    ...[...semanticConsumers].filter((file) => file !== doc.relative_path),
  ]).size;
}

function riskLevelForConsumers(externalConsumers: number): 'low' | 'medium' | 'high' {
  if (externalConsumers > 10) return 'high';
  if (externalConsumers > 0) return 'medium';
  return 'low';
}

function aggregateRiskLevel(
  externalConsumerRiskLevel: 'low' | 'medium' | 'high',
  fileRisk: FileChangeRiskMetadata,
): ChangeSurfaceEntry['riskLevel'] {
  if (externalConsumerRiskLevel === 'high') return 'high';
  if (
    externalConsumerRiskLevel === 'medium' ||
    fileRisk.operationalRoot ||
    fileRisk.publishedApi ||
    fileRisk.coverage === 'partial'
  ) {
    return 'medium';
  }
  return 'low';
}
