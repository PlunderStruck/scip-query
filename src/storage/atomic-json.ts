import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface AtomicJsonWriteOptions {
  spacing?: number;
  trailingNewline?: boolean;
}

/**
 * Replaces one JSON file only after its complete next value is durable enough
 * for a same-filesystem rename. Readers therefore observe the old complete
 * value or the new complete value, never a partially written JSON document.
 */
export function writeJsonAtomic(path: string, value: unknown, options: AtomicJsonWriteOptions = {}): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  const json = JSON.stringify(value, null, options.spacing);
  writeFileSync(temporaryPath, options.trailingNewline ? `${json}\n` : json);
  renameSync(temporaryPath, path);
}
