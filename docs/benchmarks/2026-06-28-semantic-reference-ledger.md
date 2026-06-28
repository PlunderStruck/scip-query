# Semantic Reference Bulk Optimization Ledger

## Output Contract

- Target shared path: `semanticCallerMap()`
- Target provider path: `TsMorphSemanticProvider.referencesForDefinitions()`
- Primary benchmark command: `scip-query dead --json --full`
- Large benchmark corpus: `/Users/aydansalois/Documents/GitHub/Vega_2.0`
- Required behavior: preserve caller-file evidence semantics, persistent
  `semantic_references` cache rows, dead-symbol output JSON, and TypeScript
  member/override precision.

## Measurements

| Case                                       | Duration | stdout bytes | SHA-256                                                            | Notes                                                                          |
| ------------------------------------------ | -------: | -----------: | ------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Legacy baseline at `0720bac`, cold direct  |   24.40s |    3,804,419 | `b7afa7e3cdd88c02ed31ffaf02da9547b6187591ef681dc67882dbfef76bc2e8` | Temporary worktree build; semantic reference cache cleared first.              |
| Final filtered hybrid, cold direct         |   14.31s |    3,804,419 | `b7afa7e3cdd88c02ed31ffaf02da9547b6187591ef681dc67882dbfef76bc2e8` | Same output hash as baseline.                                                  |
| Final filtered hybrid, cold profiled bench |  13.333s |    3,804,419 | same                                                               | `typescript.references-map.inverted-scan` 3.034s; precise member files 5.386s. |
| Final filtered hybrid, warm bench          |   1.064s |    3,804,419 | not rehashed                                                       | Run after the cold cache-fill.                                                 |

## Profile Breakdown

Final cold profiled Vega run:

- `dead.candidates`: 155ms for 9,492 definitions.
- `dead.mention-reference-counts`: 47ms for 8,885 symbols with references.
- `dead.source-fallback.ast`: 501ms for 5,584 source candidates.
- `dead.caller-map-supplement`: 12.089s for 4,199 candidates.
- `semantic.references.compute-misses`: 12.051s for 4,195 TypeScript misses
  plus 4 unkeyed definitions.
- `typescript.references-map.inverted-scan`: 3.034s for 3,623 non-member
  definitions, 1,777 files, 585,275 identifiers, and 103,232 checker lookups.
- Precise member fallback: 5.386s across 113 files and 572 definitions.
- `semantic.references.cache-write`: 7ms for 4,195 entries.

## Decisions

- Accepted: add an optional provider bulk reference API and compute semantic
  reference cache misses in grouped provider batches.
- Accepted: add the TypeScript inverted reference scan for large non-member
  batches. The scan uses a cheap identifier-name prefilter plus imported local
  names before asking the checker for symbols.
- Superseded by the remaining semantic optimization pass: keep
  `findReferences()` for `.d.ts` type members, but allow compiler-symbol
  inverted scans for other member symbols after Vega `stale-abstractions`,
  `isolated`, and `wrapper-candidates` outputs stayed byte-identical.
- Accepted: add `bench --profile` spans to the dead caller-evidence stages so
  future work can see the command's internal phase costs.
- Rejected: pure dispatch batching as the final optimization. It preserved
  output but left cold Vega `dead --full` around 25.6s-26.1s.
- Rejected: unfiltered inverted scan as the final algorithm. It was faster and
  found more references, but it added member/override dead-code findings that
  the precise TypeScript reference search correctly suppresses.

## Follow-Up

The follow-up ledger
`docs/benchmarks/2026-06-28-remaining-semantic-optimization-ledger.md` records
the later accepted member-scan relaxation, lower bulk threshold, wrapper
candidate trimming, drift gate reorder, and ts-morph project startup reduction.

## Verification

- Passed: `npx prettier --write src/semantic/typescript/ts-morph-provider.ts src/queries/cleanup/dead.ts`
- Passed: `npx tsc --noEmit --pretty false`
- Passed: `npm run build`
- Passed: `npx vitest run tests/semantic/typescript/typescript-semantic-provider.test.ts tests/queries/cleanup/similar-topk.test.ts tests/queries/navigation/command-accuracy.test.ts tests/runtime/profile.test.ts`
- Passed: Vega legacy/current cold output comparison for
  `dead --json --full`, matching SHA-256
  `b7afa7e3cdd88c02ed31ffaf02da9547b6187591ef681dc67882dbfef76bc2e8`.
