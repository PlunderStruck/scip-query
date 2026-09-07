# Choosing a scip-query command

Use this reference when the workflow names a question but you need to choose its command. Read the relevant section, then run `scip-query <command> --help` for flags. Do not run every row. This guide covers all 81 public commands; the five internal controls are explained separately.

An index is a saved database of code declarations and references produced by language tools. The **Index** column describes the current CLI prerequisite, not whether the answer is read from old source bytes. **Yes** requires a prepared index; additional language parsers or compiler services may still be needed. **No** requires no saved index; other requirements are stated in the row. **Mode** depends on the selected operation.

Current limitation: `files`, `search`, `code`, and `inspect` read current text but still pass through index preparation. Do not promise those commands work in a never-indexed checkout. `system --source`, source `health`, and `review` do. Their current-source analysis scans eligible files on each invocation; the incremental index watcher is a separate mechanism.

`<value>` is required; `[value]` is optional. Prefix the commands below with `scip-query`. Use exact identities returned by the tool, and preserve quoted paths. Every result is limited by its stated coverage. A candidate is a location worth investigating because it matches a disclosed pattern; it is not an instruction to change that code.

## Orientation and change review

Source `health` shows separate finding categories; `--limit` bounds each category so duplication cannot crowd out complexity. Unmatched suppression decisions are summarized after findings; `--full` retains their identities and reasons. Use `system --source <path-or-group>` for module files, dependencies and consumers. Indexed health has no overall grade. Its combined pair weight is the sum of existing detector weights; the raw pair count remains separate.

Use these for first-use assessment, planning around existing code, and checking an actual diff. Load `$scip-plan` for implementation order and preserved behavior.

| Command | Use when / why this control | Index | Interpretation and limits |
| --- | --- | --- | --- |
| `system [module]` | Inventory module groups, or examine the files, exports, imports, consumers and findings around one group. Start with `system --source`; select an exact path or printed group ID. | Mode | Source mode needs no index and covers eligible TS/JS. Bare indexed mode requires a module selector. Directories are provisional groups; exports are not complete interface contracts. |
| `health` | Find current TS/JS complexity, duplication and dependency findings on first use. Choose `--indexed` for the specialist framework, drift and cleanup report. | Mode | Default source mode needs no index. `--baseline` compares saved indexed finding identities; `--write-baseline` writes them. Both require an index and reject source-only options. No mode establishes overall design quality or runs every integrity detector. |
| `review` | Compare current TS/JS changes, including new/untracked functions, against `--base HEAD` or another commit. Use before committing. | No | Requires Git. Scope filters output while peer analysis remains broader. Read uncomparable functions manually. CRAP needs source-matched test coverage; missing coverage is unavailable. |
| `context <target>` | Gather indexed reuse and impact candidates around an already identified symbol, file or module before choosing an implementation owner. | Yes | A briefing of candidates; matching names and nearby code do not establish the live owner. Use source and consumers to decide. |
| `change-surface <file>` | Plan a change to one file: see its consumers, published interface, operational roots and explained risk. | Yes | Broader pre-change context than a reverse-import list. Risk signals do not predict which consumers will break. |
| `affected <symbol>` | Before editing a particular symbol, follow its reverse caller/reference relationships to possible consumers. | Yes | A conservative set of potentially affected symbols. It does not predict actual failures or cover unknown runtime connections. |
| `diff-impact` | After editing, map the actual Git diff to changed symbols and downstream consumers. Select the same `--base` used for review. | Yes | Complements source review with symbol relationships. Check unindexed paths and each evidence tier; a source fallback is not complete compiler-reference coverage. |

## Exploration

Load `$scip-explore` for following live behavior. Choose an exact root, select the relationship needed, and read source only for the remaining question.

| Command | Use when / why this control | Index | Interpretation and limits |
| --- | --- | --- | --- |
| `files <pattern>` | The missing fact is a file path rather than a text occurrence. Match current project paths. | Yes | Current CLI prerequisite despite source-based file discovery. File membership does not establish compiler coverage. |
| `search <exact-text>` | Locate a literal or deliberately bounded `--regexp`, optionally within `--scope`. | Yes | Counts current text; compiler ownership is an aligned overlay. Preview ordering is not task relevance. Insert `--` before a literal beginning with a dash. |
| `outline <file>` | See indexed symbols and nesting in one known file before selecting a definition. | Yes | Compiler-owned structure, not evidence that a function runs. |
| `code <selectors...>` | Read exact definitions, file:line ranges, or file surfaces. Batch known selectors. | Yes | Text is current. File mode defaults to exported members; `--members all` requests the complete file. Source alone does not establish consumers. |
| `inspect` | Read several related implementation gaps together using repeated `--symbol`, `--at`, or `--search`; use `--view behavior` when behavior is the gap. | Yes | Deduplicated source and relationship context with explicit bounds. A preview cannot establish what every invocation passes. |
| `entrypoints [text]` | Find detected external roots or entry-surface candidates when the initiating implementation is unknown. | Yes | Visibility and few callers do not prove runtime ingress. Confirm registration and live consumers. |
| `entry-map <entry>` | View the indexed call structure from one detected entry, grouped by file. | Yes | Useful for the broad static path; does not prove runtime execution or capture every framework handoff. |
| `methods <className>` | Enumerate methods of one exact class rather than all constructs in its file. | Yes | Ambiguous/missing class selectors fail. Methods being present does not establish invocation. |
| `members <symbol>` | Enumerate children of a known symbol, including fields and nested types. | Yes | Broader than methods; structural containment does not establish responsibility or lifetime. |
| `hierarchy <symbol>` | Walk upward from a symbol to its indexed lexical containers. | Yes | Containers are code structure; runtime sharing and business ownership require separate evidence. |
| `by-kind <kind>` | Locate constructs by SCIP kind, such as classes or interfaces. | Yes | Kind is a compiler classification, not an architectural role. |
| `kind-counts` | Get a histogram of indexed construct kinds when composition is the question. | Yes | Index inventory counts; neither a repository quality measure nor a code-behavior review. |
| `refs <symbol>` | Locate references to one exact declaration, including non-call uses. | Yes | Distinguish compiler-bound references from candidates. References are broader than calls; limits and unsupported consumers prevent absence claims. |
| `call-graph <symbol>` | Follow incoming/outgoing static call relationships around one symbol. | Yes | Read exact/candidate labels and blind spots. A possible call is not an observed execution. |
| `evidence` | Project explicitly chosen execution, dataflow, runtime, state, temporal, contract, identity, ownership or dependency relationships. | Yes | Supply roots, `--edge`, direction, depth and edge bound. Only supported relationships are established; data/state edges do not become calls. |
| `dependence-slice <file:line>` | Trace a particular variable occurrence backward to its local prerequisites, or forward with `--forward`. Use `--variable`/`--column` to disambiguate. | Yes | Function-local value and control relationships. Does not prove whole-program flow, safe extraction, or heap identity across calls. |
| `session` | Check which evidence has already been delivered in an explicit `SCIP_QUERY_SESSION`; `--reset` clears that ledger. | Yes | The current handler opens the index. Delivered evidence is not a measure of task completion; no explicit session means the ledger is unavailable. |

## Architecture and dependencies

Load `$scip-architecture-review` to connect these observations to maintenance consequences. Review implementations and consumers before assigning responsibility or changing boundaries.

| Command | Use when / why this control | Index | Interpretation and limits |
| --- | --- | --- | --- |
| `deps <file>` | List the internal files one file relies on. | Yes | File-level dependency view; use imports for imported symbol detail. Static reliance is not execution. |
| `rdeps <file>` | Find files depending on one file/module. | Yes | File consumers, not complete symbol invocations. Use affected for broader symbol impact. |
| `imports <file>` | Inspect the imported symbols used to connect a file to other implementations. | Yes | An import does not prove invocation. Dynamic/runtime registration may need separate evidence. |
| `imported-by <symbol>` | Identify files importing one symbol. | Yes | Narrower than refs: non-import uses are not this command's question. |
| `surface <module>` | Find indexed symbols with observed consumers outside the selected module. | Yes | Shows observed use, not every exported declaration or all consumers outside this repository. |
| `architecture` | Check declared file boundaries, allowed dependency directions and configured structural constraints. | Yes | Requires meaningful project rules. Read unmapped files and missing policy rows; compliance does not establish sound design. |
| `cycles` | Find cyclic file-dependency groups and a witness path through each. | Yes | All participating components are the unit of coverage, not every possible cycle path. A grouped-module cycle may differ from a file cycle. |
| `dependency-depth` | Examine long dependency paths after cyclic files are treated as one group. | Yes | Depth describes graph structure; it does not prescribe implementation order or measure runtime cost. |
| `coupling [file1] [file2]` | Compare two files, or rank file pairs, by shared-symbol relationships. | Yes | Shared symbols indicate structural connection, not a common business responsibility. |
| `co-change [file]` | Investigate files that repeatedly change together without a recorded dependency. | Yes | Also needs Git history. Co-change suggests hidden coordination; repository-wide edits and history gaps can mislead. |
| `hotspots` | Locate highly referenced symbols when choosing where to investigate broad impact. | Yes | Ranks referencing chunks or disclosed incoming evidence rows. Counts are not runtime frequency or architectural importance. |
| `fan-in [symbol]` | Count distinct referencing files for one symbol, or rank symbols by that count. | Yes | Different unit from hotspots; many consumers can indicate useful reuse. |
| `fan-out [file]` | Count external symbols used by one file, or rank files by that count. | Yes | Here external means outside the file. Counts do not establish excessive responsibilities. |
| `bottlenecks` | Locate potential coordination hubs using incoming files and outgoing cross-file callable targets. | Yes | Structural product, not measured runtime contention, throughput or failure risk. |
| `locality-candidates [symbol-or-file]` | Investigate placement when consumers cluster under a directory or ancestor. | Yes | Directory proximity suggests a question; it does not identify the correct conceptual owner. |
| `drift [module]` | Obtain a module-oriented shortlist of unused imports and architecture violations; add `--architecture` for policy context. | Yes | `--patterns` additionally reports unusual sibling dependencies and has weaker precision. Different dependencies can be intentional. |

## Simplification and cleanup

These are optional investigations within architecture/maintainability review. Begin with source health/review when their findings answer the question. Test the strongest reason the existing code might be necessary.

| Command | Use when / why this control | Index | Interpretation and limits |
| --- | --- | --- | --- |
| `complexity <symbol>` | Inspect one indexed symbol's branch/cyclomatic estimate alongside fan-in/out and callees. | Yes | For before/after source cognitive complexity and CRAP, use review. Metric definitions differ; do not treat every complexity value as interchangeable. |
| `slice-cohesion [symbol]` | Investigate a function whose outputs may depend on separate sets of statements. | Yes | Local backward-slice candidates for separation. Shared state, effects, control, exceptions and lifecycle may require keeping the code together. |
| `passthrough-candidates` | Locate wrappers that mostly forward to one callee. | Yes | Adapters can enforce a contract or isolate change; forwarding alone does not justify deletion. |
| `similar [symbol] [other]` | Find or compare functions with similar callee fingerprints. | Yes | Similar callees do not prove equivalent behavior; inspect inputs, effects and consumers. |
| `similar-files [file]` | Find files with similar dependency profiles. | Yes | Structural neighbors, not proven duplicate implementations. |
| `recent-duplicates` | Look for duplication candidates associated with recently added files. | Yes | Uses Git file age; it does not know when each function was created. |
| `duplicate-bodies` | Locate exact small-body duplication candidates across files. | Yes | Matching bodies can operate under different contracts or state; source health supplies a different whole-function token comparison. |
| `similar-signatures` | Locate functions with similar normalized signature text as a lead for shared concepts. | Yes | Text resemblance does not prove identical resolved types, responsibilities or behavior. |
| `dead [scope]` | Distinguish repository-dead candidates, file-internal-only symbols and implicit-usage signals. | Yes | Examine the category and semantic coverage. External consumers, framework calls or incomplete indexing can invalidate a deletion. |
| `unused-imports <file>` | Inspect imports with no observed same-file references. | Yes | Confirm side effects, generated/framework uses and supported syntax before removal. |
| `unused-params` | Find trailing parameters whose bodies do not use them. | Yes | Public interfaces, callbacks, overrides and future-compatible contracts may still require them. |
| `redundant-reexports` | Investigate re-exports without resolved local source import/re-export consumers. | Yes | External package consumers remain unknown. A barrel can be a deliberate public interface. |
| `cleanup-plan` | Order unused-code deletion candidates and the further candidates their removal may expose. | Yes | `--verify` executes a project checker in an isolated HEAD snapshot; `--patch` prints that checked patch. Neither proves runtime behavior or validates uncommitted source as HEAD. |
| `doc-drift [doc]` | Find documentation whose referenced or historically co-changing code changed later. | Yes | Also needs Git history. Age is a lead, not proof that the documentation is wrong. |

## Framework investigations

Use the relevant framework rows after a concrete React/Vue concern, or after `health --indexed` points to one. Do not run both framework families on unrelated code. These reports require an index and their supported parser/compiler providers.

| Command | Use when / why this control | Index | Interpretation and limits |
| --- | --- | --- | --- |
| `react-component-duplicates [file]` | Compare repeated JSX structure, props, events and bindings. | Yes | Similar component structure can conceal different behavior and ownership. |
| `react-hook-candidates [file]` | Investigate repeated state, effects, requests and handlers for a possible shared hook. | Yes | Preserve hook ordering, state lifetime, dependencies and cleanup. Shared syntax does not prove a valid hook contract. |
| `react-large-component-pressure [file]` | Find components with concentrated source, JSX and hook behavior. | Yes | Size and counts locate review candidates; they do not prove the component should split. |
| `vue-component-duplicates [file]` | Compare repeated template tags, bindings, slots and directives. | Yes | Verify script behavior and consumers; template resemblance is insufficient for consolidation. |
| `vue-composable-candidates [file]` | Investigate repeated state, effects, requests and template bindings for a possible shared composable. | Yes | A composable is a reusable function that organizes Vue reactive behavior. Preserve state ownership, subscriptions and cleanup. |
| `vue-large-view-pressure [file]` | Locate concentrated template/script/style behavior, including external script lines. | Yes | A large view may own one coherent operation; counts alone do not establish multiple responsibilities. |

## Implementation integrity

Load `$scip-integrity-audit` when the question is whether a feature fulfills its promise. Each detector below supplies candidates; verify live routing and independently expected behavior through a real consumer.

| Command | Use when / why this control | Index | Interpretation and limits |
| --- | --- | --- | --- |
| `not-implemented` | Look for consumed or externally exposed placeholders: throw-stubs, TODO/default returns or empty bodies. | Yes | A legitimate no-op, abstract contract or deliberate unsupported operation may match. A clean scan does not establish feature completeness. |
| `decorative-checkers` | Investigate checker-named functions lacking detected explicit failure syntax. | Yes | Delegated checks, implicit exceptions and property effects may still reject bad input. Test both valid and invalid cases. |
| `test-quality` | Find assertion-free tests, skipped tests with history, and tests asserting the same literal supplied by their mocks. | Yes | These patterns do not prove a test is useless; execution, delegated assertions and the tested contract matter. |
| `incomplete-migration` | After extraction, find new helpers used at some sites while similar old sites remain. Choose `--base` deliberately. | Yes | Also needs Git. Similar call patterns are candidates; distinct contracts or a staged migration can explain coexistence. |
| `twin-drift` | Compare same/near-name functions across files whose bodies have diverged. | Yes | Names and divergence do not establish that implementations should agree. Compare their contracts and live consumers. |

## Tool operations

Load `$scip-setup` when the tool itself needs attention. Configuration and integration writes are actions; use them for an authorized setup, repair or accepted decision, not routine orientation. A configured watcher can be stopped, and `autoStart: false` prevents automatic startup.

| Command | Use when / why this control | Index | Interpretation and limits |
| --- | --- | --- | --- |
| `status` | Inspect freshness, the active index, watcher state and cache ownership. | No | Can report a missing index. Freshness does not prove every provider is available. |
| `doctor` | Diagnose a reported configuration, freshness, dependency or capability problem. | No | Follow the specific diagnosis; diagnostic success is not a behavioral code audit. |
| `capabilities` | Check whether a named claim has provider/language support; use `--matrix` for detail. | No | Describes tool support and limits. Do not run the matrix as a routine orientation step. |
| `stats` | Inspect index row counts, database size and modification time. | Yes | Inventory and storage measurements, not code quality or proof of freshness. |
| `check-deps` | Check whether scip-query and the detected language indexers are runnable. | No | An executable being present does not establish a successful project index. |
| `init` | Create a starter `.scipquery.json` when configuration is wanted. | No | Writes configuration; it does not evaluate or discover correct architectural responsibilities. |
| `config-validate` | Validate configuration and structured suppression/architecture/coupling records after editing them. | No | Valid syntax and consistency do not establish that the chosen policy is good. |
| `setup` | Bootstrap skills, agent guidance, parsers, indexing and readiness checks for a project. | No | Creates local/project state and needs suitable language tools. `--health` adds indexed specialists; plain source health is a separate operation. |
| `reindex` | Create or refresh the saved compiler index after a diagnosed need. | No | Needs the language indexers. Ordinary updates can use the running incremental service; `--allow-expensive-rebuild` explicitly permits a whole-project fallback. `--force` alone does not grant that permission. |
| `watch` | Inspect (`--status`), start (`--daemon`), stop or prune the project service; bare invocation watches in the foreground. | Mode | Status/control can work without an index. Successful incremental refresh needs a baseline, providers and applicable project configuration; an initial rebuild must be permitted. |
| `augment-sources` | Add source documents skipped by the upstream indexer after confirming that coverage gap. | Yes | Mutates index documents; adding source text does not manufacture compiler-resolved relationships. |
| `augment-vue` | Add compiler-resolved Vue references for a specific `--project` configuration. | Yes | Mutates the index and needs Vue tooling. Inspect unresolved/skipped reasons rather than interpreting omitted references as absent. |
| `install-skills` | Install or repair the six workflow links in user-level agent roots. | No | Writes package-owned links; `--all` has the same result. Existing user-owned replacements are preserved. |
| `setup-agent` | Write/update managed project guidance in AGENTS.md and CLAUDE.md. | No | Writes instructions; it does not by itself establish a fresh index or agent compliance. |
| `uninstall` | Remove selected package-owned global skill links or project guidance. | No | Start with `--dry-run` when choosing scope. `--global` and `--project` address different integrations; unrelated user files are retained. |
| `suppress <id>` | Record a reviewed finding that should be retained, with a reason, reason code and counterevidence. | No | Writes a decision; saving a graph claim does not itself verify that claim. Commit relevant suppression records. Replacing a decision requires its exact revision. |

## Internal controls

These five registered controls are not additional analysis choices. Run an emitted continuation unchanged; do not invent worker invocations.

| Control | Purpose |
| --- | --- |
| `continue <cursor>` | Required transport for a saved immutable output page. Drain every emitted `Continue exactly:` command before interpreting the complete result. |
| `hook-architecture-stop` | Checkout-local architecture Stop hook installed by setup when its conditions are met. |
| `__diff-impact-batch` | Private diff-impact worker protocol. |
| `__health-phase` | Private indexed-health phase worker protocol. |
| `__health-semantic-prewarm` | Private health provider-preparation protocol. |

## Choosing between similar controls

- **Map, policy or behavior:** system inventories groups; architecture checks declared rules; evidence/inspect establish selected relationships and behavior. None supplies an overall design grade.
- **Before versus after an edit:** context/change-surface/affected support planning; review and diff-impact evaluate the actual diff and answer different questions about it.
- **File, import, reference or call:** deps/rdeps connect files; imports/imported-by describe imports; refs includes non-call references; call-graph describes possible calls. Select the relationship needed for the claim.
- **Inventory versus observed interface:** system/outline show declarations; surface shows observed outside-module use. Neither proves a complete external package API.
- **Measurement versus equivalence:** complexity and connectivity counts locate pressure; similarity detectors use different comparisons. Matching counts, signatures or bodies do not establish safe replacement.
- **Slice versus split:** dependence-slice explains one variable occurrence; slice-cohesion suggests separated local computations. Both still require behavior and effect checks before extraction.
- **Candidate list versus deletion procedure:** dead classifies usage signals; cleanup-plan orders possible deletions and offers an isolated checker run. Neither authorizes deletion by itself.

Full flag documentation is in [the command reference](../../../docs/COMMAND_REFERENCE.md). When this guide and a runtime packet disagree, preserve the packet's limits and report the mismatch; do not strengthen the claim to fit the guide.
