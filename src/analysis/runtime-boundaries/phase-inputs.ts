import { sha256Hex as hashText, evidenceProductVersionKey } from '../../storage/evidence-cache.js';
import { withFileAccessRecording } from '../../domain/file-access-recorder.js';
import { readProjectFileText } from '../../source/primitives/project-file-boundary.js';
import { ScipDatabase } from '../../storage/db.js';
import type { BoundaryObservation, RuntimeBoundaryBodySummary, RuntimePhaseRecord } from './types.js';

/** Inputs and immutable output of one completed synchronous runtime phase. */

/** Resolution is assigned after propagation; it is not an input to either phase. */
export function runtimePhaseSeeds(
  observations: readonly BoundaryObservation[],
  bodies: readonly RuntimeBoundaryBodySummary[] = [],
): string {
  return hashText(
    JSON.stringify({
      observations: observations.map(({ resolution: _resolution, ...observation }) => observation),
      bodies,
    }),
  );
}

export function runtimePhaseScope(db: ScipDatabase, files: readonly string[]): string {
  const {
    dbPath: _dbPath,
    indexPath: _indexPath,
    evidenceDbPath: _evidenceDbPath,
    sharedEvidenceDbPath: _sharedEvidenceDbPath,
    ...configuration
  } = db.config;
  return hashText(JSON.stringify({ configuration, files: files.map((file) => [file, db.isIgnored(file)]) }));
}

interface PhaseResult {
  errors: string[];
}

/**
 * Reuse requires independently verified identical compiler documents. File reads
 * include negative queries and intermediate helpers, not only displayed proofs.
 * A fresh reader gives every source-derived in-memory cache a cold identity so
 * a cache filled outside the recording cannot hide a dependency.
 */
export function materializeRuntimePhase<Result extends PhaseResult>(opts: {
  db: ScipDatabase;
  scope: string;
  seeds: string;
  compilerFactsUnchanged: boolean;
  previous?: RuntimePhaseRecord<Result>;
  compute(db: ScipDatabase): Result;
}): { result: Result; record?: RuntimePhaseRecord<Result>; reused: boolean } {
  if (reusablePhase(opts)) {
    return { result: structuredClone(opts.previous!.result), record: opts.previous, reused: true };
  }
  const reader = new ScipDatabase(opts.db.config, { isIgnored: (file) => opts.db.isIgnored(file) });
  try {
    if (reader.generation.identity !== opts.db.generation.identity) {
      // The enclosing read still owns its original generation. Recompute there
      // without retaining a proof instead of mixing a newer publication into it.
      return { result: opts.compute(opts.db), reused: false };
    }
    return recordRuntimePhase(reader, opts);
  } finally {
    reader.close();
  }
}

function reusablePhase<Result extends PhaseResult>(opts: {
  db: ScipDatabase;
  scope: string;
  seeds: string;
  compilerFactsUnchanged: boolean;
  previous?: RuntimePhaseRecord<Result>;
}): boolean {
  const previous = opts.previous;
  if (
    !opts.compilerFactsUnchanged ||
    !previous ||
    previous.build !== evidenceProductVersionKey() ||
    previous.scope !== opts.scope ||
    previous.seeds !== opts.seeds ||
    !Array.isArray(previous.sources) ||
    !Array.isArray(previous.result?.errors) ||
    previous.result.errors.length > 0
  ) {
    return false;
  }
  return previous.sources.every(
    (source) =>
      source &&
      typeof source.file === 'string' &&
      typeof source.hash === 'string' &&
      currentSourceHash(opts.db, source.file) === source.hash,
  );
}

function recordRuntimePhase<Result extends PhaseResult>(
  reader: ScipDatabase,
  opts: {
    scope: string;
    seeds: string;
    compute(db: ScipDatabase): Result;
  },
): { result: Result; record?: RuntimePhaseRecord<Result>; reused: false } {
  const files = new Set<string>();
  const hashes = new Map<string, string>();
  const sourceTexts = new Map<string, string>();
  let available = true;
  const result = withFileAccessRecording(
    (file) => files.add(file.replace(/\\/g, '/')),
    () => opts.compute(reader),
    undefined,
    {
      source(file, source) {
        file = file.replace(/\\/g, '/');
        if (sourceTexts.get(file) === source) return;
        sourceTexts.set(file, source);
        const hash = hashText(source);
        const prior = hashes.get(file);
        if (prior !== undefined && prior !== hash) available = false;
        hashes.set(file, hash);
      },
      unavailable() {
        available = false;
      },
    },
  );
  // Require the actual bytes used by the computation, not bytes read later and
  // incorrectly attached to an older answer. Unrecorded reads prevent retention.
  const sources = [...files].sort().map((file) => ({ file, hash: hashes.get(file) }));
  if (
    !available ||
    result.errors.length > 0 ||
    sources.some(({ file, hash }) => hash === undefined || currentSourceHash(reader, file) !== hash)
  ) {
    return { result, reused: false };
  }
  return {
    result,
    reused: false,
    record: {
      build: evidenceProductVersionKey(),
      scope: opts.scope,
      seeds: opts.seeds,
      sources: sources as { file: string; hash: string }[],
      result: structuredClone(result),
    },
  };
}

function currentSourceHash(db: ScipDatabase, file: string): string | null {
  try {
    return hashText(readProjectFileText(db.config.projectRoot, file, { inputKind: 'runtime phase input' }));
  } catch {
    return null;
  }
}
