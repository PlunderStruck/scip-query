import { basename, dirname, resolve } from 'node:path';
import { isTypeScriptCompilerShardConfigPath } from '../platform/typescript-projects.js';
import { collectNativeGarbage } from '../domain/native-gc.js';

interface ProjectIndexer {
  config: { fileNames: string[]; raw?: { scipQueryEmissionFiles?: unknown } };
  options: { projectRoot: string };
  index(): void;
}

interface ProjectIndexerConstructor {
  new (config: ProjectIndexer['config'], options: ProjectIndexer['options'], cache: unknown): ProjectIndexer;
}

/** Release the previous batch's checker before constructing another over the shared parsed sources. */
export function withTypeScriptBatchCollection(
  constructor: ProjectIndexerConstructor,
  collect: () => unknown = collectNativeGarbage,
): ProjectIndexerConstructor {
  let previousWasShard = false;
  return new Proxy(constructor, {
    construct(target, args, newTarget) {
      const options = args[1] as ProjectIndexer['options'];
      const shard = isTypeScriptCompilerShardConfigPath(basename(options.projectRoot));
      // Project references can run with different compiler options before an
      // owned batch. Upstream's source cache does not compare every option
      // affecting parsing; never carry those trees across this boundary.
      if (previousWasShard !== shard) {
        const cache = args[2] as { sources: Map<unknown, unknown>; parsedCommandLines: Map<unknown, unknown> };
        cache.sources.clear();
        cache.parsedCommandLines.clear();
      }
      if (previousWasShard && shard) collect();
      previousWasShard = shard;
      return Reflect.construct(target, args, newTarget);
    },
  });
}

/** Bound document emission only after the upstream constructor builds the full program. */
export function installTypeScriptProjectEmission(prototype: ProjectIndexer): void {
  const originalIndex = prototype.index;
  if (typeof originalIndex !== 'function') throw new Error('Unsupported scip-typescript project indexer');
  prototype.index = function () {
    if (!isTypeScriptCompilerShardConfigPath(basename(this.options.projectRoot))) {
      return originalIndex.call(this);
    }
    const selected: unknown = this.config.raw?.scipQueryEmissionFiles;
    if (!Array.isArray(selected) || selected.length === 0 || !selected.every((file) => typeof file === 'string')) {
      throw new Error('Compiler shard is missing its emission file manifest');
    }
    const root = dirname(resolve(this.options.projectRoot));
    const names = new Set(this.config.fileNames);
    const files = selected.map((file: string) => resolve(root, file));
    if (files.some((file) => !names.has(file)) || new Set(files).size !== files.length) {
      throw new Error('Compiler shard emission files must be unique members of the complete compiler project');
    }
    const completeConfig = this.config;
    this.config = { ...completeConfig, fileNames: files };
    try {
      return originalIndex.call(this);
    } finally {
      this.config = completeConfig;
    }
  };
}
