# React and Vue Detector Certification

Date: 2026-07-11
Status: Six framework measurements certified; `augment-vue` completeness remains insufficiently evidenced after operational hardening

## Executive Result

The six React and Vue health detectors now satisfy the repository's certified
relationship threshold. A certified framework measurement is a source-analysis
claim whose real-world referents are named components, hooks, composables,
templates, behavior tokens, or source-line counts; what distinguishes it from
an automatic refactoring instruction is that every disclosed fact and score is
reproducible while the decision to split or consolidate still depends on local
ownership and behavior.

The final hardened review covered 297 deterministic rows. All 297 were valid.
An independent arithmetic pass performed 409 exact checks of Jaccard and
behavior-similarity formulas, file/SFC lines, qualifying pressure axes, and
dominant-axis selection with zero mismatches. Focused fixtures provide at least
one known-positive recall case per detector.

| Detector                         | Uncapped frame | Reviewed | Repositories with reviewed rows | Valid | 95% lower bound | State                  |
| -------------------------------- | -------------: | -------: | ------------------------------: | ----: | --------------: | ---------------------- |
| `react-component-duplicates`     |             69 |       48 |                               3 | 48/48 |           92.6% | certified relationship |
| `react-hook-candidates`          |            162 |       48 |                               3 | 48/48 |           92.6% | certified relationship |
| `react-large-component-pressure` |            203 |       48 |                               3 | 48/48 |           92.6% | certified measurement  |
| `vue-component-duplicates`       |         53,818 |       41 |                               4 | 41/41 |           91.4% | certified relationship |
| `vue-composable-candidates`      |            125 |       48 |                               3 | 48/48 |           92.6% | certified relationship |
| `vue-large-view-pressure`        |            209 |       64 |                               4 | 64/64 |           94.3% | certified measurement  |

All sampled refactoring recommendations were classified as non-actionable
without additional design context. The commands reliably identify measured
overlap or pressure; they do not prove that a component, hook, composable, or
view should be extracted or split.

## Corpus and Candidate Frames

Every repository was read through a detached worktree and a unique temporary
index. The source checkout was not modified.

### React

| Repository | Commit                                     | Component pairs | Hook pairs | Pressure rows |
| ---------- | ------------------------------------------ | --------------: | ---------: | ------------: |
| Vega_2.0   | `f9652d690753468894dfccf179b4957071a4d963` |              22 |         80 |            53 |
| openwork   | `1bc2b18ef426c4751a6d8c16fbbf8023f5da9f6e` |              31 |         38 |           124 |
| traceroot  | `c41ac2bb3801fc2ce882ea3bacba9b0c4c5afeb9` |              16 |         44 |            26 |

Raw packet:
`reports/accuracy/2026-07-11T15-24-53-133Z-typescript-framework-calibration.json`
(generated and intentionally ignored). Reviewed packet:
`reports/accuracy/2026-07-11T15-28-32-522Z-typescript-typescript-framework-reviewed.json`.

### Vue

| Repository        | Commit                                     | Component pairs | Composable pairs | Pressure rows |
| ----------------- | ------------------------------------------ | --------------: | ---------------: | ------------: |
| Stable_Management | `bd221c3fa61034b4e52734f15ce6ef0b285ec78e` |               1 |                0 |            87 |
| on_main_mvp       | `5faef0ffd5d17f9dc8058622a3f70005fd3232a6` |               8 |               38 |            20 |
| Element Plus      | `11fdeb3873ef1533659aa89df30d1699764ad3b9` |           2,379 |               69 |            23 |
| PrimeVue          | `d4374cb7c1267f35eba7cee5d0a266f50ca8ec84` |          51,430 |               18 |            79 |

Element Plus and PrimeVue were shallow-cloned as named corpus additions because
the initial local Vue cohort did not provide enough composable findings or
repository breadth. `agent_chat` and Nuxt UI failed TypeScript indexing and
were recorded as failed capability attempts, not clean zero-result repositories.

Raw packet:
`reports/accuracy/2026-07-11T15-26-04-361Z-typescript-framework-calibration.json`.
Reviewed packet:
`reports/accuracy/2026-07-11T15-28-32-729Z-typescript-typescript-framework-reviewed.json`.

## Truth Rules and Independent Checks

- Component-duplicate rows are valid when both endpoints contain the disclosed
  structural categories and the reported score equals the Jaccard similarity of
  their complete token sets.
- Hook/composable rows are valid when both endpoints contain the disclosed
  lifecycle and behavior categories and the reported score equals the maximum
  of Jaccard and the documented damped overlap coefficient.
- Pressure rows are valid when source-line and token counts agree, every listed
  axis meets its threshold, and the dominant axis is the strongest qualifying
  dominant-eligible pressure.

The result contracts now expose `tokenCountA` and `tokenCountB`, so the capped
diagnostic `uniqueToA`/`uniqueToB` arrays no longer prevent a reviewer from
recomputing the score. This is a backward-compatible additive API change; the
four result types have no affected transitive consumers in the current index.

## Hardening Findings

### Dominant pressure could be unqualified

The baseline selected a dominant axis from every measured axis, even when that
axis had not met its threshold. Sixteen of 48 sampled React pressure rows named
`file` as dominant while only JSX structure had qualified. The shared pressure
evaluator now selects dominance only among qualifying axes. A focused regression
proves that a numerically larger but unqualified file axis cannot drive the
recommendation.

### Nested React components inherited route-page status

Components such as `SessionActivityFeed`, `SeatEditor`, and
`MarketplacePackageDetailModal` inherited route-page recommendations from a
containing `*Page.tsx`/`*View.tsx` file or route directory. The classifier now
requires the component's own route-like name, a conventional route filename,
or a same-named route module. Nested and component-owned views remain ordinary
components. The final holdout contained no reviewed recurrence of either
context archetype.

### Similarity scores were not independently auditable

Shared token lists were complete, but endpoint-unique lists were capped at 25.
The four pair result contracts now include both total token counts. All final
scores recomputed exactly from the disclosed counts and shared-token lengths.

## Vue Reference Augmentation Audit

A Vue augmented reference is an indexed occurrence produced when Volar resolves
an SFC identifier to a concrete source definition. Its essential distinction
from a text match is exact definition identity, which lets graph commands count
the reference without confusing same-named identifiers.

Operational runs found:

- Stable_Management: 410 Vue files and 66,396 resolved/inserted mentions.
- on_main_mvp: 86 Vue files, 13,700 resolved/inserted mentions, 26,319 skipped
  source tokens, and 86 synthetic Vue symbols after hardening.

Two defects were fixed:

1. A missing `.vue` path listed by the TypeScript project was passed to Volar
   before the source reader checked existence, aborting the entire augmentation.
   Missing paths now increment the skipped count and valid files continue.
2. The default worker policy created multiple full TypeScript/Volar projects.
   On on_main_mvp, two, four, and eight workers could lose a worker and leave the
   synchronous coordinator waiting for five minutes. The reliable single-context
   path is now the default; parallel workers remain an explicit
   `SCIP_QUERY_AUGMENT_VUE_WORKERS` opt-in for calibrated projects.

The CLI now prints skipped-reference and synthetic-symbol counts instead of
reporting only successful mentions. `augment-vue` is operationally qualified,
but reference completeness remains **insufficiently evidenced**: the real-repo
runs cover two dependency-ready repositories and focused regressions, not a
three-repository source-reviewed sample of resolved and missed reference sites.
It must not be described as complete or as automatically run by ordinary
`reindex`.

## Recommendation Utility

The PrimeVue frame demonstrates why fact and action must remain separate:
51,430 component pairs are largely repeated showcase/documentation families.
Those relationships are real, but emitting them as 51,430 defects would be a
finding wall. The same constraint applies to shared React primitives, existing
hooks/composables, route variants, icon families, generated/examples, and large
views. Public output should retain evidence class and action tier, normalize
applicable production scope, and require local design review before presenting
an edit.

## Regression Coverage

- Framework calibration parser and detector manifest.
- Exact endpoint token counts for React/Vue component and behavior pairs.
- Qualified-only dominant pressure.
- Nested component versus route-page classification.
- Missing Vue project file skipped before Volar access.
- Reliable single-context Vue augmentation default plus explicit worker opt-in.
- Existing rich React/Vue positive fixtures for all six detectors.

Verdict overlays are committed in
[`2026-07-11-react-vue-detector-verdicts.json`](./2026-07-11-react-vue-detector-verdicts.json).
