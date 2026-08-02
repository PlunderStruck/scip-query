# scip-query

scip-query is a compiler-backed repository map for coding agents.

A repository map is a code-reading tool that identifies program elements and
the relationships between them. scip-query differs from text search because it
uses compiler-produced SCIP indexes: two matching words count as the same
symbol only when the language tooling resolves them to the same definition.

The tool helps an agent answer four practical questions:

- What is this code connected to?
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
It does not install Stop hooks, pre-commit gates, or CI enforcement.

Check a setup with:

```bash
scip-query doctor
scip-query status --capabilities
```

## The normal workflow

Use native search and file reads for literal source. Use scip-query where
compiler identity or repository relationships can change the answer.

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
scip-query dataflow SomeSymbol
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
