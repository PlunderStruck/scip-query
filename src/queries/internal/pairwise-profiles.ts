export interface PairwiseFileProfile {
  file: string;
}

interface RankedPairwiseProfileOptions<Profile extends PairwiseFileProfile, Result> {
  profiles: readonly Profile[];
  limit: number;
  filePattern?: string;
  focusFiles?: ReadonlySet<string>;
  overrunFactor?: number;
  compare: (left: Profile, right: Profile) => Result | null;
  sort?: (left: Result, right: Result) => number;
}

export function rankedPairwiseProfileResults<
  Profile extends PairwiseFileProfile,
  Result extends { similarity: number },
>(opts: RankedPairwiseProfileOptions<Profile, Result>): Result[] {
  const results: Result[] = [];

  if (opts.filePattern) {
    const target = opts.profiles.find((profile) => profile.file.includes(opts.filePattern!));
    if (!target) return [];
    for (const candidate of opts.profiles) {
      if (candidate.file === target.file) continue;
      if (opts.focusFiles && !opts.focusFiles.has(target.file) && !opts.focusFiles.has(candidate.file)) continue;
      const result = opts.compare(target, candidate);
      if (result) results.push(result);
    }
  } else {
    if (opts.focusFiles?.size === 0) return [];
    const focusedIndexes = opts.focusFiles
      ? opts.profiles
          .map((profile, index) => (opts.focusFiles!.has(profile.file) ? index : -1))
          .filter((index) => index >= 0)
      : [];
    const stopAt =
      typeof opts.overrunFactor === 'number' && Number.isFinite(opts.limit)
        ? opts.limit * opts.overrunFactor
        : Number.POSITIVE_INFINITY;
    for (let i = 0; i < opts.profiles.length; i += 1) {
      const left = opts.profiles[i]!;
      if (opts.focusFiles && !opts.focusFiles.has(left.file)) {
        for (const j of focusedIndexes) {
          if (j <= i) continue;
          const result = opts.compare(left, opts.profiles[j]!);
          if (result) results.push(result);
        }
      } else {
        for (let j = i + 1; j < opts.profiles.length; j += 1) {
          const result = opts.compare(left, opts.profiles[j]!);
          if (result) results.push(result);
        }
      }
      if (results.length > stopAt) break;
    }
  }

  results.sort(opts.sort ?? ((a, b) => b.similarity - a.similarity));
  return results.slice(0, opts.limit);
}
