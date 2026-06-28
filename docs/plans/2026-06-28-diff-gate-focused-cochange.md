# Diff-Gate Focused Co-Change Plan

## Target

Speed up `scip-query diff-gate --json` without changing findings, root-cause
groups, suppressions, output bytes, or exit behavior.

A co-change partner is a file that git history shows moving with another file
often enough that editing one without the other may indicate hidden coupling.
In diff-gate, this check is directional: it asks whether a file in the current
diff usually brings along a partner that is absent from the diff.

## Evidence

- Corpus: `/Users/aydansalois/Documents/GitHub/Vega_2.0`.
- Current diff: 7 changed files.
- Baseline warm full `diff-gate --json`: 1.560s, 1.537s, later 1.563s,
  1.536s.
- Baseline co-change-only probe:
  - `diff-gate --json --skip echo --skip incomplete-migration --skip doc-reference --skip unused-params --skip new-dead`
  - 0.671s, 0.669s.
- Baseline all-skipped overhead: 0.367s, 0.361s.
- Output contract hash for full diff-gate:
  `4b70b62e26f2398447decacbb0c51b4200b666b78534d2c4cf8ace33a5728cc6`.

`scip-query plan-context runCoChangePartnerCheck --json` shows the check calls
`getCoChangePairsForFiles()` and then applies directional confidence,
existence, noise-file, structural-link, and suppression logic. A direct probe
against Vega showed `getCoChangePairsForFiles()` returned zero pairs but still
took about 321ms because it parsed the full 3 MB bounded git history payload.

## Plan

1. Keep the public `getCoChangePairsForFiles()` behavior unchanged.
2. Add a diff-gate-specific focused history path that first obtains the global
   2,000-commit non-merge window, then inspects only commits from that window
   that touched changed files.
3. Preserve recency semantics by carrying the newest non-bulk commit timestamp
   from the global window into the focused subset.
4. Fall back to the existing global helper for very large changed-file sets.
5. Route only `runCoChangePartnerCheck()` through the focused directional
   helper.
6. Verify the full Vega diff-gate hash and the co-change-only hash stay
   unchanged.

## Acceptance

- Vega full `diff-gate --json` keeps the same 3,089-byte output and SHA-256.
- Vega co-change-only output keeps the same 1,198-byte output and SHA-256.
- Warm full diff-gate improves from the 1.54s-1.56s band.
- Co-change-only improves from the 0.67s band.
- Git-history and co-change-partner tests cover the focused helper.

## Outcome

- Implemented `getDirectionalCoChangePairsForFiles()` for diff-gate's
  directional partner check.
- Final Vega full `diff-gate --json`: 2.791s first-run outlier, then 1.331s
  and 1.339s warm; unchanged 3,089-byte SHA-256
  `4b70b62e26f2398447decacbb0c51b4200b666b78534d2c4cf8ace33a5728cc6`.
- Final Vega co-change-only probe: 0.477s, 0.479s, 0.476s; unchanged
  1,198-byte SHA-256
  `51faa0ffa7a97ee3dcd99f88d89a32b6d6ecdb188c29308634a77185daa01085`.
