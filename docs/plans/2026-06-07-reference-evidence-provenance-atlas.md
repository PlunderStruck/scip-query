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
| P3 | Do not force all caller/callee maps onto provenance records yet. | Caller/callee detectors need a broader result migration; this slice proves the record shape at the reference-site boundary. | defer |

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

## Compression Audit

This adds the missing fact without breaking existing query surfaces: the project now has a provenance-bearing reference evidence record, while older callers can keep using plain `ReferenceSite` rows. It is deliberately narrower than a full caller/callee provenance migration, but it establishes the record shape at the evidence selection point where the source-vs-SCIP decision already exists.
