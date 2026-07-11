# TypeScript Factual Detector Certification

Date: 2026-07-10

Status: **four certified; six insufficiently evidenced**

## Certified Claims

The following claims met the repository breadth, precision, confidence, and
known-positive gates:

- `unused-imports`: the reported local import binding has no TypeScript-valid
  value, type, JSX, decorator, namespace, or re-export use in that file;
- `duplicate-bodies`: the reported callables in different files have equal
  normalized implementation bodies;
- `complexity`: the reported source span, LOC, documented AST branch count,
  and branches-plus-one cyclomatic estimate agree; and
- `redundant-reexports`: no indexed repository consumer imports the reported
  binding or module through the reported re-exporting file. Public package
  surfaces remain signals rather than removal instructions.

These certificates do not claim that every real issue is found, that duplicate
bodies should be consolidated, that a cycle is architecturally harmful, or
that a public re-export can be removed without API review.

## Results

| Detector              | Reviewed | Valid | Invalid | Repositories with reviewed rows | 95% Wilson lower bound | Known-positive cases | State                 |
| --------------------- | -------: | ----: | ------: | ------------------------------: | ---------------------: | -------------------: | --------------------- |
| `unused-imports`      |       59 |    59 |       0 |                               3 |                  93.9% |                    1 | **certified**         |
| `unused-params`       |        5 |     5 |       0 |                               1 |                  56.6% |                    1 | insufficient evidence |
| `cycles`              |        3 |     3 |       0 |                               1 |                  43.8% |                    1 | insufficient evidence |
| `duplicate-bodies`    |       40 |    40 |       0 |                               4 |                  91.2% |                    1 | **certified**         |
| `complexity`          |       40 |    40 |       0 |                               4 |                  91.2% |                    1 | **certified**         |
| `isolated`            |        3 |     3 |       0 |                               2 |                  43.8% |                    1 | insufficient evidence |
| `redundant-reexports` |       40 |    40 |       0 |                               4 |                  91.2% |                    1 | **certified**         |
| `not-implemented`     |        0 |     0 |       0 |                               0 |                      — |    positive fixtures | insufficient evidence |
| `decorative-checkers` |        0 |     0 |       0 |                               0 |                      — |    positive fixtures | insufficient evidence |
| `test-quality`        |       12 |    12 |       0 |                               2 |                  75.7% |                    3 | insufficient evidence |

`not-implemented` and `decorative-checkers` produced supported zeroes on the
pinned corpus, not proof of precision. Their positive fixtures prove the
detectors still see intended cases, but fixtures cannot substitute for
population findings.

## Pinned Corpus

| Repository        | Commit                                     | Coverage role                                  |
| ----------------- | ------------------------------------------ | ---------------------------------------------- |
| Vega_2.0          | `c467229f2b1a0b528afd73124cdf317330d0678e` | large React/backend monorepo                   |
| openwork          | `1bc2b18ef426c4751a6d8c16fbbf8023f5da9f6e` | workspaces, React, backend, package boundaries |
| Stable_Management | `bd221c3fa61034b4e52734f15ce6ef0b285ec78e` | Vue/backend monorepo                           |
| traceroot         | `c41ac2bb3801fc2ce882ea3bacba9b0c4c5afeb9` | packages, examples, mixed boundaries           |

Every run used a detached worktree, a temporary cache, a forced TypeScript
index, and the recorded commit. Corpus working trees were not modified.

## Baseline Defects and Hardening

The campaign found six shared accuracy failures:

1. **Import binding split:** SCIP import roles identified the target symbol but
   omitted some later local-binding uses. `unused-imports` now merges semantic
   and source binding evidence. Stable Management's smoke frame fell from 580
   candidates to 5; both reproduced used-binding rows disappeared.
2. **Ambient symbols as dependencies:** ordinary cross-file symbol mentions,
   including merged `Window` declarations, created false dependency cycles.
   The file graph now accepts SCIP import-role edges plus parsed source imports,
   and uses a versioned durable-cache key. Openwork fell from 12 reported cycles
   to three source-verifiable import cycles.
3. **Framework methods as isolated:** override, derived-class, implemented
   protocol, and React lifecycle methods lacked explicit call edges. A shared
   callable-contract gate now protects both `dead` and `isolated`; isolated also
   excludes rooted public symbols. Openwork fell from 24 candidates to two.
4. **Arbitrary re-export attribution:** the source fallback attached an
   arbitrary definition from the source module to a re-export. Named exports
   now retain the actual binding, while star exports are labeled as module
   re-exports. Public package surfaces remain `signal` rows.
5. **Delegated failures called decorative:** checker bodies that delegated to
   throwing, diagnostic, or Effect-returning functions were called harmless;
   zero-input capability predicates were also misclassified. The detector now
   excludes framework contracts and unresolved call-bearing bodies. Its 20-row
   baseline wall fell to zero while positive fixtures remain detectable.
6. **Implicit test assertions:** awaited Testing Library `findBy*` queries and
   condition-specific `waitFor*` helpers were called assertion-free. Both
   reproduced rows disappeared. Remaining sampled rows are factual mock-echo
   observations, not claims that the whole test is worthless.

The calibration harness was generalized to all ten detectors, preserves each
result shape, records uncapped candidate frames, supports per-detector verdicts,
and samples complexity from the complete function/method/constructor frame.

## Reproduction

```bash
npm run build
node scripts/accuracy-calibration.mjs health-factual --sample-size 10 --seed typescript-factual-v2
node scripts/accuracy-calibration.mjs health-factual --detector unused-imports --sample-size 10000 --seed typescript-unused-imports-v1
node scripts/accuracy-calibration.mjs health-factual --detector complexity --sample-size 10 --seed typescript-complexity-v1
node scripts/accuracy-calibration.mjs summarize <packet.json> <verdicts.json>
```

Generated packets live under ignored `reports/accuracy/`. Reviewed overlays are
committed as:

- [`2026-07-10-typescript-factual-certification-verdicts.json`](./2026-07-10-typescript-factual-certification-verdicts.json)
- [`2026-07-10-typescript-unused-imports-certification-verdicts.json`](./2026-07-10-typescript-unused-imports-certification-verdicts.json)
- [`2026-07-10-typescript-complexity-certification-verdicts.json`](./2026-07-10-typescript-complexity-certification-verdicts.json)

## Renewal Conditions

Renew the affected certificate when import attribution, source parsers,
file-dependency construction, body normalization, AST branch contributions,
package-surface modeling, or TypeScript indexing changes. The low-volume six
detectors remain withheld from actionable public output until they satisfy the
same evidence gates; supported zeroes must continue to be reported separately
from unsupported analysis.
