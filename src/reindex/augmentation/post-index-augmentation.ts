import { writeFileSync } from 'node:fs';
import { readTextFileWithinLimit, SMALL_ARTIFACT_MAX_BYTES } from '../../filesystem/bounded-file.js';

export type PostIndexAugmentationFact =
  | 'auxiliary-document'
  | 'synthetic-symbol'
  | 'source-mapped-occurrence'
  | 'definition-mention'
  | 'replacement-chunk'
  | 'fingerprint-cache'
  | 'runtime-boundary-observation'
  | 'runtime-boundary-link';

export interface PostIndexAugmentationContext {
  projectRoot: string;
  dbPath: string;
  onStatus?: (message: string) => void;
}

export interface PostIndexAugmentationStage<Result> {
  id: string;
  facts: readonly PostIndexAugmentationFact[];
  run(context: PostIndexAugmentationContext): Result;
}

export function runPostIndexAugmentation<Result>(
  stage: PostIndexAugmentationStage<Result>,
  context: PostIndexAugmentationContext,
): { stageId: string; facts: readonly PostIndexAugmentationFact[]; durationMs: number; result: Result } {
  const start = performance.now();
  const result = stage.run(context);
  return {
    stageId: stage.id,
    facts: stage.facts,
    durationMs: performance.now() - start,
    result,
  };
}

/**
 * A stage whose sweep must yield the event loop: native resources owned by
 * GC finalizers (tree-sitter trees and node cache entries) are freed by V8
 * second-pass callbacks that only run on loop turns, so a fully synchronous
 * whole-repository stage retains every tree it ever parsed until it exits.
 */
export interface AsyncPostIndexAugmentationStage<Result> {
  id: string;
  facts: readonly PostIndexAugmentationFact[];
  run(context: PostIndexAugmentationContext): Promise<Result>;
}

export async function runPostIndexAugmentationAsync<Result>(
  stage: AsyncPostIndexAugmentationStage<Result>,
  context: PostIndexAugmentationContext,
): Promise<{ stageId: string; facts: readonly PostIndexAugmentationFact[]; durationMs: number; result: Result }> {
  const start = performance.now();
  const result = await stage.run(context);
  return {
    stageId: stage.id,
    facts: stage.facts,
    durationMs: performance.now() - start,
    result,
  };
}

export function runFingerprintCachedPostIndexAugmentation<Result, Fingerprint>(opts: {
  cachePath: string;
  readFingerprint: () => Fingerprint;
  compute: () => Result;
  onCacheHit?: (result: Result) => void;
}): Result {
  const currentFingerprint = opts.readFingerprint();
  const cached = readFingerprintCache<Result, Fingerprint>(opts.cachePath, currentFingerprint);
  if (cached) {
    opts.onCacheHit?.(cached.result);
    return cached.result;
  }

  const result = opts.compute();
  writeFingerprintCache(opts.cachePath, opts.readFingerprint(), result);
  return result;
}

export async function runFingerprintCachedPostIndexAugmentationAsync<Result, Fingerprint>(opts: {
  cachePath: string;
  readFingerprint: () => Fingerprint;
  compute: () => Promise<Result>;
  onCacheHit?: (result: Result) => void;
}): Promise<Result> {
  const currentFingerprint = opts.readFingerprint();
  const cached = readFingerprintCache<Result, Fingerprint>(opts.cachePath, currentFingerprint);
  if (cached) {
    opts.onCacheHit?.(cached.result);
    return cached.result;
  }

  const result = await opts.compute();
  writeFingerprintCache(opts.cachePath, opts.readFingerprint(), result);
  return result;
}

function readFingerprintCache<Result, Fingerprint>(
  cachePath: string,
  fingerprint: Fingerprint,
): { result: Result } | null {
  try {
    const cache = JSON.parse(
      readTextFileWithinLimit(cachePath, {
        maxBytes: SMALL_ARTIFACT_MAX_BYTES,
        inputKind: 'post-index augmentation cache',
      }),
    ) as { fingerprint: Fingerprint; result: Result };
    return stableJson(cache.fingerprint) === stableJson(fingerprint) ? { result: cache.result } : null;
  } catch {
    return null;
  }
}

function writeFingerprintCache<Result, Fingerprint>(cachePath: string, fingerprint: Fingerprint, result: Result): void {
  writeFileSync(
    cachePath,
    `${JSON.stringify(
      {
        updatedAt: new Date().toISOString(),
        fingerprint,
        result,
      },
      null,
      2,
    )}\n`,
  );
}

// scip-query: ignore-twin — stable encoders are local to independently versioned persisted identities.
function stableJson(value: unknown): string {
  return JSON.stringify(value);
}
