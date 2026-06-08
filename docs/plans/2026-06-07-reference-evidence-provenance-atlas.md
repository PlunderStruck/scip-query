# Reference Evidence Provenance Atlas

Date: 2026-06-07
Scope: reference-site evidence selection in `src/symbols/reference-sites.ts` and advanced query tests.

Reference evidence provenance is the recorded origin of a reported reference site. Its real-world referents are source-attributed identifier references and SCIP reference chunks refined to source lines; its defining characteristic is that it tells callers why a reference row should be trusted and which fallback path produced it.

## Scope Map

- Evidence selector: `referenceEvidenceForSymbol()` in `src/symbols/reference-sites.ts`.
- Compatibility surface: `referenceSitesForSymbol()` still returns plain `ReferenceSite` rows.
- Provenance modes: `source-attribution` and `scip-reference-chunk`.
- Contract test: `tests/queries-advanced.test.ts`.

## Opportunity Ledger

| ID | Opportunity | Evidence | Disposition |
| --- | --- | --- | --- |
| P1 | Preserve provenance when choosing source-backed references or SCIP fallback references. | `referenceSitesForSymbol()` already chose between `findReferences()` and `getResolvedReferenceSites()`, but returned plain rows. | extract |
| P2 | Keep old callers compatible. | `refs`, `trace`, `dataflow`, and `slice` consume plain reference rows. | keep |
| P3 | Add provenance to caller/callee row records without rewriting every map consumer. | `CallerRow` and `CalleeRow` are the compatibility records consumed by call-graph, dataflow, slice, bottlenecks, affected, and similar queries. | merge - landed |

## Follow-Up Slice

`CalleeRow` now records `ast-callsite`, `semantic-callee`, or `scip-chunk`.
`CallerRow` now records `caller-map-inversion`, `resolved-reference`, or
`semantic-reference`. Existing callers keep their row shape and can ignore the
new field, while future detectors no longer have to infer evidence origin from
which helper produced the row.

## Validation Plan

```bash
npm run typecheck
npm run lint
npm test -- tests/queries-advanced.test.ts tests/debloat-health.test.ts tests/command-accuracy.test.ts
npm test
npm run build
node dist/cli.js reindex --force --allow-partial
node dist/cli.js health --json
node dist/cli.js drift --min-deviation 3
node dist/cli.js stale-abstractions --include-low-confidence --min-loc 1 --limit 120
```

Validation result:

- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm test -- tests/queries-advanced.test.ts tests/debloat-health.test.ts tests/command-accuracy.test.ts`: passed, 36 tests.
- `npm test`: passed, 36 files and 178 tests.
- `npm run build`: passed.
- `node dist/cli.js reindex --force --allow-partial`: passed.
- `node dist/cli.js health --json`: score 100, zero findings.
- `node dist/cli.js drift --min-deviation 3`: no drift.
- `node dist/cli.js stale-abstractions --include-low-confidence --min-loc 1 --limit 120`: no stale abstractions.

Deferred-task closure result:

- `npm run lint` passed.
- `npm run typecheck` passed.
- `npm test` passed: 38 files, 185 tests.
- `npm run build` passed.
- `node dist/cli.js reindex --force --allow-partial` passed.
- `node dist/cli.js health --json` reported score 100, zero stale types, zero drifted files, zero wrappers, zero passthroughs, zero dead symbols, and zero isolated symbols.
- Caller and callee row provenance is now recorded in `src/symbols/call-graph-evidence.ts`.

## Compression Audit

This adds the missing fact without breaking existing query surfaces: the project now has a provenance-bearing reference evidence record, while older callers can keep using plain `ReferenceSite` rows. It is deliberately narrower than a full caller/callee provenance migration, but it establishes the record shape at the evidence selection point where the source-vs-SCIP decision already exists.
