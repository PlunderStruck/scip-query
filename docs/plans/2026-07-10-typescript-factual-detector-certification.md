# TypeScript Factual Detector Certification Plan

Date: 2026-07-10
Status: Complete

## Goal

Audit and harden the ten TypeScript factual detectors using the same standard
as the completed `dead` campaign. Done means every detector has a truth rule,
real-repository candidate inventory, classified evidence, known-positive
coverage, regression protection, replay result, and honest certification state.

## Current State

- `scripts/accuracy-calibration.mjs` already creates detached read-only
  worktrees, fresh indexes, deterministic samples, source excerpts, reviewed
  packets, and Wilson summaries for `dead`.
- `scripts/accuracy-calibration-core.mjs` owns deterministic row identities,
  sampling, verdict application, confidence intervals, and certification.
- The query implementations expose distinct result shapes: file-local arrays
  for `unused-imports`; global arrays for most detectors; a cycle object;
  three ledgers for `test-quality`; and per-symbol measurements for
  `complexity`.
- The primary query entry points and current consumers were verified with
  `scip-query code unusedParams`, `scip-query code cycleSummary`,
  `scip-query code exactDuplicateBodyMatches`, `scip-query code isolated`,
  `scip-query code redundantReexports`, `scip-query code notImplemented`,
  `scip-query code decorativeCheckers`, `scip-query code testQuality`, and the
  corresponding `scip-query refs` commands.

## Reuse Audit

Extend the existing calibration packet and summary machinery. Do not create a
second confidence calculation, sampler, worktree manager, or verdict format.
Add detector adapters only where output shapes or truth rules differ. Existing
query tests remain the known-positive seams and gain cases only for newly found
archetypes.

## Truth Rules

| Detector              | Repeatable truth rule                                                                                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `unused-imports`      | The named binding is imported into the reported file and no executable, type, decorator, JSX, namespace, re-export, or other language-valid use of that binding exists there.        |
| `unused-params`       | Every reported trailing simple parameter is absent from the callable body; the callable is a production implementation rather than a required interface or framework signature.      |
| `cycles`              | Every adjacent pair in the closed path is a real dependency edge in the accepted index; architectural harm is not part of this fact.                                                 |
| `duplicate-bodies`    | Every grouped callable has the same normalized implementation body and is in a different file; consolidation is not part of this fact.                                               |
| `complexity`          | The reported source span and LOC match the definition, branches match the documented AST node contributions or disclosed fallback, and cyclomatic estimate equals branches plus one. |
| `isolated`            | The production callable has neither a non-self caller nor a non-self callee after compiler, source, framework, test, and configured-root evidence is considered.                     |
| `redundant-reexports` | No repository consumer imports the named export through the reported barrel; public package surfaces are signals, not direct removal claims.                                         |
| `not-implemented`     | The callable is a placeholder implementation and a production entry, export, override, or caller can reach it.                                                                       |
| `decorative-checkers` | The callable's name and behavior promise validation or a predicate, but no reachable throw, rejecting result, false result, diagnostic sink, assertion, or failing delegate exists.  |
| `test-quality`        | The cited test is genuinely assertion-free, intentionally skipped, or asserts the same simple literal supplied by its mock, according to the reported subtype.                       |

## Testability Design

| Behavior              | Test seam               | Dependencies                    | Pure core                    | Side-effect shell              | Contract                                               |
| --------------------- | ----------------------- | ------------------------------- | ---------------------------- | ------------------------------ | ------------------------------------------------------ |
| Packet generation     | calibration CLI mode    | Git, filesystem, CLI process    | normalization and sampling   | detached worktree/index runner | schema-versioned JSON packet                           |
| Certification summary | `summarizeCalibration`  | none                            | Wilson and state calculation | packet renderer                | stable counts and status                               |
| Detector hardening    | existing query function | SQLite/source/semantic provider | classifier helpers           | query orchestration            | emitted finding obeys truth rule                       |
| Recall protection     | focused Vitest fixture  | temporary fixture DB/source     | detector classification      | fixture construction           | known positive is emitted and known negative is absent |

## Execution Checklist

### 1. Extend the reusable calibration harness

- [x] **Files**: `scripts/accuracy-calibration.mjs`,
      `scripts/accuracy-calibration-core.mjs`,
      `tests/scripts/accuracy-calibration-core.test.ts`
- **Source**: `scip-query plan-context src/runtime/cli.ts`; existing harness
  source and the `dead` certificate.
- **Change**: Add detector manifests, shape adapters, deterministic
  per-repository sampling, generic packet rendering, and reviewed summaries.
- **Validation**: Core tests plus one generated packet covering every adapter.
- **Why**: All detectors need one reproducible evidence format.

### 2. Run the pinned TypeScript baseline

- [x] **Repositories**: Vega_2.0, openwork, Stable_Management, traceroot
- **Source**: corpus declared in `docs/accuracy-hardening-goal.md`.
- **Change**: Generate uncapped counts and deterministic samples from detached
  worktrees at recorded commits.
- **Validation**: Every repository records capability state, commit, count,
  sample, and source excerpt without changing its tracked worktree.
- **Why**: A detector cannot inherit `dead`'s evidence merely by using the same
  index.

### 3. Classify and harden factual findings

- [x] **Files**: detector implementations and their existing focused tests,
      selected only when a false-positive or false-negative archetype is proven.
- **Source**: the query-specific `scip-query code` and `scip-query refs`
  commands listed in Current State.
- **Change**: Fix shared archetypes at the narrowest classifier or evidence
  boundary; never suppress individual corpus rows or tune to green.
- **Validation**: Original bad rows disappear, baseline-valid rows remain, and
  a fresh deterministic holdout is reviewed.
- **Why**: Precision improvements must remove unsupported claims without
  erasing known true findings.

### 4. Prove known positives

- [x] **Files**: existing detector test files under `tests/queries/`
- **Source**: `scip-query outline` for each detector implementation; tests are
  deliberately not part of the production SCIP index and are inspected as
  fixture oracles.
- **Change**: Ensure each detector and each `test-quality` subtype has at least
  one positive plus boundary negatives covering discovered archetypes.
- **Validation**: Focused Vitest suite and full typecheck.
- **Why**: A clean corpus result can otherwise mean the detector sees nothing.

### 5. Replay and publish results

- [x] **Files**: `docs/validation/2026-07-10-typescript-factual-detectors.md`,
      `docs/accuracy-hardening-goal.md`, `docs/accuracy-audit-checklist.md`
- **Source**: generated baseline, reviewed, and replay packets.
- **Change**: Record counts, precision, confidence, recall cases, noise
  archetypes, exclusions, and one certification state per detector.
- **Validation**: Reports can be regenerated from the documented commands and
  no status exceeds its evidence gates.
- **Why**: The roadmap and eventual public output need machine-checkable limits,
  not a blanket accuracy claim.

### 6. Repository verification

- [x] Run focused tests, the full project check, `scip-query reindex`, and
      `scip-query diff-gate --json`.
- [x] Run postchecks matching any helpers, parameters, wrappers, schemas, or
      deletions introduced during hardening.
- [x] Explain or fix every gate finding before completion.

## Stress-Test Findings

- Low-volume detectors may remain `insufficient evidence` even when every
  observed row is valid; fixtures prove reachability, not population precision.
- `isolated` is fact-like only under its narrower no-callers-and-no-callees
  contract. It must not be reported as synonymous with deletable code.
- Public package re-exports cannot be certified as removable from repository
  evidence alone. The analyzer must keep them in a signal tier.
- Complexity must publish its basis. AST and regex counts are not silently
  interchangeable measurements.
- Test-quality subtypes require separate counts because one precise subtype
  cannot compensate for another noisy subtype.

## Ship Order

1. Checklist and executable plan.
2. Backward-compatible calibration schema and tests.
3. Detector fixes with focused regressions.
4. Replay packets and certification report.
5. Roadmap/checklist status update and repository-wide verification.

All steps are reversible. Changing a detector's public finding semantics is the
only externally visible door; each such change must ship with a regression test
and a certificate renewal note.
