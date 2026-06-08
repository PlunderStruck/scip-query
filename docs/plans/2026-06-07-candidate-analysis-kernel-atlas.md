# Candidate Analysis Kernel Compression Atlas

Date: 2026-06-07
Scope: candidate-style detectors in `src/queries/wrapper-candidates.ts`, `src/queries/passthrough-candidates.ts`, `src/queries/complexity-hotspots.ts`, and shared query utilities.

A candidate analysis kernel is a small execution shape for detectors that inspect many possible code units and return a ranked report. Its real-world referents are candidate definitions, scan budgets, bulk evidence maps, per-candidate scoring functions, filtered findings, sorted reports, and CLI limits; its defining characteristic is that it turns many possible symbols into a bounded, ranked set of findings through one repeatable lifecycle.

A scan budget is the maximum number of candidates a detector should inspect during a run. Its real-world referents are CLI `--scan-limit` values, health candidate limits, sorted candidate lists, and sliced arrays; its defining characteristic is that it bounds expensive evidence gathering while preserving deterministic candidate order.

## Scope Map

- New kernel: `src/queries/internal/candidate-scan.ts`.
- Migrated detectors: `wrapperCandidates()`, `passthroughCandidates()`, and `complexityHotspots()`.
- Shared ordering: `compareDefinitionsBySmallestLoc()` in `src/queries/query-utils.ts`.
- Focused tests: `tests/debloat-health.test.ts` and `tests/command-accuracy.test.ts`.

## Role Inventory

- Candidate source: each detector loads the production definitions it can score.
- Candidate ordering: wrapper and passthrough detectors inspect smaller definitions first before applying scan limits.
- Evidence preparation: detectors build caller, callee, or fan-in maps once for the bounded candidates.
- Candidate evaluation: each detector owns its domain decision and result projection.
- Result ranking: each detector owns the order that makes its report useful.

## Opportunity Ledger

| ID | Opportunity | Evidence | Disposition |
| --- | --- | --- | --- |
| A1 | Extract the shared candidate lifecycle. | `wrapperCandidates()`, `passthroughCandidates()`, and `complexityHotspots()` each loaded candidates, applied scan limits, prepared maps, looped, sorted, and sliced. | extract |
| A2 | Keep detector-specific scoring local. | Wrapper fan-in, literal passthrough body checks, and complexity scoring are different domain decisions. | keep |
| A3 | Centralize repeated candidate ordering. | Wrapper and passthrough used identical "smallest LOC, then file path" ordering. | extract |
| A4 | Do not migrate heavyweight detectors into this small kernel. | `dead()` and `staleAbstractions()` have richer evidence and candidate gates; forcing them through the first kernel would obscure their policies. Follow-up evidence boundaries landed in `reference-counts`, `consumer-evidence`, and `dead-candidate-gate` instead. | skip - closed |

## Dependency Order

1. Add `runCandidateAnalysis()` as the small kernel.
2. Migrate wrapper and passthrough detectors because they have the clearest loop shape.
3. Migrate complexity hotspots to prove the kernel handles bulk evidence maps and row projection.
4. Keep `dead()` and `staleAbstractions()` outside this kernel; their follow-up work is evidence provenance and candidate-gate naming, which landed in later passes.

## Touch Map

- `src/queries/internal/candidate-scan.ts`: new detector lifecycle.
- `src/queries/wrapper-candidates.ts`: candidate lifecycle migration.
- `src/queries/passthrough-candidates.ts`: candidate lifecycle migration.
- `src/queries/complexity-hotspots.ts`: candidate lifecycle migration.
- `src/queries/query-utils.ts`: shared definition ordering.
- `docs/plans/2026-06-07-primogen-disgust-register.md`: completion note.
- `docs/plans/2026-06-07-candidate-analysis-kernel-atlas.md`: this ledger.

## Validation Plan

```bash
npm run typecheck
npm run lint
npm test -- tests/debloat-health.test.ts tests/command-accuracy.test.ts
npm test
npm run build
node dist/cli.js reindex --force --allow-partial
node dist/cli.js wrapper-candidates --max-loc 40 --limit 80
node dist/cli.js passthrough-candidates --max-loc 40 --limit 80
node dist/cli.js complexity-hotspots --limit 20
node dist/cli.js health --json
node dist/cli.js drift --min-deviation 3
node dist/cli.js stale-abstractions --include-low-confidence --min-loc 1 --limit 120
```

Validation result:

- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm test -- tests/debloat-health.test.ts tests/command-accuracy.test.ts`: passed, 26 tests.
- `npm test`: passed, 36 files and 178 tests.
- `npm run build`: passed.
- `node dist/cli.js reindex --force --allow-partial`: passed.
- `node dist/cli.js wrapper-candidates --max-loc 40 --limit 80`: returned only the 4 pre-existing evidence/AST boundary candidates.
- `node dist/cli.js passthrough-candidates --max-loc 40 --limit 80`: no passthrough candidates.
- `node dist/cli.js complexity-hotspots --limit 20`: returned normal hotspot rows.
- `node dist/cli.js health --json`: score 100, zero findings.
- `node dist/cli.js drift --min-deviation 3`: no drift.
- `node dist/cli.js stale-abstractions --include-low-confidence --min-loc 1 --limit 120`: no stale abstractions.

## Compression Audit

This removes a detector-family concept from individual query modules: candidate lifecycle mechanics now have one home, while detector evidence and scoring remain local. The kernel is intentionally narrow. It does not try to model every analysis command; it only captures the lifecycle already shared by the small candidate detectors.

## Deferred-Task Closure

No detector migration remains deferred here. The small candidate kernel is the
right shape for wrapper, passthrough, and complexity-hotspot scans. The heavier
detectors were closed through named evidence modules rather than migration into
this kernel, because their real shared problem is evidence truth rather than
loop mechanics.
