# TypeScript Similarity Detector Certification

Date: 2026-07-10

Status: **three certified; two qualified; one insufficiently evidenced**

## Certified Claims

A relationship certificate says that the detector's reported connection is
present in the cited code under its written rule. It is a factual measurement
certificate: the defining trait is reproducibility from both source endpoints
and the disclosed compiler, graph, signature, or history evidence.

The following relationships met the repository-breadth, precision,
confidence, and known-positive gates:

- `similar`: both callables have the disclosed shared callee or source-token
  evidence and score;
- `similar-files`: both files have the disclosed distinctive dependency
  overlap and score; and
- `similar-signatures`: every grouped callable has the same normalized
  parameter and return shape plus a compatible LOC band.

A recommendation-utility verdict says whether acting on a true relationship
would improve the reviewed code. It is a separate engineering judgment: its
defining trait is that it incorporates ownership, boundary, and product
semantics that structural similarity cannot establish. None of the three
certificates above independently says that code should be consolidated.

## Results

| Detector             | Reviewed | Valid | Invalid | Repositories | 95% Wilson lower bound | Relationship state    | Recommendation review                        |
| -------------------- | -------: | ----: | ------: | -----------: | ---------------------: | --------------------- | -------------------------------------------- |
| `recent-duplicates`  |        8 |     8 |       0 |            3 |                  67.6% | insufficient evidence | 6 actionable, 2 non-actionable               |
| `similar`            |       36 |    36 |       0 |            4 |                  90.4% | **certified**         | 36 uncertain without domain-owner review     |
| `similar-files`      |       40 |    40 |       0 |            4 |                  91.2% | **certified**         | 40 uncertain without domain-owner review     |
| `similar-chains`     |       40 |    40 |       0 |            4 |                  91.2% | **qualified**         | 0 actionable; 40 shared-dependency-tail rows |
| `similar-signatures` |       40 |    40 |       0 |            4 |                  91.2% | **certified**         | 40 uncertain without domain-owner review     |
| `twin-drift`         |       40 |    37 |       3 |            4 |                  80.1% | **qualified**         | 37 uncertain; 3 invalid rows not applicable  |

`similar-chains` is qualified rather than certified because each repository
run compared pairs drawn from at most 500 generated dependency paths. The 40
reviewed measurements are correct inside that bounded candidate frame, but the
run does not establish behavior outside it.

`recent-duplicates` is a supported, high-quality signal, but eight findings do
not establish its precision floor. `twin-drift` exceeds 90% observed precision
at 92.5%, yet its conservative lower bound remains below the 90% certification
gate. Both stay out of an unqualified actionable tier.

## Pinned Corpus

| Repository        | Commit                                     | Coverage role                                  |
| ----------------- | ------------------------------------------ | ---------------------------------------------- |
| Vega_2.0          | `f422d223f12944a5a54f4a85d57a6552af55e652` | large React/backend monorepo                   |
| openwork          | `1bc2b18ef426c4751a6d8c16fbbf8023f5da9f6e` | workspaces, React, backend, package boundaries |
| Stable_Management | `bd221c3fa61034b4e52734f15ce6ef0b285ec78e` | Vue/backend monorepo                           |
| traceroot         | `c41ac2bb3801fc2ce882ea3bacba9b0c4c5afeb9` | packages, examples, mixed boundaries           |

Every run used a detached worktree, a temporary cache, a forced TypeScript
index, and the recorded commit. Corpus working trees were not modified.

## Baseline Defects and Hardening

The campaign found and fixed five shared accuracy failures:

1. **Generic React plumbing as an echo:** unrelated screens sharing only
   `useState`, `useEffect`, `useMemo`, or query plumbing were reported as
   duplicated behavior. React hook pairs now require a custom hook, shared
   state or handler evidence, or at least two shared behavior verbs. The
   reviewed `recent-duplicates` frame fell from 12 to 8, including openwork
   falling from 7 to 3, without removing intended component and hook echoes.
2. **Missing source for simple frontend names:** packet collection could locate
   compiler-qualified symbols but not some simple component names. The runner
   now resolves their source declarations so every reviewed relationship
   includes both endpoints.
3. **Constants treated as callable twins:** top-level TypeScript constants with
   the same leaf name were grouped even when they were data. A top-level term
   now needs callable symbol evidence or an arrow-function declaration.
4. **Near-name and test contamination:** loose fuzzy matching grouped homonyms
   such as `StageCard`/`StatCard` and mixed production functions with test
   helpers. Near-name pairs now require an 80% common-prefix ratio, and test
   members are excluded before participation is calculated.
5. **Convention-only leaves:** framework entry points and generic method names
   such as `main`, `Row`, and unrelated `update` methods can share names while
   representing different concepts. Convention-only leaves are filtered, but
   the renewed holdout still contained three context collisions:
   `updateSettings` across distinct settings domains, framework-conventional
   `RootLayout`, and unrelated resource `update` methods. Those residual rows
   are why `twin-drift` is only qualified.

The chain audit also exposed a recommendation failure rather than a factual
one. All 40 sampled `similar-chains` relationships were valid dependency-path
comparisons, but all were combinatorial variations of a shared dependency
tail and none supplied a concrete consolidation action. The detector remains
a graph relationship signal, not refactoring advice.

## Candidate Frames and Timing

The replay recorded every candidate count before deterministic sampling. The
largest surviving frames were 441 similar-file pairs, 16,185 similar-chain
pairs from the bounded path input, 662 signature groups, and 194 twin groups.
`similar` completed in 1–11 ms and `similar-files` in 4–83 ms in the combined
replay. `similar-signatures` took 405–6,512 ms, `similar-chains` took 3.7–30.4
s, and history-backed `recent-duplicates` took 3.4–32.1 s. The final renewed
`twin-drift` pass took 1.5–14.5 s. These are detector times inside already
indexed calibration worktrees, not cold end-to-end indexing times.

## Alias Parity

The deprecated `convergence <a> <b>` command and
`similar <a> <b> --plan` were exercised against a non-null pair from this
repository. After mapping the deprecated field name `sharedCallees` to the new
plan's `sharedEvidence`, the symbol records, similarity, unique evidence, and
consolidation strategy were identical. The alias is therefore parity-verified;
its outer JSON command envelope intentionally retains the invoked command name.

## Reproduction

```bash
npm run build
node scripts/accuracy-calibration.mjs health-similarity --sample-size 10 --seed typescript-similarity-v2
node scripts/accuracy-calibration.mjs health-similarity --detector twin-drift --sample-size 10 --seed typescript-twin-drift-v2
node scripts/accuracy-calibration.mjs summarize <packet.json> <verdicts.json>
```

Generated packets live under ignored `reports/accuracy/`. Reviewed overlays
are committed as:

- [`2026-07-10-typescript-similarity-certification-verdicts.json`](./2026-07-10-typescript-similarity-certification-verdicts.json)
- [`2026-07-10-typescript-twin-drift-certification-verdicts.json`](./2026-07-10-typescript-twin-drift-certification-verdicts.json)

## Renewal Conditions

Renew the affected state when Git-age orientation, frontend behavior evidence,
callee fingerprints, file-dependency classification, chain generation or
limits, signature normalization, twin name/context filtering, or TypeScript
indexing changes. Recommendation utility must be renewed independently when a
command begins presenting a measured relationship as a direct refactoring
instruction.

## Verification

- Focused similarity, twin, alias, calibration-core, and CLI contract tests:
  85 passed.
- Full suite: 1,286 tests across 184 files passed.
- Typecheck, lint, formatting, and build: passed.
- Index refresh and workspace doctor: fresh; TypeScript and Rust semantic
  providers available.
- Routed postchecks: no recent duplicates, incomplete migrations, or unused
  parameters; self-audit reference precision and recall remained 100%.
- `diff-gate`: exit 0 with one advisory README configuration-example citation;
  the referenced `isolated.ts` file still exists and remains the intended
  example member, so no documentation change is required.

The repository-wide health baseline remains stale by 157 findings spread
across many untouched subsystems. It was not silently rewritten as part of a
detector-accuracy certificate; baseline reconciliation remains separate
roadmap work.
