# Directory moves (absorbs scip-directory-architecture, act half)

Use to move files to fix locality or to close a dependency rule, once `scip-directory-architecture` has produced a target structure or move ledger. If there's no reviewed target structure yet, run that skill first — this reference starts from its output and never invents a target structure on its own.

## Find and confirm the move

Run `scip-query locality-candidates --json --full` for directory-locality and ancestry candidates from consumer ownership (symbols, current homes, consumer locality, suggested homes). Cross-check current placement with `scip-query system <scope>` (files, exported symbols with line ranges, internal deps, reverse deps).

Concepts that decide whether a move is safe:

- **Ownership boundary** — a folder, package, module, or convention grouping code around one stable responsibility.
- **Forbidden edge** — an actual cross-boundary dependency rejected by an explicit project rule. Directory distance or an unusual import alone does not make an edge forbidden.
- **Reciprocal dependency** — traffic in both directions between two boundaries. It's a review signal that the boundaries exert mutual pressure, not proof that either import is wrong.
- **Migration slice** — the smallest set of file moves and import updates that can be verified independently.

Rules: separate review from migration — don't move files unless asked. Preserve broad boundaries when evidence shows they're intentional. Don't reward a generic "shared" boundary/directory unless the shared concept has a name, an owner, and cross-boundary consumers. Prefer small verified moves over large speculative reorganizations. Configure descriptive boundaries before closing dependency rules.

Before editing a slice, state: the files to move, the imports/exports/tests/docs to update, the expected verification, and the rollback risk.

## If boundaries themselves are changing

Add mature boundary path patterns to `.scipquery.json` under `architecture.boundaries` **without** `allowedDependencies` rows first, e.g.:

```json
{ "architecture": { "boundaries": [
  { "name": "domain", "paths": ["src/domain/**"] },
  { "name": "runtime", "paths": ["src/runtime/**"] }
] } }
```

Then run `scip-query config-validate --json`, then `scip-query architecture --json`.

An `allowedDependencies` row is closed: an outgoing target omitted from a present row is forbidden, but a missing row makes no dependency claim at all. Example: `{ "architecture": { "boundaries": [...], "allowedDependencies": { "domain": [], "runtime": ["domain"] }, "requireAcyclic": true } }`. For each closed row, record the evidence for its intended direction. Never copy the current dependency graph into the allow-list merely to obtain zero findings; leave emerging or disputed rules undeclared rather than closing the row prematurely.

When repairing a boundary cycle, inspect the least-broad edge inside it first, then decide whether the fix is a move, a dependency inversion, a named shared contract, a boundary merge, or a policy correction.

## Ratcheting enforcement on a large repo

Before enabling architecture regression enforcement on an existing codebase, review the direct findings with `scip-query drift --architecture` and record reviewed existing debt with `scip-query health --write-baseline`. The baseline records stable architecture identities by boundary pair, not by whichever example file happens to sort first. Commit `.scipquery-baseline.json` together with `.scipquery.json`.

The default `diff-gate` architecture check compares only architecture identities and does not run every health detector; `diff-gate --baseline` is the opt-in full health ratchet and does not duplicate architecture findings. A missing baseline causes the architecture gate to report that enforcement is not enabled — it does **not** silently treat the current dependency graph as accepted.

## After moving the slice

Run `scip-query incomplete-migration`, `scip-query recent-duplicates`, and `scip-query co-change <moved-file-or-config>`, plus the project's tests or typecheck for the affected workspace.

If `.scipquery.json` locality changed, also run `scip-query config-validate`, `scip-query locality-candidates --json --full`, `scip-query architecture --json`, `scip-query drift --architecture`, and `scip-query diff-gate`.

Then invoke `scip-verify`. The implementation is complete only when imports, tests, locality signals, and verification are all checked.
