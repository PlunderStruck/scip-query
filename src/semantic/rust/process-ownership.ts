import { randomUUID } from 'node:crypto';
import { readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseProcessIdentity } from '../../domain/process-identity.js';
import { readTextFileWithinLimit } from '../../platform/bounded-file.js';
import {
  terminateOwnedProcessTree,
  type OwnedProcessTree,
  type ProcessTreeTerminationResult,
} from '../../platform/process-tree.js';

const OWNERSHIP_FILE_PREFIX = 'rust-analyzer-owner-';
const OWNERSHIP_FILE_SUFFIX = '.json';
const OWNERSHIP_RECORD_MAX_BYTES = 16 * 1024;

interface RustAnalyzerOwnershipRecord {
  version: 1;
  rootIdentity: OwnedProcessTree['rootIdentity'];
  ownsProcessGroup: boolean;
}

export function registerRustAnalyzerProcessTree(directory: string | undefined, tree: OwnedProcessTree): string | null {
  if (!directory || !tree.rootIdentity) return null;
  const path = join(directory, `${OWNERSHIP_FILE_PREFIX}${tree.rootPid}-${randomUUID()}${OWNERSHIP_FILE_SUFFIX}`);
  const record: RustAnalyzerOwnershipRecord = {
    version: 1,
    rootIdentity: tree.rootIdentity,
    ownsProcessGroup: tree.ownsProcessGroup,
  };
  writeFileSync(path, `${JSON.stringify(record)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  return path;
}

export function releaseRustAnalyzerProcessTree(path: string | null): void {
  if (!path) return;
  rmSync(path, { force: true });
}

export async function terminateRegisteredRustAnalyzerProcessTrees(
  directory: string | null,
  options: { gracefulMs: number; forceMs: number },
): Promise<ProcessTreeTerminationResult[]> {
  if (!directory) return [];
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return [];
  }

  const ownershipPaths = entries
    .filter((entry) => entry.startsWith(OWNERSHIP_FILE_PREFIX) && entry.endsWith(OWNERSHIP_FILE_SUFFIX))
    .map((entry) => join(directory, entry));
  const results: ProcessTreeTerminationResult[] = [];
  const trees: OwnedProcessTree[] = [];
  for (const path of ownershipPaths) {
    const tree = readOwnershipTree(path);
    if (tree) {
      trees.push(tree);
    } else {
      results.push({
        reaped: false,
        reason: 'identity-unavailable',
        detail: `Rust analyzer ownership record ${path} could not be validated.`,
      });
    }
  }
  results.push(...(await Promise.all(trees.map((tree) => terminateOwnedProcessTree(tree, options)))));
  return results;
}

function readOwnershipTree(path: string): OwnedProcessTree | null {
  try {
    const raw = readTextFileWithinLimit(path, {
      maxBytes: OWNERSHIP_RECORD_MAX_BYTES,
      inputKind: 'rust-analyzer process ownership record',
    });
    const value = JSON.parse(raw) as Partial<RustAnalyzerOwnershipRecord>;
    const rootIdentity = parseProcessIdentity(value.rootIdentity);
    if (value.version !== 1 || !rootIdentity || typeof value.ownsProcessGroup !== 'boolean') return null;
    return {
      rootPid: rootIdentity.pid,
      rootIdentity,
      ownsProcessGroup: value.ownsProcessGroup,
      knownMembers: new Map([[rootIdentity.pid, rootIdentity]]),
    };
  } catch {
    return null;
  }
}
