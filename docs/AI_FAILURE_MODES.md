# Coding-agent failure modes

scip-query helps with failures caused by an incomplete repository map. It does
not prevent every coding error and does not replace tests.

## Narrow implementation

The edit handles the obvious entry point but misses consumers, callers, or
parallel paths. Use `scip-query context <target>` before the edit and
`scip-query diff-impact` after it.

## Retirement residue

A replacement works, but old helpers, exports, adapters, tests, or docs remain
and mislead later agents. Inspect `scip-query incomplete-migration --full`,
`scip-query dead --full`, and the changed source. A detector suggests where to
look; source and native checks decide what can be removed.

## Duplicate or drifted concepts

An agent creates another implementation instead of reusing the current owner,
or updates one twin while leaving another behind. Inspect
`scip-query duplicate-bodies --full`, `scip-query twin-drift --full`, and
`scip-query recent-duplicates --full`.

## Structural drift

The code works locally but violates declared dependency rules or spreads one
concept across inappropriate boundaries. Inspect `scip-query architecture` and
the relevant dependency edges.

## Framework cleanup missed

Repeated React components or hooks, or repeated Vue components or composables,
remain invisible to a language-neutral review. Use the React and Vue detector
families in `scip-query health --full`, then confirm candidates in source.

## Ceremony without information

Repeated status checks, duplicate queries, and record writing spend time
without changing the agent's decision. scip-query therefore keeps work-state
ownership outside the tool. Reuse evidence while repository state and coverage
needs are unchanged.
