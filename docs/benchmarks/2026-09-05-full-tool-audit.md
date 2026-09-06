# Full tool audit — 2026-09-05

Follow-up: [all ten findings have now been individually assessed](../plans/2026-09-05-full-tool-audit-assessment.md). That assessment supersedes this report's priority judgments and assertion-count interpretation: F03 and F08 are reduced in priority, metric disagreement is separated from false call counts, and suppression acceptance was not established by the original probes. The captures below remain historical evidence; repairs remain open.

The first-use TS/JS scanner produces useful, source-backed findings. The tool as a whole is **not ready to be trusted as an automatic refactoring or verification authority**. This audit found nine defect groups and one product integration gap, including cases where incomplete work is presented as complete or passed. The previous passing suite did not exercise these cases.

No production implementation was changed in this audit. The existing uncommitted simplification and scanner work was preserved. The audit adds reproducible probes, captured results, and a prioritized repair list; the defects below remain open.

## Scope and evidence

An audit finding here identifies an observed failure of a stated command or API contract. A smoke invocation establishes that a command accepts its inputs and completes; it does not establish the correctness of every result. A dependence slice is the part of a program that can influence one selected value, so omitting an assignment that changes that value invalidates a claim of completeness.

- Inventoried and ran help for **95 public commands** across exploration, graph/impact/planning, quality/cleanup/framework analysis, configuration, indexing/services, and formal modeling.
- Ran **83 query invocations** against a disposable repository actually indexed by `scip-typescript`, with known branches, calls, a reachable stub, an always-true checker, and an assertion-free test.
- Exercised setup/uninstall, invalid configuration, review failure modes, suppression writes, watcher refresh, and formal-verifier negative cases separately.
- Ran all **2,900 tests in 337 files** successfully. Lint, API compatibility, public consumer type checking, and the project type checks passed. The production dependency audit reported zero known vulnerabilities at execution time.
- Packed the package and loaded all **77 ESM export paths**, with declaration files present. This used the current installed dependencies, not a clean dependency installation on another OS.
- Added **35 focused audit assertions: 16 pass and 19 fail**. Failures remain failures; the probes do not change their expected results to accommodate defects. Several assertions describe different symptoms of one defect group.

Primary artifacts: [assertions](../../benchmarks/full-tool-audit/2026-09-05/artifacts/assertions.json), [library probes and runtime witnesses](../../benchmarks/full-tool-audit/2026-09-05/artifacts/library.json), [source/environment hashes](../../benchmarks/full-tool-audit/2026-09-05/artifacts/metadata.json), and the [compressed complete command results](../../benchmarks/full-tool-audit/2026-09-05/artifacts/raw-results.tar.gz). The [artifact manifest](../../benchmarks/full-tool-audit/2026-09-05/artifacts/artifact-manifest.json) identifies each archived file and its hash.

## Prioritized findings

P1 means a wrong identity, unearned verification claim, or write outside the intended storage directory can directly mislead work. P2 means a measurement or workflow is materially unreliable. P3 is a product clarity problem.

| ID | Priority | Finding | Main producer |
| --- | --- | --- | --- |
| F01 | P1 | Incomplete dependence slices report complete | `src/semantic/typescript/local-flow.ts:695-794`; `src/queries/graph/dependence-slice.ts:163-172` |
| F02 | P1 | Missing explicit file paths can silently become unrelated symbols | `src/queries/navigation/code.ts:186-189` |
| F03 | P1 | Setup reports unexecuted, even nonexistent, commands as passed smoke tests | `src/runtime/project-setup.ts:902-976` |
| F04 | P1 | TLA verification discards mapping-declared trace load errors | `src/runtime/query-commands/tla.ts:334-341` |
| F07 | P1 | Suppression storage is not confined or reliably readable; source health ignores decisions | `src/storage/suppression-store.ts:87-92,178-203`; `src/runtime/suppression-writer.ts:124-126`; `src/queries/health/source-review.ts:62-67` |
| F05 | P2 | Indexed complexity disagrees with source metrics and counts candidate neighbors as callees | `src/queries/quality/complexity.ts:61-80,222-226` |
| F06 | P2 | Current-file locator includes tracked files deleted from disk | `src/platform/project-files.ts:828-839`; `src/queries/navigation/files.ts:14-19` |
| F08 | P2 | Test-quality treats a function declaration as an executed test | `src/queries/cleanup/test-quality.ts:163-186` |
| F09 | P2 | The formal-checker installer currently fails its pinned checksum | `src/tla/tool-runner.ts:76-78` |
| F10 | P3 | Default help and setup still direct users through the older product structure | `src/runtime/commands/command-panels.ts:84-86`; `src/runtime/project-setup.ts:1171` |

### F01 — Incorrect complete slices

Five counterexamples report `coverage.status: complete`, an empty unsupported list, and no omitted edges:

1. `let value = fallback; input && (value = input); return value;` loses `fallback` from the backward slice. Executing the function with `input = 0, fallback = 7` returns 7.
2. The equivalent conditional expression `input ? (value = input) : 0` has the same defect.
3. `const alias = state; alias.value = input; return state.value;` produces a slice containing only the final property read, omitting the write and input. Executing it changes the returned value to the input.
4. `const previous = value++; return value;` loses the increment that changes the returned value.
5. Syntactically invalid `const value = input + ;` still produces a complete slice.

The defense was to check the disclosed limitations and verify that this was not simply a bounded result. All five claim complete coverage with no unsupported constructs. Five executable valid-function oracles also confirm the expected behavior independently of the slice implementation. The straight-line reassignment control correctly excludes overwritten values, and an edge cap correctly produces bounded coverage.

Fix: reject parser diagnostics; represent conditional expression evaluation and nested mutation in the control-flow model; account for local aliases or explicitly disclose them as unsupported. Until then, prevent complete/extraction-safe conclusions for these constructs. This also matters to slice-cohesion and other consumers of the same local-flow provider; not every downstream symptom was separately reproduced.

### F02 — Missing file becomes another referent

`code src/runtime/command-kit/help.ts` reports one matched selector and returns `CommandDescriptor.helpAfter` from `command-descriptor-types.ts`, although the requested file does not exist. A small isolated fixture reproduces the substitution. An unrelated missing path correctly remains missing, so the failure depends on a partially matching symbol/path shape.

Fix: recognize an explicit file path before symbol lookup and preserve a missing-file outcome. Offer nearby symbols as suggestions without promoting one to the requested referent. Check both `code()` and `codeBatch()` consumers.

### F03 — Setup smoke results overstate execution

The real setup report marks `scip-query capability-matrix --json` as passed. Running that command exits 1: it no longer exists. The supported command is `capabilities --matrix`. Several other smoke rows, including diff impact and cleanup verification, are derived from prerequisites rather than the named operations being executed.

The defense is that the report includes explanatory evidence, so these are useful readiness checks. They are nevertheless stored as smoke tests with `pass` and a command string, which implies a stronger witness than exists. Setup health also reports `scip-query health` while actually invoking the indexed specialist implementation.

Fix: separate readiness checks from executed smoke tests, use current command descriptors, and require an execution result for a passed smoke test.

### F04 — Missing required trace silently ignored

An `Empty.scip-tla.json` mapping containing `traces: ["missing-trace.json"]` passes `tla verify ... --checker none` with exit 0 and no conformance findings. Adding the same path through `--trace` produces a load error and exit 1. This remains a defect independently of intentionally skipping the external model checker: invalid input should not disappear based on where it was declared.

Fix: retain every deduplicated trace load error from both mapping and CLI inputs. Add missing, malformed, and equivalent-path regression cases. This audit did not establish that a passing TLA model proves the application matches that model.

### F05 — Conflicting complexity and call counts

Cyclomatic complexity counts independent decision paths under the tool's stated rules. The current-source metric excludes nested function bodies from the parent and counts a nullish decision. The indexed command counts the nested function's branch in the parent and omits the nullish decision:

| Example | Source metric | Indexed estimate |
| --- | --- | --- |
| Parent returning a nested function containing one `if` | 1 | 2 |
| Function returning `x ?? 0` | 2 | 1 |
| Function with `if` and `else if` | 3 | 3 |

Separately, the actually indexed `choose` function contains no calls but `complexity` reports **three callees**. It opts into additive chunk evidence and counts all returned candidates. The ordinary call-graph/entry-map path correctly identifies the fixture's real `run → choose` call. This is a consumer contract error, not evidence that every graph edge is wrong.

Fix: share the TS/JS function metric implementation or retire the conflicting TS/JS estimate. Keep any other-language approximation explicitly distinct. Count actual call evidence separately from candidate neighbors. Do not use candidate counts to imply executable dependencies.

### F06 — Deleted files listed as current

Adding a file to Git and deleting it from disk still leaves it in `files` output. The Git inventory uses `git ls-files -co`, and the locator does not check present files. The source maintenance scanner already has a present-file filter, which is why this does not invalidate the earlier scanner inventory result.

Fix: use one explicit current-file inventory contract, retain deletion metadata separately for diffs, and disclose unreadable/racing entries. Do not make Git tracking status equivalent to file existence.

### F07 — Suppression persistence and integration

Three independent problems were reproduced:

- A source finding ID such as `complexity:src/calculate.ts:calculate` becomes a nested filename. `readSuppressionDir()` only scans the top directory, so a successfully written record is never loaded and produces no warning.
- A supplied ID `../../escaped-audit` creates `escaped-audit.json` outside the suppression directory. This was tested only inside a disposable fixture. Existing non-suppression file replacement has additional conflict checks; arbitrary overwrite of existing files was not established.
- First-use suppression requires an index. After indexing, a **flat filename** suppression for `complexity:root-complex.ts:classify` writes successfully and validates, but scoped source `health --check` still reports the same finding and exits 1 without an adjudication explanation. The flat-ID control separates this from the nested-file loader defect. The source health/review producer does not consume suppression decisions.

Fix: derive safe, confined filenames from stable identities; migrate/read existing records deliberately; verify write/read round trips; and integrate current-source finding adjudication without requiring a compiler index. If a decision is rejected, report why instead of silently dropping it.

### F08 — Declaration falsely reported as a bad test

For a file containing `declare function test(name: string, run: () => void): void;` and one actual assertion-free `test(...)` invocation, test-quality reports **two** high-severity findings. Its regular expression recognizes the declaration as another test call.

Fix: require a real invocation and inspect its callback body. A heuristic label permits investigation; it does not justify inventing a test invocation. The detector correctly identifies the actual weak test and the integrity detectors correctly identify the fixture's real stub and always-true checker.

### F09 — Formal-checker acquisition is blocked

`tla fetch-tools` fails checksum verification. The implementation pins SHA-256 `237332bdcc79a35c7d26efa7b82c77c85c2744591c5598673a8a45085ff2a4fb`; the downloaded bytes and the official GitHub API agree on `b658b4e504fdf0b721caf7066320f6b6fe5805f4dd2f717d0e47baba4097205e`. The API reports the asset updated on 2026-09-04. Captured metadata is in [tla-release.json](../../benchmarks/full-tool-audit/2026-09-05/artifacts/tla-release.json); the upstream [v1.8.0 release](https://github.com/tlaplus/tlaplus/releases/tag/v1.8.0) is marked prerelease.

The checksum guard correctly fails closed. Fix the distribution contract after verifying the intended artifact's provenance; retain verification and use an immutable artifact identity. No replacement checker binary was executed during this audit, so live SANY/TLC/Apalache adapter correctness remains unverified here.

### F10 — Product entry points still disagree

Ordinary help omits `health` and `review`, even though they implement the central exploration/janitorial workflow. Setup's optional health dossier uses the older indexed report and requires an index. Baseline options also route through indexed health. These modes have different findings and coverage contracts, but are still presented under a shared health label.

Fix: make first-use scan and change review visible entry points, label indexed specialists explicitly, and make setup exercise the same first-use scanner users are told to rely on. Keep optional formal modeling and less reliable heuristics outside the primary workflow.

## What is working, and what remains unverified

The earlier [LaunchPoint scanner validation](2026-09-05-first-use-validation.md) still supports its bounded claims: 5,306 eligible source files accounted for, no unresolved internal imports in that run, a source-confirmed four-file static value cycle, and 65 duplication groups. It does not prove conceptual ownership or runtime failure from a cycle. No mixed-responsibility candidate qualified in that repository.

This audit independently confirmed compiler indexing of a real small repository; exact source reads; the known call edge; straight-line value slicing; source metric calculations; CRAP values of 2, 2.5, and 6 for complexity 2 at full, half, and zero measured coverage; rejection of stale/malformed coverage; bounded-slice disclosure; missing-scope/config/base rejection; packed API loading; and local integration cleanup. CRAP combines complexity with measured test coverage; these checks validate its calculation, not test adequacy.

The watcher disclosed stale semantics during its cooldown, then published a fresh index with both newly added symbols. Setup/uninstall preserved user-authored agent text. These are real lifecycle witnesses in addition to the fault-injection and concurrency tests in the full suite.

The integrity drills are **not an exhaustive correctness certificate**:

- Ten targeted rejection paths were witnessed. Every private validator and fallback across the codebase was not individually given a constructed failing input.
- The TS SCIP-to-SQLite path had a captured real compiler output. Other language/framework adapters have existing fixture tests; no new independent real-repository calibration was performed for each one. Live formal-checker validation was blocked by F09.
- Primary indexing, exact reads, small-project semantic self-audit, source scanning, package loading, and watcher refresh ran. Every alternate service/fallback branch was not exercised on every OS. Windows/Linux lifecycle behavior was not run on those operating systems.
- Representative metrics were recomputed. Every specialist score and statistical estimate was not independently recalculated twice.
- The metric implementations were compared on shared inputs, exposing F05. The 32 repository twin-drift groups remain unadjudicated candidates; sharing a name does not establish a shared contract. Their exact members are retained in archived `twins.json`.
- Repository self-audit returned `available: false`, `oracleCoverage: 0` with the large-project semantic service stopped. The small fixture's self-audit was available. The repository test-quality scan had no indexed test files; its empty result is not a clean bill of health for the suite.
- There is still no controlled evidence that the tool improves agent change quality across representative projects. Earlier cheaper-model experiments and their limits remain documented separately.

## Repair order

1. Prevent incorrect complete slices, identity substitution, and suppression path escape. Preserve these failing probes as regressions before modifying their producers.
2. Fix false verification: setup smoke claims and TLA trace input handling.
3. Repair suppression round trips and connect accepted/rejected decisions to source review and health.
4. Consolidate complexity/call-count semantics and current-file inventory. Correct the test invocation detector.
5. Align help, setup, and baseline modes with the product's first-use and change-review workflow. Resolve the formal-checker artifact contract if that subsystem is retained.
6. Then run controlled agent evaluations: exact exploration answers, behavior-preserving changes, detection precision, and findings acted on correctly. Passing more implementation-shaped tests alone will not answer whether agents make better changes.

The durable repair checklist is [the audit plan](../plans/2026-09-05-full-tool-audit.md). Reproduction instructions are in the [probe README](../../benchmarks/full-tool-audit/2026-09-05/README.md).
