# Bidirectional causal slicing

## Outcome

`system-map` should expose a bounded causal envelope around the agent's explicit
anchors: the strongest known code that can cause the selected behavior, the
strongest known code that carries its result to an observable consequence, and
an exact manifest of every withheld direction. The selector must use typed
repository relationships rather than repository-specific vocabulary.

The first acceptance target is the frozen TSLint configuration-inheritance
holdout. Its treatment must recover the upstream runner reuse and the
result-producing merge callback without regressing the existing Vega runtime-
boundary flow or spending native source reads.

## Current path

`systemMap()` owns topology construction, connected-behavior compression, and
the optional drill packet. It calls `systemMapNextAnchorPacket()` directly
(`scip-query context systemMapNextAnchorPacket`,
`src/queries/graph/system-map.ts:1282`).

`systemMapNextAnchorPacket()` currently inspects behavior lines carrying a
`call` signal, resolves outgoing callees, ranks them, and exposes at most six
drill targets (`src/queries/internal/next-anchor-candidates.ts:75-355`). It does
not inspect incoming topology edges, and its topology-edge loop accepts only
`edge.kind === 'call'` (`src/queries/internal/next-anchor-candidates.ts:133-139`).
The topology selector already retains typed paths, folded frontier groups, and
both edge directions around explicit anchors
(`src/queries/internal/exploration-topology.ts:267-381`). Runtime handoffs are
currently composed separately by `crossBoundaryFlowGroups()`
(`src/queries/navigation/anchor-discovery.ts:639-747`).

That asymmetry explains the held-out failure. `doLinting()` is an incoming
caller of the selected configuration flow, while `extendConfigurationFile()` is
a callable reference supplied to `Array.reduce`; neither is an ordinary
outgoing direct call from the displayed behavior.

## Implementation slices

| Change                                                                                                                        | Direct evidence                                                                                                                                                | Preserve                                                                                   | Retire                                                                               | Prove                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Add causal direction, role, and relation kind to next-anchor records and render upstream, downstream, and connector groups    | `SystemMapNextAnchor` currently exposes only `graph-call` versus `leaf-identity-candidate` at `src/queries/internal/next-anchor-candidates.ts:25-42`           | Existing JSON fields and inspect commands remain readable; additions are optional/additive | The assumption that every drill target is a callee                                   | API contract check plus renderer tests                                               |
| Derive upstream caller candidates from incoming proved call edges already present in `ExplorationTopology`                    | The current selector scans only `edge.fromNodeId === step.nodeId`; selected topology already frontier-accounts folded edges                                    | Exact/derived evidence labels and bounded output                                           | Cross-boundary-only upstream discovery as the sole way to expose preconditions       | Unit fixture where an unrendered caller is selected and batched with downstream gaps |
| Derive result-callback candidates from callable reference edges whose evidence lies on displayed call/return/mutation lines   | TSLint passes `extendConfigurationFile` as data to `reduce`; the current selector ignores non-call edges                                                       | Ambiguous references remain candidates, never facts                                        | Treating a visible direct-call leaf as the only callable continuation                | Unit fixture with a reducer callback and a distractor reference                      |
| Make coverage selection reserve causal roles before filling by score, and emit a typed withheld-frontier manifest             | `coverageDiverseNextAnchors()` currently reserves connectors and one candidate per explicit anchor at `src/queries/internal/next-anchor-candidates.ts:365-411` | Six-target default and deterministic order                                                 | A single downstream ranking pool that can displace all upstream or callback evidence | Deterministic selection tests for upstream, result, anchor, and connector coverage   |
| Teach the agent protocol to use the combined causal drill command when a requested stage remains upstream or result-producing | The current skill gives special upstream treatment only to cross-boundary sets                                                                                 | One locator, one map, one batched inspect                                                  | Runtime-boundary-specific drill guidance                                             | Agent-setup snapshot and benchmark-prompt tests                                      |
| Re-run isolated held-out and regression benchmarks                                                                            | Frozen TSLint and Vega fixtures plus detached benchmark runner                                                                                                 | Same commits, model, facts, and cleanup contract                                           | Any result obtained after repository-specific tuning                                 | TSLint treatment/control comparison, then Vega treatment regression                  |

## Compatibility

The structured packet is read by the CLI renderer and may be consumed by
external TypeScript callers. New causal metadata must therefore be additive;
existing fields and meanings remain intact. If a field cannot be added without
changing an existing meaning, record the intentional break in the public API
acceptance ledger before updating the snapshot.

## Open uncertainty

The first slice can reuse incoming `call`, outgoing `reference`, and existing
`runtime-boundary` edges. Full def-use and control-dependence integration may
require enriching `ExplorationTopology`; that should follow only after the
held-out evidence establishes which missing facts cannot be represented by the
edges already indexed. The next resolving command is a focused
`scip-query context` on the dataflow query owner, not a repository-specific
extractor.

## Implemented result

The first causal slice is complete:

- incoming proved `call` edges produce typed upstream caller candidates;
- outgoing compiler-resolved non-call references produce callable-reference
  edges, including result-producing callbacks;
- outgoing and incoming runtime edges produce typed producer/consumer
  candidates;
- selection reserves upstream and result-producing roles before ordinary
  downstream breadth;
- focused multiline statements inherit their enclosing control/effect signals;
- the CLI renderer, generated agent guidance, scip-query skill, and benchmark
  prompt explain the same causal roles;
- direct calls are deduplicated from callable references, and AST confirmation
  prevents TypeScript constants from being treated as callable targets.

The frozen TSLint treatment improved from 3/7 strict facts before causal
selection and 4/7 with incoming calls alone to 6/7 with callable references. It
used 148,002 total model tokens, 36.1% fewer than the 231,594-token native
control, while exceeding the control's 5/7 strict score. The frozen Vega
regression retained 7/7 and fell from 224,775 to 176,197 total tokens.

Full def-use and control-dependence edges are therefore not required to close
these two observed gaps. They remain a future extension for a held-out task
whose missing cause or consequence cannot be represented by calls, callable
references, or runtime-boundary edges.
