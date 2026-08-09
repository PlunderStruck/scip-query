# Workflow API retirement compatibility

## Scope

Version `0.20.0` removed scip-query's autonomous work-state, outcome-journal, and blocking diff-gate subsystems. The removal is an intentional product contraction: scip-query supplies repository evidence, while the calling agent owns task state and completion judgment.

## Feasible bridges retained

- `planContext`, `PlanContextOptions`, `PlanContextHistory`, and `PlanContextResult` are deprecated aliases of the corresponding `repositoryContext` surface.
- `scip-query/queries/plan-context` remains a package export for one minor release.
- `OutcomeEvent`, `OutcomeEventKind`, and the outcome-observer provenance types remain as deprecated historical record shapes for one minor release. scip-query does not write, read, reconcile, or claim authority over those records.

These bridges preserve existing imports and consumer-owned serialized data without restoring a second task owner.

## Runtime adapter intentionally unavailable

`diffGate`, `blockingFindings`, `diffGateFailedClosed`, and `diffGateFailureReason` do not have a compatibility runtime adapter. Their defining behavior was to combine many analyzers into a completion gate and decide whether work could stop. Mapping them to `diff-impact`, `health`, or `architecture` would not preserve their contract: it would return a differently scoped result under an old name and could cause an old caller to treat incomplete evidence as an authoritative gate decision. A throwing stub would preserve module loading but not a valid consumer.

Use the explicit read-only replacements instead:

- `diffImpact` for changed symbols and downstream consumers;
- `health` and its focused analyzers for repository findings;
- `architecture` for declared boundary violations;
- the calling agent's own policy for whether those observations block completion.

The `scip-query/queries/diff-gate` package path and runtime functions therefore remain a documented breaking removal. Reintroducing them requires a new product contract rather than a compatibility alias.
