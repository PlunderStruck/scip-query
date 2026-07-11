# TypeScript Architecture and History Detector Certification

Date: 2026-07-10

Status: **three certified; two qualified; one insufficiently evidenced**

## Certified Claims

A relationship certificate says that the detector's reported connection is
present under its written source, compiler, policy, or Git-history rule. Its
essential characteristic is reproducibility from independently inspectable
repository evidence; it does not say that changing the relationship would
improve the code.

The following relationships met the repository-breadth, precision,
confidence, and known-positive gates:

- `co-change`: both current files have the disclosed accepted Git
  co-occurrence, confidence, commit-scope, structural-link, and path-class
  evidence;
- `doc-drift`: the doc/reference or historical-coupling relationship, changes
  after the doc update, and broken-reference state agree; and
- `stale-abstractions`: the reported non-ambient type/class has the disclosed
  real, transitive, barrel, singleton, and defining-file use evidence.

A recommendation-utility verdict asks whether acting on a true relationship
would improve the reviewed repository. It is an engineering judgment whose
essential characteristic is dependency on ownership, domain vocabulary,
intentional boundaries, and historical context that the structural
measurement cannot establish.

## Results

| Detector                 | Reviewed | Valid | Invalid | Repositories | 95% Wilson lower bound | Relationship state    | Recommendation review                    |
| ------------------------ | -------: | ----: | ------: | -----------: | ---------------------: | --------------------- | ---------------------------------------- |
| `co-change`              |       40 |    40 |       0 |            4 |                  91.2% | **certified**         | 40 uncertain without ownership review    |
| `doc-drift`              |       40 |    40 |       0 |            4 |                  91.2% | **certified**         | 40 uncertain without claim review        |
| `drift`                  |       40 |    40 |       0 |            4 |                  91.2% | **qualified**         | 0 actionable; 40 non-actionable alone    |
| `wrapper-candidates`     |       30 |    30 |       0 |            3 |                  88.6% | **qualified**         | 30 uncertain without boundary review     |
| `passthrough-candidates` |       21 |    21 |       0 |            3 |                  84.5% | insufficient evidence | 21 uncertain without boundary review     |
| `stale-abstractions`     |       40 |    40 |       0 |            4 |                  91.2% | **certified**         | 40 uncertain without domain-owner review |

`drift` is qualified rather than certified because the holdout contained 39
pattern-deviation relationships, one inferred-layer relationship, and no
real-repository unused-import findings. Fixtures protect unused-import recall,
but they cannot replace population evidence. Its relationship claim is also
narrow: “only one accepted sibling imports this dependency” can be true while
the specialization is completely appropriate.

`wrapper-candidates` is qualified because 30/30 reviewed single-caller/fan-in
relationships yield an 88.6% conservative lower bound, below the 90% gate.
`passthrough-candidates` remains insufficient because 21 rows do not establish
its precision floor despite every reviewed literal-forwarding relationship
being valid.

## Pinned Corpus and Final Candidate Frames

| Repository        | Commit                                     | Co-change | Doc drift | Drift | Wrappers | Passthroughs | Stale abstractions |
| ----------------- | ------------------------------------------ | --------: | --------: | ----: | -------: | -----------: | -----------------: |
| Vega_2.0          | `bd1a7bce20536b2bd1305ca57b858e3a3cad465b` |        91 |       450 | 1,063 |      104 |          135 |                137 |
| openwork          | `1bc2b18ef426c4751a6d8c16fbbf8023f5da9f6e` |       100 |       124 |   410 |       69 |           28 |                103 |
| Stable_Management | `bd221c3fa61034b4e52734f15ce6ef0b285ec78e` |        20 |       164 |   562 |       51 |            0 |                 92 |
| traceroot         | `c41ac2bb3801fc2ce882ea3bacba9b0c4c5afeb9` |        48 |        27 |    32 |        0 |            1 |                 13 |

Every run used a detached worktree, temporary cache, forced TypeScript index,
full accepted Git history for history analyzers, and the recorded commit. The
corpus working trees were not modified. The candidate counts are complete
within each detector's documented default thresholds; display limits were
removed.

## Baseline Defects and Hardening

The campaign found and fixed three shared accuracy failures:

1. **Ambient declarations called stale:** Express request augmentation, Vite
   `ImportMetaEnv`/`ImportMeta`, and JSX intrinsic-element declarations were
   scored from repository reference counts even though the TypeScript compiler
   consumes them as environment contracts. `stale-abstractions` now excludes
   `.d.ts` definitions before liveness scoring. Vega's frame fell from 140 to
   137 and openwork's from 104 to 103; no ambient declaration remained in the
   holdout.
2. **Generated state called hidden coupling:** committed `tsconfig.tsbuildinfo`,
   AUR `.SRCINFO`, and dependency lock state appeared as architectural
   co-change partners. They co-change by generation policy, not because they
   encode a hidden repository concept. The existing noise gate now covers
   TypeScript build state, `.SRCINFO`, and common lock-file families. Openwork's
   frame fell from 109 to 100 and traceroot's from 49 to 48.
3. **Workspace roots called feature identity:** file extensions and broad path
   tokens such as `frontend`, `backend`, `examples`, and language names could
   supply the two shared tokens required for `same-feature`. Those tokens are
   now structural vocabulary, while real cross-package matches such as the
   `proposals` API retain their feature classification. `same-feature` rows
   fell from 62 to 49 in Vega, 64 to 47 in openwork, 9 to 6 in Stable
   Management, and 38 to 19 in traceroot; the rows were reclassified rather
   than hidden.

No threshold was raised to erase findings. Every production change removes a
causal noise archetype or corrects evidence labeling and has a positive plus
boundary-negative regression.

## Utility Findings

All 40 sampled `drift` relationships were valid dependency-edge or sibling
frequency statements, but none alone showed a defect or a concrete safe
refactoring. Pattern deviation is therefore an exploration signal, not a
finding. The single inferred layer row was also an intentional development
script importing an application helper; inferred policy remains a review
signal.

For the other five detectors, the certificate deliberately leaves utility
uncertain. A file pair can truly co-change because of broad migration commits;
a doc can cite code that changed without its claim becoming stale; a wrapper
or passthrough can preserve a process, authorization, serialization, runtime,
or public-API boundary; and a one-consumer type can be valuable domain
vocabulary. The command must present those as review context unless additional
evidence establishes an action.

## Timing

Detector time inside the already indexed calibration worktrees ranged from:

- `co-change`: 1.1–8.9 s using full accepted Git history;
- `doc-drift`: 0.09–1.66 s;
- `drift`: 0.04–2.06 s;
- `wrapper-candidates`: 3.1–38.2 s;
- `passthrough-candidates`: 0.07–1.20 s; and
- `stale-abstractions`: 0.29–1.01 s.

These are detector times, not cold indexing times. Wrapper analysis is the
clear optimization target in this family.

## Reproduction

```bash
npm run build
node scripts/accuracy-calibration.mjs health-architecture --sample-size 10 --seed typescript-architecture-v2
node scripts/accuracy-calibration.mjs health-architecture --detector co-change --sample-size 10 --seed typescript-co-change-v5
node scripts/accuracy-calibration.mjs summarize <packet.json> <verdicts.json>
```

Generated packets live under ignored `reports/accuracy/`. Reviewed overlays
are committed as:

- [`2026-07-10-typescript-architecture-certification-verdicts.json`](./2026-07-10-typescript-architecture-certification-verdicts.json)
- [`2026-07-10-typescript-co-change-certification-verdicts.json`](./2026-07-10-typescript-co-change-certification-verdicts.json)

## Renewal Conditions

Renew the affected state when Git-history filtering, co-change path
classification, doc living/snapshot policy, reference extraction, dependency
graph construction, layer policy, caller evidence, literal-passthrough parsing,
type-consumer evidence, ambient declaration treatment, or TypeScript indexing
changes. Recommendation utility must be renewed independently when a command
changes from presenting review context to direct refactoring advice.

## Verification

- Focused calibration, co-change, doc-drift, drift, wrapper, passthrough, and
  stale-abstraction suites: 51 passed.
- Full suite: 1,291 tests across 184 files passed.
- Typecheck, lint, formatting, and build: passed.
- Index refresh and workspace doctor: fresh; TypeScript and Rust semantic
  providers available.
- Routed postchecks: zero generated co-change rows, ambient stale-abstraction
  rows, recent duplicates, incomplete migrations, and unused parameters.
- Self-audit: reference precision/recall 100%; the existing four-symbol callee
  comparison remains at 75% recall.
- `diff-gate`: exit 0 with two advisory citations. The README declared-coupling
  example still intentionally includes `stale-abstractions.ts`; the command
  reference's co-change budget/`scanLimit` description is unchanged by the
  noise and token-classification edits.

The repository-wide health baseline remains stale by 157 findings spread
across untouched subsystems. It was not rewritten as part of a detector
certificate; baseline reconciliation remains separate roadmap work.
