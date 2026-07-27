import { classifyFile, isFrameworkEntrypointPath } from './file-classifier.js';
import { isPackageSurfaceFile, packageOperationalRootReasons } from './package-surface.js';
import { normalizePathSeparators as normalizePath } from '../domain/path-normalization.js';
import { isMissingProjectFileError, readProjectFileText } from '../source/primitives/project-file-boundary.js';
import type { ScipDatabase } from '../storage/db.js';

export type ChangeRiskReasonKind = 'operational-root' | 'published-api' | 'metadata-unavailable';

export interface ChangeRiskReason {
  kind: ChangeRiskReasonKind;
  detail: string;
}

export interface FileChangeRiskMetadata {
  operationalRoot: boolean;
  publishedApi: boolean;
  coverage: 'complete' | 'partial';
  reasons: ChangeRiskReason[];
}

/**
 * Identify launch and publication facts that a source-import graph cannot
 * represent. Partial means a relevant metadata source could not be read; it
 * never means the file was proven private.
 */
export function inspectFileChangeRiskMetadata(db: ScipDatabase, file: string): FileChangeRiskMetadata {
  const normalized = normalizePath(file);
  const reasons: ChangeRiskReason[] = [];
  let coverage: FileChangeRiskMetadata['coverage'] = 'complete';

  const kind = classifyFile(normalized);
  if (kind === 'entry') addReason(reasons, 'operational-root', 'structural entrypoint path');
  if (kind === 'worker') addReason(reasons, 'operational-root', 'worker launch convention');
  if (isFrameworkEntrypointPath(normalized)) {
    addReason(reasons, 'operational-root', 'framework-discovered entrypoint');
  }
  if (matchesConfiguredEntryRoot(db, normalized)) {
    addReason(reasons, 'operational-root', 'configured entry root');
  }

  let publishedApi = false;
  try {
    publishedApi = isPackageSurfaceFile(db, normalized);
    if (publishedApi) addReason(reasons, 'published-api', 'package manifest export');
    for (const detail of packageOperationalRootReasons(db, normalized)) {
      addReason(reasons, 'operational-root', detail);
    }
  } catch (error) {
    coverage = 'partial';
    addReason(reasons, 'metadata-unavailable', `package metadata unavailable: ${errorMessage(error)}`);
  }

  try {
    const source = readProjectFileText(db.config.projectRoot, normalized, {
      maxBytes: 8 * 1024 * 1024,
      inputKind: 'change-surface source',
    });
    if (hasDirectExecutionGuard(source)) {
      addReason(reasons, 'operational-root', 'module contains a direct-execution process guard');
    }
  } catch (error) {
    coverage = 'partial';
    addReason(
      reasons,
      'metadata-unavailable',
      isMissingProjectFileError(error)
        ? 'indexed source file is unavailable on disk'
        : `source metadata unavailable: ${errorMessage(error)}`,
    );
  }

  return {
    operationalRoot: reasons.some((reason) => reason.kind === 'operational-root'),
    publishedApi,
    coverage,
    reasons,
  };
}

function matchesConfiguredEntryRoot(db: ScipDatabase, file: string): boolean {
  const roots = db.config.entryRoots;
  if (!roots) return false;
  if (roots.files?.some((candidate) => normalizePath(candidate) === file)) return true;
  return roots.pathPrefixes?.some((prefix) => file.startsWith(normalizePath(prefix))) ?? false;
}

function hasDirectExecutionGuard(source: string): boolean {
  return (
    (source.includes('import.meta.url') && /process\.argv\s*\[\s*1\s*\]/.test(source)) ||
    /require\.main\s*===\s*module/.test(source) ||
    /__name__\s*==\s*['"]__main__['"]/.test(source)
  );
}

function addReason(reasons: ChangeRiskReason[], kind: ChangeRiskReasonKind, detail: string): void {
  if (!reasons.some((reason) => reason.kind === kind && reason.detail === detail)) {
    reasons.push({ kind, detail });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
