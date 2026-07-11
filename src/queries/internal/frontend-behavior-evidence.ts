import { intersection, jaccard } from '../../analysis/similarity.js';

export type FrontendBehaviorEvidenceClass =
  | 'domain-behavior'
  | 'generic-workflow-scaffolding'
  | 'mixed'
  | 'shared-abstraction';
export type FrontendBehaviorActionTier = 'signal' | 'support';

export interface FrontendBehaviorEvidence {
  actionTier: FrontendBehaviorActionTier;
  evidenceClass: FrontendBehaviorEvidenceClass;
  recommendation: string;
  reasons: string[];
}

export interface FrontendPrimitiveEvidenceGroup {
  values: readonly string[];
  reasonPrefix: string;
  bucket: 'generic' | 'shared-abstraction';
}

export interface FrontendNamedEvidenceGroup {
  names: readonly string[];
  label: string;
  fallbackBucket: 'generic' | 'shared-abstraction';
}

export interface OverlapBucket {
  name: string;
  count: number;
}

export interface OverlapGateClause {
  min: Record<string, number>;
  reason: string;
}

export interface OverlapGateResult {
  pass: boolean;
  reason: string;
  counts: Record<string, number>;
}

export interface PressureAxis<Profile, Axis extends string> {
  axis: Axis;
  value: (profile: Profile) => number;
  weightedValue?: (profile: Profile, value: number) => number;
  qualifies?: (profile: Profile, value: number) => boolean;
  reason?: (profile: Profile, value: number) => string;
  dominantEligible?: boolean;
}

export interface PressureEvaluation<Axis extends string> {
  dominantPressure: Axis;
  pressureKinds: Axis[];
  reasons: string[];
}

export function classifyFrontendBehaviorEvidence(opts: {
  genericWords: ReadonlySet<string>;
  nameGroups: readonly FrontendNamedEvidenceGroup[];
  primitiveGroups: readonly FrontendPrimitiveEvidenceGroup[];
  recommendation: (evidenceClass: FrontendBehaviorEvidenceClass) => string;
  stripPrefixes?: readonly RegExp[];
}): FrontendBehaviorEvidence {
  const domainReasons: string[] = [];
  const genericReasons: string[] = [];
  const sharedAbstractionReasons: string[] = [];

  for (const group of opts.primitiveGroups) {
    if (group.values.length === 0) continue;
    reasonsForBucket(group.bucket, genericReasons, sharedAbstractionReasons).push(
      `${group.reasonPrefix}: ${group.values.join(', ')}`,
    );
  }

  for (const group of opts.nameGroups) {
    classifyNames(
      group.names,
      group.label,
      opts.genericWords,
      opts.stripPrefixes ?? [],
      domainReasons,
      reasonsForBucket(group.fallbackBucket, genericReasons, sharedAbstractionReasons),
    );
  }

  const hasDomain = domainReasons.length > 0;
  const hasGeneric = genericReasons.length > 0;
  const hasSharedAbstraction = sharedAbstractionReasons.length > 0;
  const evidenceClass: FrontendBehaviorEvidenceClass = hasDomain
    ? hasGeneric || hasSharedAbstraction
      ? 'mixed'
      : 'domain-behavior'
    : hasSharedAbstraction
      ? 'shared-abstraction'
      : 'generic-workflow-scaffolding';
  const actionTier: FrontendBehaviorActionTier =
    evidenceClass === 'domain-behavior' || evidenceClass === 'mixed' ? 'signal' : 'support';

  return {
    actionTier,
    evidenceClass,
    reasons: [...domainReasons, ...sharedAbstractionReasons, ...genericReasons].slice(0, 6),
    recommendation: opts.recommendation(evidenceClass),
  };
}

export function behaviorSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const shared = intersection(a, b).size;
  const overlap = shared / Math.min(a.size, b.size);
  // Overlap coefficient alone reports 1.0 when a tiny profile is a subset of
  // a large one. Damp it by size ratio so subset matches stay supportive.
  const dampedOverlap = overlap * Math.min(1, Math.min(a.size, b.size) / (0.35 * Math.max(a.size, b.size)));
  return Math.max(jaccard(a, b), dampedOverlap);
}

export function overlapGate(
  buckets: readonly OverlapBucket[],
  clauses: readonly OverlapGateClause[],
): OverlapGateResult {
  const counts = Object.fromEntries(buckets.map((bucket) => [bucket.name, bucket.count]));
  for (const clause of clauses) {
    const pass = Object.entries(clause.min).every(([name, min]) => (counts[name] ?? 0) >= min);
    if (pass) {
      return { pass: true, reason: clause.reason, counts };
    }
  }
  return { pass: false, reason: 'shared tokens did not meet calibrated overlap thresholds', counts };
}

export function evaluatePressure<Profile, Axis extends string>(
  profile: Profile,
  axes: readonly PressureAxis<Profile, Axis>[],
  fallbackAxis: Axis,
): PressureEvaluation<Axis> {
  const measured = axes.map((axis) => {
    const value = axis.value(profile);
    const weighted = axis.weightedValue ? axis.weightedValue(profile, value) : value;
    return {
      axis,
      value,
      weighted,
      qualifies: axis.qualifies ? axis.qualifies(profile, value) : value > 0,
    };
  });
  const reasons = measured
    .filter((entry) => entry.qualifies && entry.axis.reason)
    .map((entry) => entry.axis.reason!(profile, entry.value));
  const dominant = measured
    .filter((entry) => entry.qualifies && entry.axis.dominantEligible !== false)
    .sort((a, b) => b.weighted - a.weighted)[0];
  const dominantPressure = dominant && dominant.weighted > 0 ? dominant.axis.axis : fallbackAxis;
  const pressureKinds = [
    ...new Set(
      measured
        .filter((entry) => entry.qualifies)
        .map((entry) => entry.axis.axis)
        .concat(reasons.length > 0 ? [] : [dominantPressure]),
    ),
  ];
  return { dominantPressure, pressureKinds, reasons };
}

export function tokenValues(tokens: ReadonlySet<string>, prefix: string): string[] {
  return [...tokens]
    .filter((token) => token.startsWith(prefix))
    .map((token) => token.slice(prefix.length))
    .sort();
}

export function sortedTokens(tokens: ReadonlySet<string>): string[] {
  return [...tokens].sort();
}

function classifyNames(
  names: readonly string[],
  label: string,
  genericWords: ReadonlySet<string>,
  stripPrefixes: readonly RegExp[],
  domainReasons: string[],
  fallbackReasons: string[],
): void {
  const domainNames: string[] = [];
  const genericNames: string[] = [];
  for (const name of names) {
    const words = behaviorWords(name, stripPrefixes).filter((word) => !genericWords.has(word));
    if (words.length > 0) {
      domainNames.push(name);
    } else {
      genericNames.push(name);
    }
  }
  if (domainNames.length) domainReasons.push(`${label} has domain term(s): ${domainNames.slice(0, 6).join(', ')}`);
  if (genericNames.length) fallbackReasons.push(`${label} is generic workflow: ${genericNames.slice(0, 6).join(', ')}`);
}

function behaviorWords(name: string, stripPrefixes: readonly RegExp[]): string[] {
  let normalized = name.replace(/([A-Z])([A-Z][a-z])/g, '$1 $2').replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  for (const prefix of stripPrefixes) {
    normalized = normalized.replace(prefix, '');
  }
  return normalized
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function reasonsForBucket(
  bucket: 'generic' | 'shared-abstraction',
  genericReasons: string[],
  sharedAbstractionReasons: string[],
): string[] {
  return bucket === 'generic' ? genericReasons : sharedAbstractionReasons;
}
