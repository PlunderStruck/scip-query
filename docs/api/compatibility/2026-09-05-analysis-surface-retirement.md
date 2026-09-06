# Analysis surface retirement

This breaking change removes expired compatibility surfaces and makes flow claims
match the analysis that produces them.

| Removed surface | Supported replacement |
| --- | --- |
| `anchors`, `discoverAnchors`, `normalizeAnchorQuery` | Exact `search`, `outline`, and `entrypoints`, followed by explicitly selected `evidence` relationships |
| `system-map` command and public query subpath | `evidence` for relationships; `inspect --view behavior` for remaining source questions |
| `evidence-source` and positional legacy `evidence` routing | `inspect` with explicit selectors |
| `deep-chains`, `deepChains` | `dependency-depth`, `dependencyDepth` |
| `convergence` command/query | `similar --plan`, `similarConsolidationPlan` |
| `dataflow`, `DataflowResult` | `reference-neighborhood` for references and calls; `value-flow` for actual value transfers |
| `slice`, `SliceResult` | `reference-reachability`, `ReferenceReachabilityResult` for reference/call reachability |
| `plan-context`, `planContext`, `PlanContext*` | `context`, `repositoryContext`, `RepositoryContext*` |
| Historical `OutcomeEvent*` / `OutcomeObserver*` type exports | No runtime replacement: the outcome journal was retired in 0.20.0 |
| Health `score`, `riskScore`, `hygieneScore`, `scoreBreakdown`, `pressure` | Individual findings, measurements, policy exclusions, and coverage |

The shared topology providers remain because current `evidence` and `value-flow`
use them. Public command removal does not imply that every internal type containing
the words “system map” describes redundant analysis.

`RepositoryContextResult.dataflow` becomes `referenceNeighborhood`; its fields are
`referenceSites`, `outgoingCalls`, and `incomingCalls`. `backwardSlice` becomes
`calleeReachability`, `forwardSlice` becomes `referenceOwners`, and `sliceDepth`
becomes `referenceDepth`; the CLI option becomes `--reference-depth`. These fields describe references and calls, with no value
transfer claim. Setup health summaries use `available: boolean`; cached reports
using the old grading shape are invalidated.

`dependence-slice` now requires an exact `file:line` and identifies one variable
occurrence, optionally narrowed by `--variable` and one-based `--column`. It returns
function-local compiler points and dependence edges. The old symbol and containing
source summaries are replaced by ordinary `evidence` projections. The result now
contains criterion resolution, compiler analysis coverage, and output/depth bounds;
it no longer mixes call connectors into the slice. Programmatic point coordinates
are zero-based TypeScript source coordinates.

The analysis follows reaching definitions, assignment value sources, and branch
control dependencies. General heap aliasing, other callees' behavior, and closure
invocation order remain outside its proof. Unsupported compiler constructs are
reported, and ambiguity does not silently select an occurrence. Splitting
recommendations remain review candidates, not permission to extract code.

The retired navigation session could require `anchors` followed by `system-map`
before allowing a source read. That state and enforcement are removed. Immutable
output continuation and source-evidence receipts remain supported.

Skill installation defaults to `scip-query` and `scip-explore`. Use
`install-skills --all` for all shipped specialists. Existing optional installations
and user-owned directories are preserved.
