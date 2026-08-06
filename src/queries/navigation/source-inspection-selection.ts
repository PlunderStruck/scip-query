import type { FileKind } from '../../source/primitives/file-kind.js';
import type { BehaviorSignal } from '../../source/facts/behavior-skeleton.js';

export interface InspectionSelectionCandidate {
  priority: number;
  sequence: number;
  relativePath: string;
  fileKind: FileKind;
  evidenceCharacters: number;
  roles: readonly string[];
  reasons: readonly string[];
  symbols: readonly string[];
  behaviorSignals: readonly BehaviorSignal[];
  channel?: string;
}

export interface InspectionSelection<T> {
  selected: T[];
  omitted: T[];
}

/**
 * Apply one independent unit ceiling per evidence channel before the global
 * packet selector. A noisy channel can therefore disclose and fold its own
 * overflow without consuming every slot needed by other evidence kinds.
 */
export function selectInspectionCandidatesByChannel<T extends InspectionSelectionCandidate>(
  candidates: readonly T[],
  maxUnitsByChannel: Readonly<Record<string, number>>,
  compareStable: (left: T, right: T) => number,
): InspectionSelection<T> {
  const selected: T[] = [];
  const omitted: T[] = [];
  const selectedByChannel = new Map<string, number>();
  for (const candidate of [...candidates].sort(compareStable)) {
    const channel = candidate.channel ?? 'default';
    const limit = maxUnitsByChannel[channel] ?? Number.MAX_SAFE_INTEGER;
    const used = selectedByChannel.get(channel) ?? 0;
    if (used >= limit) {
      omitted.push(candidate);
      continue;
    }
    selected.push(candidate);
    selectedByChannel.set(channel, used + 1);
  }
  return { selected, omitted };
}

interface WeightedFeature {
  key: string;
  weight: number;
}

/**
 * Fill a packet by marginal structural coverage instead of source order.
 * Exact selectors remain dominant; later choices prefer evidence that adds a
 * selector, role, file, scope, symbol, or behavior signal not already present.
 */
export function selectInspectionCandidates<T extends InspectionSelectionCandidate>(
  candidates: readonly T[],
  maxUnits: number,
  maxCharacters: number,
  compareStable: (left: T, right: T) => number,
): InspectionSelection<T> {
  const remaining = [...candidates];
  const selected: T[] = [];
  const covered = new Set<string>();
  let selectedCharacters = 0;

  while (remaining.length > 0 && selected.length < maxUnits) {
    const fitting = remaining.filter(
      (candidate) => selected.length === 0 || selectedCharacters + candidate.evidenceCharacters <= maxCharacters,
    );
    if (fitting.length === 0) break;

    const exact = fitting
      .filter((candidate) => candidate.roles.includes('location') || candidate.roles.includes('definition'))
      .sort(compareStable);
    fitting.sort((left, right) => {
      const scoreDifference = marginalScore(right, covered) - marginalScore(left, covered);
      return scoreDifference || compareStable(left, right);
    });
    const chosen = exact[0] ?? fitting[0]!;
    selected.push(chosen);
    selectedCharacters += chosen.evidenceCharacters;
    for (const feature of coverageFeatures(chosen)) covered.add(feature.key);
    remaining.splice(remaining.indexOf(chosen), 1);
  }

  return { selected, omitted: remaining.sort(compareStable) };
}

function marginalScore(candidate: InspectionSelectionCandidate, covered: ReadonlySet<string>): number {
  const marginalGain = coverageFeatures(candidate).reduce(
    (total, feature) => total + (covered.has(feature.key) ? 0 : feature.weight),
    0,
  );
  const priorityBonus = Math.max(0, 8 - candidate.priority) * 20;
  const characterCost = Math.min(500, Math.ceil(candidate.evidenceCharacters / 160));
  return marginalGain + priorityBonus - characterCost;
}

function coverageFeatures(candidate: InspectionSelectionCandidate): WeightedFeature[] {
  return [
    ...candidate.reasons.map(normalizedReasonFeature),
    ...candidate.roles.map((role) => ({ key: `role:${role}`, weight: roleWeight(role) })),
    { key: `file:${candidate.relativePath}`, weight: 180 },
    { key: `scope:${parentPath(candidate.relativePath)}`, weight: 120 },
    { key: `kind:${candidate.fileKind}`, weight: 40 },
    ...candidate.symbols.map((symbol) => ({ key: `symbol:${symbol}`, weight: 100 })),
    ...candidate.behaviorSignals.map((signal) => ({ key: `behavior:${signal}`, weight: 70 })),
  ];
}

function normalizedReasonFeature(reason: string): WeightedFeature {
  const separator = reason.indexOf(':');
  const role = separator < 0 ? reason : reason.slice(0, separator);
  if (role === 'dependency' || role === 'consumer') {
    return { key: `reason:${role}`, weight: 220 };
  }
  return { key: `reason:${reason}`, weight: role === 'location' || role === 'definition' ? 1_400 : 800 };
}

function roleWeight(role: string): number {
  switch (role) {
    case 'location':
      return 1_200;
    case 'definition':
      return 1_100;
    case 'reference':
      return 600;
    case 'caller':
    case 'callee':
      return 550;
    case 'dependency':
    case 'consumer':
      return 500;
    case 'search':
      return 400;
    default:
      return 300;
  }
}

function parentPath(relativePath: string): string {
  const separator = relativePath.lastIndexOf('/');
  return separator < 0 ? relativePath : relativePath.slice(0, separator);
}
