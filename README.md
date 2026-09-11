# scip-query

For the normal **explore → plan → implement → review** workflow, use `scip-query system --source` for a module inventory, `scip-query health` for cleanup candidates, and `scip-query review --base HEAD` after edits. These inspect current TS/JS source without an index. See [agent workflows and module evidence](docs/SKILLS.md), [review and coverage](docs/REVIEW.md), and the [product vision](docs/PRODUCT_VISION.md).

scip-query helps coding agents inspect code relationships and review changes.
It uses compiler-produced symbol identities to distinguish definitions that happen
to share a name, then attaches source locations and coverage to the relationships
it reports.

The core workflow is to locate the code, inspect the relationships relevant to a
change, make the change, and check its consumers and declared architectural rules.
The tool supplies evidence; design decisions still require understanding the
project's responsibilities and verifying behavior with tests.

| Question | Evidence to use |
| --- | --- |
| Which definition does this reference mean? | Search, outline, references, exact source |
| What can call this, or be called by it? | Execution relationships |
| Where does a value come from? | Value transfers and function-local dependence slices |
| What state or external boundary does this operation touch? | State and runtime relationships, with provider limits |
| Which dependencies are permitted? | Explicit architecture rules |
| What might my edit affect? | Changed symbols and downstream consumers from diff-impact |
| Which code warrants review? | Individual health findings, exclusions, and analysis coverage |

Containment identifies where a symbol is declared. Domain ownership identifies
which module is responsible for enforcing a rule or controlling a resource;
containment alone cannot establish that responsibility. Neither a dependency count
nor a detector finding establishes architectural quality.

## Install

scip-query requires Node.js 22 or newer. Node.js 24 LTS is recommended.

```bash
npm install -g scip-query
cd your-repository
scip-query setup
```

npm 11 and newer skip dependency install scripts by default and print an
`install-scripts` warning listing them. For scip-query every listed script is
a prebuild check (`node-gyp-build`) or the package's own install hint; the
Tree-sitter grammars and SQLite binding ship prebuilt binaries for macOS,
Linux, and Windows, so nothing needs to compile and the warning can be
ignored. The one grammar without prebuilds, Kotlin, falls back to text
parsing unless a C toolchain is present and the scripts are allowed. To
silence the warning for global installs, run the `npm config set
allow-scripts=... --location=user` command npm prints; `--allow-scripts` is
rejected inside a project directory by design.

Setup detects supported languages, installs or checks their indexers, builds
the local index, installs the six agent workflows, and writes concise agent guidance.
When the repository declares valid architecture rules, setup also installs one
checkout-local Stop hook that checks those rules after indexed source changes.
It does not install a completion gate, pre-commit gate, or CI enforcement.

Check a setup with:

```bash
scip-query doctor
scip-query capabilities
```

## The normal workflow

Use ordinary file search and source reads for implementation details. Use
scip-query to inspect relationships, discover reuse opportunities, evaluate
module dependencies and review actual changes. For a substantial change, map
the existing central path and comparable features before choosing an extension
point; document what will be reused and which consumers are affected.

```bash
scip-query system --source
scip-query evidence --at src/service.ts:42 --edge execution --direction incoming --depth 1 --max-edges 30
```

The module inventory shows groups and dependencies; selecting a printed group
reveals its files, exports and import sites. The evidence command answers a
chosen relationship question. Use incoming/outgoing execution for callers and
callees, dataflow for values, runtime for handoffs and dependencies for imports.
Candidate edges require confirmation. Missing or bounded evidence cannot
establish absence. `evidence --detail` adds inventory and provider explanations
when their limitations matter.

`search`, `outline`, `entrypoints`, `code` and `inspect` remain optional tools
for compiler identity, nesting, external roots or grouped source reads. `code`
accepts exact symbols, file ranges or file paths; `--members all` selects a
complete file and `--local-calls` adds same-file callees of a selected range.
`inspect --view behavior` can provide a statement-accounted view of a selected
construct. Both source commands add external literal values only with
`--bindings`. Their machine results retain detailed evidence.

Load the relevant [workflow skill](docs/SKILLS.md), batch useful questions and
stop when the facts needed for the change are settled. There is no requirement
to exhaust the command catalogue, unrelated relationships or saved output.

Before a nonlocal change:

```bash
scip-query context RetryPolicy
```

`context` returns a bounded evidence packet for a symbol, file, or module. It
combines definitions, references, call neighborhoods, dependencies, consumers,
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

Choose a focused query when one unresolved relationship can change the decision:

```bash
scip-query refs SomeSymbol --full
scip-query call-graph SomeSymbol
scip-query evidence --symbol SomeSymbol --edge dataflow --direction both --depth 2 --max-edges 48
scip-query affected SomeSymbol --full
scip-query system src/payments
scip-query surface src/payments
scip-query deps src/payments/service.ts
scip-query rdeps src/payments/service.ts
```

Do not repeat an unchanged query after context compaction. Re-run when source,
the index generation, the command input, or the required coverage changed.

## Value flow and slicing

A value transfer connects a particular value-producing occurrence to an occurrence
that receives it. `evidence --edge dataflow` reports supported static transfer relationships,
including argument-to-parameter and consumed return-value relationships. Each
edge distinguishes confirmed evidence from candidates and reports provider limits.

A backward slice identifies the source occurrences that can affect a chosen
variable occurrence through assignments, value use, or conditions governing
execution. A forward slice follows those dependencies toward affected occurrences.
`dependence-slice` computes these within one TypeScript or JavaScript callable:

```bash
scip-query dependence-slice src/payments/service.ts:42 --variable total
scip-query dependence-slice src/payments/service.ts:42 --variable total --column 10
scip-query dependence-slice src/payments/service.ts:12 --variable amount --forward
```

Lines and columns in command arguments are one-based. Ambiguous occurrences are
listed for refinement. The default traverses the local graph to completion;
`--depth` limits hops and `--max-edges` bounds rendered edges. Coverage distinguishes
output bounds from an incomplete analysis. Calls into other functions, general heap
aliasing (different references to the same stored object), closure invocation order,
and unsupported exception behavior require separate evidence. This is a dependency
slice, not a proof that extracting its statements into a function preserves behavior.

`slice-cohesion` compares slices for a function's different outputs to suggest
possible separations. Its suggestions require source confirmation and tests; partial
models cannot earn an extraction signal. Health reports retain the individual
findings and coverage without aggregate quality grades.

## Optional skills

Setup and `install-skills` install `scip-query` and `scip-explore` by default.
Use `scip-query install-skills --all` to install the shipped specialist workflows.
Existing specialist installations and user-owned skill directories are preserved.

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

Search displays selected matching windows once, with exact locations, optional
compiler owners and an honest total. Use `--scope` to narrow or `--full` to
expand all matching windows. The JSON result retains identity metadata.

Oversized ordinary human output is saved to a private temporary file, with a
short preview and absolute path. Read or filter the file selectively using
normal tools; no automatic `continue` call is required. Saved previews expire
after one hour or can be reclaimed earlier under storage pressure. Redirect
stdout to your own file for durable output:

```bash
scip-query health --full > report.txt
scip-query health --json --json-output report.json
```

Small results, regular-file redirects and machine JSON contracts are preserved.
Explicit pagination remains a compatibility option. Cross-command evidence
receipts remain opt-in through `SCIP_QUERY_SESSION`; `--reemit` forces full
evidence. Material omissions and unsupported/stale evidence remain visible,
without routine successful coverage footers. See [output modes](docs/CLI_JSON_OUTPUT.md).

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
npm run build
npm test
```

The React and Vue detector suites are part of the normal test surface and must
remain passing when the workflow or command surface changes.
