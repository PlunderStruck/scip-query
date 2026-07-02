/**
 * One source of truth for the detector option profiles that `health` and the
 * baseline ratchet share. If these drift apart, the ratchet records finding
 * identities for results health doesn't report (and vice versa) — the two
 * views of "current findings" must come from identical detector runs.
 */
export const HEALTH_DETECTOR_PROFILES = {
  dead: { minLoc: 3, skipBarrels: true, deadCodeOnly: true, semantic: false },
  isolated: { minLoc: 3, semantic: false },
  similar: { minSimilarity: 0.6, limit: 50, minCallees: 4, semantic: false },
  duplicateBodies: { maxLoc: 15, limit: 50 },
  extract: { minLoc: 15, minCallees: 5, limit: 50, semantic: false },
  wrappers: { maxLoc: 15, limit: 50, semantic: false },
  passthroughs: { maxLoc: 15, limit: 50, semantic: false },
  stale: { minLoc: 3, limit: 50, semantic: false },
  drift: { semantic: false },
  twinDrift: { minSimilarity: 0.3 },
} as const;
