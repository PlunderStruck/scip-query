import { profileSpan } from '../../instrumentation/profile.js';

export interface PairwiseFileProfile {
  file: string;
}

export type PairwiseProfileMetadata = Record<string, unknown>;

export interface PairwiseProfileRun {
  name: string;
  metadata?: PairwiseProfileMetadata | (() => PairwiseProfileMetadata);
}

// scip-query: ignore-stale — exported profile-counter contract shared by
// pairwise detectors and focused kernel tests.
export interface PairwiseProfileCounters {
  pipeline: string | undefined;
  profileCount: number;
  focusedProfileCount: number;
  candidatePairs: number;
  comparedPairs: number;
  matchedResults: number;
  emittedResults: number;
  candidateIndexApplied: boolean;
  focusApplied: boolean;
  filePatternApplied: boolean;
  overrunApplied: boolean;
}

// scip-query: ignore-stale — exported pair-selection contract used by current
// profile detectors and intended for future pairwise kernels.
export interface PairwiseCandidateIndex<Profile extends PairwiseFileProfile> {
  candidatesFor(profile: Profile, index: number, profiles: readonly Profile[]): Iterable<number>;
}

interface RankedPairwiseProfileOptions<Profile extends PairwiseFileProfile, Result> {
  profiles: readonly Profile[];
  limit: number;
  filePattern?: string;
  focusFiles?: ReadonlySet<string>;
  overrunFactor?: number;
  candidateIndex?: PairwiseCandidateIndex<Profile>;
  compare: (left: Profile, right: Profile) => Result | null;
  sort?: (left: Result, right: Result) => number;
  profile?: PairwiseProfileRun;
  onProfile?: (counters: PairwiseProfileCounters) => void;
}

export function pairwiseCandidateIndexFromKeys<Profile extends PairwiseFileProfile, Key extends PropertyKey>(
  profiles: readonly Profile[],
  keysFor: (profile: Profile) => Iterable<Key>,
): PairwiseCandidateIndex<Profile> {
  const indexesByKey = new Map<Key, number[]>();
  profiles.forEach((profile, index) => {
    const seen = new Set<Key>();
    for (const key of keysFor(profile)) {
      if (seen.has(key)) continue;
      seen.add(key);
      const bucket = indexesByKey.get(key);
      if (bucket) bucket.push(index);
      else indexesByKey.set(key, [index]);
    }
  });

  return {
    candidatesFor: (profile, index) => {
      const candidates = new Set<number>();
      for (const key of keysFor(profile)) {
        const bucket = indexesByKey.get(key);
        if (!bucket) continue;
        for (const candidateIndex of bucket) {
          if (candidateIndex !== index) candidates.add(candidateIndex);
        }
      }
      return [...candidates].sort((left, right) => left - right);
    },
  };
}

// scip-query: ignore-extract — reviewed E1 workflow owner; ordered policy and shared state stay in this named operation.
export function rankedPairwiseProfileResults<
  Profile extends PairwiseFileProfile,
  Result extends { similarity: number },
>(opts: RankedPairwiseProfileOptions<Profile, Result>): Result[] {
  let counters = emptyPairwiseProfileCounters(opts.profile?.name);

  const run = (): Result[] => {
    const results: Result[] = [];
    counters = emptyPairwiseProfileCounters(opts.profile?.name, opts);

    const compareIndexes = (leftIndex: number, rightIndex: number): void => {
      const left = opts.profiles[leftIndex]!;
      const right = opts.profiles[rightIndex]!;
      counters.candidatePairs += 1;
      counters.comparedPairs += 1;
      const result = opts.compare(left, right);
      if (result) results.push(result);
    };

    if (opts.filePattern) {
      const targetIndex = opts.profiles.findIndex((profile) => profile.file.includes(opts.filePattern!));
      if (targetIndex >= 0) {
        const target = opts.profiles[targetIndex]!;
        for (const candidateIndex of targetCandidateIndexes(opts, targetIndex)) {
          const candidate = opts.profiles[candidateIndex]!;
          if (opts.focusFiles && !opts.focusFiles.has(target.file) && !opts.focusFiles.has(candidate.file)) continue;
          compareIndexes(targetIndex, candidateIndex);
        }
      }
    } else if (opts.focusFiles?.size !== 0) {
      const stopAt =
        typeof opts.overrunFactor === 'number' && Number.isFinite(opts.limit)
          ? opts.limit * opts.overrunFactor
          : Number.POSITIVE_INFINITY;
      for (let i = 0; i < opts.profiles.length; i += 1) {
        const left = opts.profiles[i]!;
        const leftFocused = opts.focusFiles?.has(left.file) ?? false;
        for (const j of upperCandidateIndexes(opts, i)) {
          if (opts.focusFiles && !leftFocused && !opts.focusFiles.has(opts.profiles[j]!.file)) continue;
          compareIndexes(i, j);
        }
        if (results.length > stopAt) {
          counters.overrunApplied = true;
          break;
        }
      }
    }

    results.sort(opts.sort ?? ((a, b) => b.similarity - a.similarity));
    counters.matchedResults = results.length;
    const emitted = results.slice(0, opts.limit);
    counters.emittedResults = emitted.length;
    opts.onProfile?.({ ...counters });
    return emitted;
  };

  if (!opts.profile) return run();
  return profileSpan(`pairwise-profile:${opts.profile.name}`, run, () => ({
    ...pairwiseProfileMetadata(opts.profile?.metadata),
    ...counters,
  }));
}

function targetCandidateIndexes<Profile extends PairwiseFileProfile, Result>(
  opts: RankedPairwiseProfileOptions<Profile, Result>,
  targetIndex: number,
): number[] {
  if (opts.candidateIndex) return validCandidateIndexes(opts, targetIndex, -1);
  const indexes: number[] = [];
  for (let index = 0; index < opts.profiles.length; index += 1) {
    if (index !== targetIndex) indexes.push(index);
  }
  return indexes;
}

function upperCandidateIndexes<Profile extends PairwiseFileProfile, Result>(
  opts: RankedPairwiseProfileOptions<Profile, Result>,
  leftIndex: number,
): number[] {
  if (opts.candidateIndex) return validCandidateIndexes(opts, leftIndex, leftIndex);
  const indexes: number[] = [];
  for (let index = leftIndex + 1; index < opts.profiles.length; index += 1) indexes.push(index);
  return indexes;
}

function validCandidateIndexes<Profile extends PairwiseFileProfile, Result>(
  opts: RankedPairwiseProfileOptions<Profile, Result>,
  profileIndex: number,
  minExclusive: number,
): number[] {
  const profile = opts.profiles[profileIndex]!;
  const indexes = new Set<number>();
  for (const candidateIndex of opts.candidateIndex?.candidatesFor(profile, profileIndex, opts.profiles) ?? []) {
    if (candidateIndex <= minExclusive) continue;
    if (candidateIndex === profileIndex) continue;
    if (candidateIndex < 0 || candidateIndex >= opts.profiles.length) continue;
    indexes.add(candidateIndex);
  }
  return [...indexes].sort((left, right) => left - right);
}

function emptyPairwiseProfileCounters<Profile extends PairwiseFileProfile, Result>(
  pipeline: string | undefined,
  opts?: RankedPairwiseProfileOptions<Profile, Result>,
): PairwiseProfileCounters {
  return {
    pipeline,
    profileCount: opts?.profiles.length ?? 0,
    focusedProfileCount: opts?.focusFiles
      ? opts.profiles.filter((profile) => opts.focusFiles!.has(profile.file)).length
      : 0,
    candidatePairs: 0,
    comparedPairs: 0,
    matchedResults: 0,
    emittedResults: 0,
    candidateIndexApplied: opts?.candidateIndex !== undefined,
    focusApplied: opts?.focusFiles !== undefined,
    filePatternApplied: opts?.filePattern !== undefined,
    overrunApplied: false,
  };
}

function pairwiseProfileMetadata(metadata: PairwiseProfileRun['metadata'] | undefined): PairwiseProfileMetadata {
  return typeof metadata === 'function' ? metadata() : (metadata ?? {});
}
