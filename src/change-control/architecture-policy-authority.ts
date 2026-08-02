import { stableJson } from '../domain/stable-json.js';

type JsonRecord = Record<string, unknown>;

/**
 * A monotonic architecture-policy tightening is a repository configuration
 * edit whose only semantic effect is to remove previously allowed boundary
 * dependencies. It keeps every boundary, policy switch, dependency-row owner,
 * and unrelated configuration fact fixed, so it can strengthen enforcement
 * but cannot weaken it.
 */
export function isMonotonicArchitecturePolicyTightening(predecessorSource: string, successorSource: string): boolean {
  const predecessor = parseRecord(predecessorSource);
  const successor = parseRecord(successorSource);
  if (!predecessor || !successor) return false;

  const predecessorArchitecture = recordAt(predecessor, 'architecture');
  const successorArchitecture = recordAt(successor, 'architecture');
  if (!predecessorArchitecture || !successorArchitecture) return false;

  if (!equalWithout(predecessor, successor, 'architecture')) return false;
  if (!equalWithout(predecessorArchitecture, successorArchitecture, 'allowedDependencies')) return false;

  const predecessorRows = recordAt(predecessorArchitecture, 'allowedDependencies');
  const successorRows = recordAt(successorArchitecture, 'allowedDependencies');
  if (!predecessorRows || !successorRows) return false;

  const predecessorOwners = Object.keys(predecessorRows).sort();
  const successorOwners = Object.keys(successorRows).sort();
  if (stableJson(predecessorOwners) !== stableJson(successorOwners)) return false;

  let removedPermission = false;
  for (const owner of predecessorOwners) {
    const predecessorTargets = stringSet(predecessorRows[owner]);
    const successorTargets = stringSet(successorRows[owner]);
    if (!predecessorTargets || !successorTargets) return false;
    for (const target of successorTargets) {
      if (!predecessorTargets.has(target)) return false;
    }
    if (successorTargets.size < predecessorTargets.size) removedPermission = true;
  }
  return removedPermission;
}

function parseRecord(source: string): JsonRecord | undefined {
  try {
    const value: unknown = JSON.parse(source);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function recordAt(record: JsonRecord, key: string): JsonRecord | undefined {
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function equalWithout(left: JsonRecord, right: JsonRecord, omittedKey: string): boolean {
  return stableJson(without(left, omittedKey)) === stableJson(without(right, omittedKey));
}

function without(record: JsonRecord, omittedKey: string): JsonRecord {
  return Object.fromEntries(Object.entries(record).filter(([key]) => key !== omittedKey));
}

function stringSet(value: unknown): Set<string> | undefined {
  if (!Array.isArray(value) || !value.every((entry): entry is string => typeof entry === 'string')) return undefined;
  return new Set(value);
}
