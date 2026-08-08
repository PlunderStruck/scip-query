# Direct graph navigation

## Decision

scip-query will make direct, agent-controlled graph traversal the primary
exploration workflow. Anchor discovery remains an optional bootstrap for a
question that supplies no concrete referent; it is not a required planning
stage and does not decide which subsystem is relevant.

A concrete referent is an indexed code construct, exact repository literal,
file/line location, entry point, or runtime key that identifies something the
agent can inspect or traverse without another relevance inference. A graph edge
is a recorded relationship between two such referents. The edge kind states
what that relationship proves; it must not be converted into a stronger claim.

The agent owns relevance: it names the fact still needed and chooses the
relationship kinds capable of establishing it. scip-query owns identity,
traversal, bounded composition, and coverage: it resolves the selected
referents through the index, follows the requested edge kinds, renders one
compact packet, and explicitly accounts for anything it withholds.

## Primary workflow

```text
1. Locate
   Find one or more exact symbols, literals, files, entry points, or runtime keys.

2. Traverse
   Request the edge families needed for the unanswered fact around those exact
   identities. Batch independent identities into the same request.

3. Read
   Inspect compact behavior, then exact source only when graph evidence cannot
   establish a material implementation detail.
```

The normal interface should converge on:

```bash
scip-query evidence \
  --symbol '<exact-symbol-id>' \
  --symbol '<second-symbol-id>' \
  --edge execution,runtime,dataflow,state,temporal,contract,ownership,dependencies \
  --depth 2
```

Selectors are repeatable and use the same names across exploration commands:
`--symbol`, `--file`, `--at`, and `--search`. Positional compatibility may be
retained, but all generated commands and documentation use the common form.

## Edge semantics

Execution edges—direct calls, callbacks, dispatches, and exact runtime
handoffs—establish that execution can move between constructs. Data edges
establish movement or transformation of values. State edges establish reads,
writes, and durable effects. Temporal edges establish ordering or lifecycle.
Contract edges establish conditions, results, errors, and bounds. Identity and
ownership edges establish which construct or subsystem a behavior belongs to.
Dependency edges establish build-time or module reliance.

Execution and exact runtime edges may form an executable route. The remaining
edge families characterize that route; they do not become call claims merely
because they connect the same constructs.

## Views

The unified traversal surface provides small explicit presets without inferring
task intent:

- `causal`: execution, runtime, data, state, and temporal evidence.
- `structure`: ownership, identity, dependency, and contract evidence.
- `complete`: both sets, within the same declared output and depth bounds.

Explicit `--edge` values override a preset. Each result reports the applied
edge families, depth, selector cardinality, evidence strength, coverage state,
and recoverable omissions.

## Discoverability contract

`status --capabilities` must include a compact navigation recipe with exact
syntax. Locator and outline results must print ready-to-run commands using the
exact identities they returned. A result recommends the cheapest next command
for each available relationship; it does not recommend expansion merely because
more graph data exists.

Generated commands must be directly executable, use common selector syntax,
and preserve repeated selectors. The agent should never need general `--help`
to continue from a successful query.

## Output and stopping contract

The first traversal response is a compact relationship manifest and behavior
skeleton, not a collection of full source bodies. It retains predicates, exact
values, branch outcomes, runtime keys, state effects, and result shapes when
they can change the answer. Repeated or shared evidence is represented once.

Every withheld relationship is either:

- represented by a stable expansion identity and exact command;
- folded behind a counted omission group;
- explicitly excluded by the requested edge set; or
- reported unsupported by the current index.

The agent stops when its named material facts are established. It performs one
batched inspect only for facts that require implementation behavior, and uses
`code` only when exact syntax can change the conclusion. A benchmark-side query
and output budget prevents direct navigation from degenerating into many
accumulating full-source reads.

## Retained mechanisms

- All existing compiler, runtime, data-flow, state, temporal, contract,
  identity, ownership, and dependency edge extractors.
- Exact source search and compiler identities.
- Runtime-boundary resolution.
- Compact behavior rendering and exact-source fallback.
- Coverage manifests, omission ledgers, session receipts, and batching.
- Route catalogues as an optional endpoint-to-symbol view.

## Demoted mechanisms

- Mandatory anchor discovery.
- Mandatory anchor-group selection.
- Mandatory first `system-map` operation.
- Automatic materialization of every route or causal frontier.
- Repository-specific ranking rules presented as relevance decisions.

## Acceptance criteria

1. An agent can begin from any exact returned referent without running
   `anchors`.
2. One evidence request can batch multiple symbols and request every supported
   edge family or one named preset.
3. All generated follow-up commands use a common executable selector contract.
4. The compact capability output is sufficient to use the workflow without
   general command help.
5. Unknown, unsupported, bounded, and complete relationship coverage remain
   distinguishable.
6. Existing command invocations remain compatible unless a separate breaking
   release explicitly removes them.
7. On frozen held-out benchmarks, direct traversal reaches accuracy parity
   without exceeding the matched native model-token baseline. A single run is
   diagnostic; promotion requires repeated tasks and repositories.

## Implementation sequence

1. Inventory the existing evidence/topology edge vocabulary and selector
   contracts; reuse it rather than introducing parallel graph representations.
2. Add common batched selectors and explicit views to `evidence` while
   preserving its positional form.
3. Compose existing topology edge families into the evidence packet with
   coverage and stable recovery commands.
4. Add the compact navigation recipe to capabilities and exact next commands to
   locator/outline output.
5. Replace mandatory-anchor guidance with the locate/traverse/read contract.
6. Add neutral fixtures covering multiple roots and every edge family, then run
   frozen direct-navigation benchmarks against anchor-driven and native arms.

## Implemented result

The first complete slice now projects the existing universal topology through a
single `graphEvidence` query rather than building a parallel graph. The public
`evidence` command accepts repeated `--symbol`, `--at`, and `--search` roots;
provides `causal`, `structure`, and `complete` views plus explicit `--edge`
families; and preserves the legacy positional source-evidence invocation.

The packet ranks relationships by graph distance from the exact roots, concrete
code ownership, and evidence strength, then samples across requested families.
It reports the eligible, returned, and omitted edge counts, unsupported
frontiers, and blind spots. Follow-up commands are emitted only for compiler
symbols, source constructs, and runtime participants with executable exact
selectors. The capability report, outline output, generated repository guidance,
`scip-query` skill, and `scip-explore` skill now teach the same locate → traverse
→ read workflow; anchors and `system-map` remain optional.

Validation passed the focused graph, setup, prompt, and CLI-contract tests,
TypeScript type checking, production build, and live legacy/new CLI smoke tests.
The full suite passed 2,328 of 2,331 tests in one shared run; the three remaining
five-second `code-cli-contract` timeouts all passed when that 19-test file was
rerun alone.

## Frozen Luna-max result

The matched OpenCode compaction benchmark used commit
`1a8e94dc8e7462d3d0d860e1337b448c71947f6b`, Luna 5.6 max, independent detached
worktrees, the same frozen seven facts, and automatic sandbox/cache cleanup.

| Arm | Total tokens | Uncached input | Rendered characters | Calls | Duration | Strict facts |
| --- | -----------: | -------------: | ------------------: | ----: | -------: | -----------: |
| Direct scip-query | 1,879,901 | 111,678 | 177,446 | 23 | 713.1 s | 0/7 |
| Native control | 3,306,711 | 222,426 | 1,275,575 | 63 | 467.0 s | 0/7 |

The treatment reduced total tokens by 43.1%, uncached input by 49.8%, rendered
repository characters by 86.1%, and calls by 63.5%, but took 52.7% longer. This
proves a substantial matched efficiency advantage for this run, not promotion:
both arms missed at least one qualifier in every compound frozen fact. Treatment
recovered most internal behavior but did not establish either complete external
ownership chain and exceeded the four-query/70,000-character budgets. The next
accuracy work should improve evidence for externally reachable ownership and
make material-claim coverage visible; it should not reintroduce mandatory anchor
selection or repository-specific relevance inference.

Artifacts:

- `/tmp/opencode-compaction-implementations-treatment-direct-luna-max-v26.json`
- `/tmp/opencode-compaction-implementations-control-luna-max-v26.json`
