# First-use scanner validation

The final built scanner was checked against the same LaunchPoint checkout used for the baseline. Application source was not modified. The source scan used `health --scope src`; scope selects displayed findings while repository peers remain in the analyzed inventory. The indexed architecture run used LaunchPoint's existing index. Those providers cover different file sets and resolve relationships differently, so their cycle totals are not directly comparable.

| Observation | Earlier implementation | Verified implementation |
| --- | --- | --- |
| Ordinary file bound | 5,000; omitted 336 eligible files | 10,000; all 5,306 eligible files analyzed |
| Functions measured | 56,709 with the raised baseline limit | 55,996 after source-role exclusions |
| Internal import resolution | Relative paths only; 25,782 imports outside the graph combined into one count | 24,931 internal imports resolved; 0 missing/ambiguous internal imports |
| External dependencies | Mixed into the unresolved count | 6,012 external package imports, 427 built-ins, 9 excluded targets |
| Reference/test source | Copied SDK source and end-to-end support entered ordinary findings | 16 reference-source files and 2,568 test/fixture/benchmark files excluded with reasons |
| Source findings in `src` | 2,145 complexity and 65 duplication groups | 2,144 complexity, 65 duplication groups, one confirmed four-file value-import cycle, two enforced boundary-group cycles |
| Existing indexed architecture | Ten circular boundary groups | Three grouping-only components after excluding 5,083 test-related edges from production topology |
| Dependency policy | Only one of 2,344 rows declared | Same declarations; 2,343 missing rows explicitly remain unknown |

The final human screen shows three shared dependency components separately from five module subjects. It includes the client-access/clients file cycle, the three copied `parseCreatorIds` bodies, and the dashboard media group's most complex functions, including `RunAdScreen` at 332 cyclomatic / 329 cognitive. It exposes exact source locations, observed consumers and dependencies, and recovery for every omitted detail. A whole-component concern is not assigned as the first module's defect. The exhaustive source artifact is 8.65 MB; stable hashed component IDs avoid repeating hundreds of boundary names in every subject.

No responsibility candidate qualified in LaunchPoint under the conservative exported-function rule. Its positive and negative behavior is covered by synthetic regressions, including orchestration, shared consumers and small-export attribution. This is a clear limit on real-repository evidence for that detector. The scan does not establish that LaunchPoint's conceptual ownership is correct, that every duplicate should be merged, or that static cycles cause runtime failure. Test coverage was not supplied, so CRAP is unavailable.

The [Sol medium development audit](2026-09-05-first-use-sol-audit.md) confirmed selected source findings and caught two implementation bugs, now regression-tested. It was not a controlled agent effectiveness experiment.

Verification passed: the full serial suite (2,900 tests in 337 files), then 72 focused checks after final source placement/presentation changes; the final built CLI's shared-cycle/check-gate smoke test; `npm run lint` (including build, API compatibility, consumer type checking and skill links); `npm run typecheck`; and `git diff --check`.

After the last source refresh, scip-query's indexed architecture mapped all 547 files across 39 declared boundaries, with all 39 policy rows present and no forbidden edges, cycles, coarse-boundary violations, exceeded bounds, stale allowances or test-policy violations. The broader source review accounted for 569 eligible files and 12,484 functions, with zero unresolved internal imports and no introduced/worsened architecture findings. It still reports pre-existing unowned tooling and retained complexity/duplication findings. The moved configuration validator retains its existing 54/81 complexity; `sourceMaintenanceReport` is 35/31 and `sourceModuleSubjects` is 17/23. These remain review candidates, not waived correctness checks or a claim that every metric warning was eliminated.

Fresh `diff-impact` identified 78 changed files, 232 changed symbols and 11 affected consumer files. Its envelope does not establish exhaustive consumer coverage. Source import impact and indexed symbol impact retain their distinct meanings.

[Persistent metadata and summarized evidence](../../benchmarks/maintenance-results/2026-09-05-first-use-validation/) record source hashes, repository commits, report hashes, named cycle groups, exact source examples and verification logs. Full local reports remain at `/tmp/launchpoint-scip-first-use-verified.json`, `/tmp/launchpoint-scip-first-use-architecture-verified.json`, `/tmp/scip-first-use-architecture-complete.json`, `/tmp/scip-first-use-review-complete.json`, and `/tmp/scip-first-use-diff-impact-complete.json`.
