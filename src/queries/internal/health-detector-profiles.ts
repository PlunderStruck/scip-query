/**
 * One source of truth for the detector option profiles that `health` and the
 * baseline ratchet share. If these drift apart, the ratchet records finding
 * identities for results health doesn't report (and vice versa) — the two
 * views of "current findings" must come from identical detector runs.
 */
export const HEALTH_DETECTOR_PROFILES = {
  dead: { minLoc: 1, skipBarrels: false, deadCodeOnly: false },
  isolated: { minLoc: 3 },
  similar: { minSimilarity: 0.6, limit: 50, minCallees: 4 },
  duplicateBodies: { maxLoc: 15, limit: 50 },
  extract: { minLoc: 15, minCallees: 5, limit: 50 },
  wrappers: { maxLoc: 15, limit: 50 },
  passthroughs: { maxLoc: 15, limit: 50 },
  stale: { minLoc: 3, limit: 50 },
  drift: {},
  twinDrift: { minSimilarity: 0.3 },
} as const;
