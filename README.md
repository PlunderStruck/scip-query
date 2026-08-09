# scip-query

scip-query is a compiler-backed repository-understanding system for coding
agents.

A repository-understanding system turns indexed code facts into accurate,
navigable abstractions of the systems in a codebase. Its essential service is
structure-preserving compression: an agent can see the relevant regions and
relationships before an edit, drill into several material regions together,
and keep exact source identities for its plan without reading every
implementation. scip-query differs from text search because it uses
compiler-produced SCIP indexes: two matching words count as the same symbol
only when the language tooling resolves them to the same definition. It also
reports coverage gaps, so omitted evidence is not mistaken for evidence that a
relationship does not exist.

The tool helps an agent answer four practical questions:

- What is this code connected to?
- Which systems participate in this behavior from entry to final effect?
- Who consumes it, and what could a change affect?
- Does the repository declare a structural rule for this dependency?
- Where do React, Vue, duplication, drift, complexity, or cleanup detectors
  point to code worth inspecting?

The agent still owns the task, plan, implementation, tests, and final judgment.
scip-query does not create goals, act as an acceptance test, or decide that work
is complete.

## Install

scip-query requires Node.js 22 or newer. Node.js 24 LTS is recommended.

```bash
npm install -g scip-query
cd your-repository
scip-query setup
```

Setup detects supported languages, installs or checks their indexers, builds
the local index, installs the bundled skills, and writes concise agent guidance.
When the repository declares valid architecture rules, setup also installs one
checkout-local Stop hook that checks those rules after indexed source changes.
It does not install a completion gate, pre-commit gate, or CI enforcement.

Check a setup with:

```bash
scip-query doctor
scip-query capabilities
```

## The normal workflow

Use scip-query as the primary reading surface for indexed source. First name the
few material repository facts the answer depends on. Locate exact referents with
`search` for trustworthy text, `outline` for a known file, or `entrypoints` for
an external callable surface. Then select exact symbols or file/line constructs
and project only the relationship families and directions capable of establishing
those facts. scip-query resolves identity, typed edges, evidence strength, provider
support, and bounded coverage; it does not decide which facts matter to the task.

```bash
scip-query search 'work_session_stream_events'
scip-query evidence \
  --symbol 'appendWorkSessionStreamEvents' \
  --edge execution \
  --edge runtime \
  --direction both \
  --depth 2 \
  --max-edges 32
```

Treat the evidence inventory, facts, calibration, coverage, and recovery paths as
one contract. Missing output is not evidence of absence. If a material fact still
requires implementation behavior, batch its exact constructs into `inspect --view
behavior`. Use `code` only when exact syntax can change the decision. Do not reread
source already rendered by either command, and do not expand unrelated frontiers.

Before answering, audit the draft itself against the material claims. A fact
seen in evidence but left implicit in the answer is not recovered. Copy returned
file and line identities exactly rather than reconstructing citation paths.

A broad literal is counted exactly and returned with recoverable structural scopes.
Narrow only when a named material fact requires one of those scopes.

`code` accepts up to 24 exact symbols, ranges, or indexed file paths. A file
path returns its exported definitions—or its top-level definitions when the
language has no explicit export surface—plus the file-local definitions they
reference, then lists every omitted local definition as an exact range. This
keeps the default source surface small without hiding what remains available.
Use `--members all` only when the complete file matters. If a proposed packet
would exceed the active output budget, `code` emits no partial source and
prints exact complete-packet splits; narrow to the exact units still needed
before deciding whether every split remains necessary.

Start an unknown path with `search`; batch related text, symbol, and file-line
anchors with `inspect`; use `evidence` when one symbol and its real uses are the
center of the question. For tracked nonbinary repository content, keep
exploration on scip-query. Native tools are for applying edits, running checks,
binary content, or a specific unsupported gap that scip-query has explicitly
reported.

```bash
scip-query search work_session_stream_events
scip-query inspect --search sessionStreamEvents --search work_session_stream_events --view behavior
scip-query evidence appendWorkSessionStreamEvents --include definition,references,callers,callees
```

`inspect --view behavior` returns the cheapest faithful syntax-derived view of
each complete source unit. Compact units stay raw. Larger units become
hierarchical outlines only when that representation is materially smaller;
every source statement is represented, and unsupported or
compression-sensitive statements are copied verbatim. Coverage reports the
represented, copied, and omitted counts. Exact source can be requested for any
unit whose complete implementation matters. `inspect --symbol` includes definitions,
references, callers, callees, dependencies, and consumers by default.

Search, location, and relationship evidence is deduplicated into one ranked
packet. Exact locations and definitions rank first; later units must add new
file, role, scope, symbol, or behavior coverage. A default packet materializes
at most 12 matching lines per text selector, then applies a soft ceiling of 48
units or 60,000 displayed-evidence characters without clipping a returned
syntax unit. Its omission ledger groups everything withheld by scope and role,
reports what each group contains, and gives an exact command for drilling into
that group. Drill into several relevant groups together; use `--full` only when
all omitted evidence can change the decision. Large rendered output from other
commands can still use the universal byte-transport continuation printed by
every command.

Before a nonlocal change:

```bash
scip-query context RetryPolicy
```

`context` returns a bounded evidence packet for a symbol, file, or module. It
combines definitions, references, calls, data flow, dependencies, consumers,
change risk, history, suppressions, and possible reuse sites. A bounded packet
is a deliberately limited result: it is useful for a decision but does not
claim to contain every possible relationship.

After a coherent edit:

```bash
scip-query diff-impact
```

`diff-impact` maps changed symbols to downstream consumers. It is a change map,
not a pass/fail gate. The agent uses it with native tests and source inspection.

When structure matters:

```bash
scip-query architecture
```

An architecture rule is repository policy that permits or forbids dependency
edges between named file groups. Its defining trait is that it states a team
constraint, not a detector guess. Rules live in `.scipquery.json` and can cover
closed dependency rows, cycles, unresolved boundaries, fan-out, boundary size,
and test placement.

When cleanup or drift matters:

```bash
scip-query health --full
```

Health is a collection of repository analyses, not a correctness grade. It
reports graph facts and heuristic candidates separately. A heuristic candidate
is a source location selected by a pattern that may indicate a problem; the
agent must read the source before treating it as a defect.

## React and Vue

React and Vue analysis remains a first-class part of the product.

```bash
scip-query react-component-duplicates --full
scip-query react-hook-candidates --full
scip-query react-large-component-pressure --full

scip-query vue-component-duplicates --full
scip-query vue-composable-candidates --full
scip-query vue-large-view-pressure --full
```

These commands find repeated component structure, hook or composable behavior
that may deserve reuse, and files carrying unusually broad responsibility.
They tell an agent where to inspect and clean up. They do not order an automatic
refactor: intentional variation and real framework constraints must survive.

Vue repositories can add source facts when their indexer needs them:

```bash
scip-query augment-vue
```

## Cleanup and drift commands

The health report is an overview. Focused commands expose the evidence behind
particular kinds of pressure:

```bash
scip-query duplicate-bodies --full
scip-query twin-drift --full
scip-query recent-duplicates --full
scip-query incomplete-migration --full
scip-query doc-drift --full
scip-query unused-params --full
scip-query dead --full
scip-query isolated --full
scip-query cycles --full
scip-query co-change --full
```

`incomplete-migration` looks for a new helper used at some matching sites while
older inline forms remain. `twin-drift` looks for same-concept implementations
that have diverged. `co-change` uses Git history to find files that repeatedly
change together without a visible dependency edge. Each is evidence for
inspection, not proof that code must be rewritten.

For compiler-checked dead-code removal:

```bash
scip-query cleanup-plan --verify
```

Review its batches before applying them. Cleanup is complete only when the
retired path, unused wiring, and misleading residue are gone and native checks
still pass.

## Focused graph queries

Use the aggregate `context` command first for ordinary planning. Reach for a
focused query when one unresolved relationship can change the decision:

```bash
scip-query refs SomeSymbol --full
scip-query trace SomeSymbol
scip-query call-graph SomeSymbol
scip-query value-flow SomeSymbol
scip-query affected SomeSymbol --full
scip-query system src/payments
scip-query surface src/payments
scip-query deps src/payments/service.ts
scip-query rdeps src/payments/service.ts
```

Do not repeat an unchanged query after context compaction. Re-run when source,
the index generation, the command input, or the required coverage changed.

## Suppressions

A suppression is a versioned repository record that says one detector finding
is accepted or is not actionable for a stated reason. Its defining trait is
that it addresses one finding without weakening unrelated analysis.

```bash
scip-query suppress SQ123 \
  --check twin-drift \
  --file src/example.ts \
  --reason-code intentional-variation \
  --reason "The two implementations follow different external contracts."
```

Commit relevant `.scipquery/suppressions/*.json` files with the code or policy
that justifies them. Suppressions are merge-friendly because each finding uses
its own file.

## Output and coverage

Human output is the default because it keeps hierarchy, whitespace, and source
line numbers readable. Programmatic consumers can use:

```bash
scip-query context RetryPolicy --json --result-only
```

Search output separates a complete occurrence ledger from source
materialization. Every exact matching path and line is listed with its owner;
the default expands only a representative source subset. Use the emitted
batched drilldowns for selected owners. `search --full` expands every source
window and is not needed to establish complete text-match coverage.

Cross-command evidence citations are off by default. With an explicit
`SCIP_QUERY_SESSION`, a complete source unit, a byte-identical exact subset of a
prior exact source read, or a graph unit/edge may be replaced by a visible
receipt from the same index generation. Preview coverage never suppresses an
exact unit. Changed bytes, changed graph content, a new generation, or
`--reemit` force full evidence.

If output prints `Continue exactly:`, run the emitted command unchanged until
transport is complete. Transport completion means every rendered character was
retrieved; it does not make bounded analysis exhaustive.

Use `--full` only when complete command coverage can change a decision. Always
read a command's coverage note before claiming that every caller, consumer, or
finding was considered.

## Configuration

Project policy lives in `.scipquery.json`. Common sections configure source
paths, generated or vendor exclusions, documentation snapshots, architecture
boundaries, declared coupling, coverage contracts, and watcher behavior.

Validate it with:

```bash
scip-query config-validate
```

Keep configuration small. Add a rule only when an observed repository fact or
team policy requires it.

## Command reference

The generated syntax catalog is in
[`docs/COMMAND_REFERENCE.md`](docs/COMMAND_REFERENCE.md). The one bundled
`scip-query` skill teaches mapping, ordinary planning, architecture checks,
and focused use of the React, Vue, and general cleanup detectors.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

The React and Vue detector suites are part of the normal test surface and must
remain passing when the workflow or command surface changes.
