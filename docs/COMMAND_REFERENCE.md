# Command reference

This syntax catalog is generated from the CLI command descriptors. Locate an
exact root with `search`, `outline`, or `entrypoints`; project explicitly chosen
relationships with `evidence`; then read behavior or source only for a named
remaining gap. Compatibility views are listed but are not part of that canonical
workflow.

<!-- BEGIN GENERATED COMMAND REFERENCE -->

This syntax summary is generated from the CLI command descriptors. Keep workflow guidance hand-authored, but keep command syntax, descriptions, and option flags descriptor-owned.

Commands with `--json` share three structured modes: plain `--json` emits the stable public envelope, `--json --result-only` emits only the command payload, and `--json --compact` minifies either form for a program. Agents should prefer ordinary human output. See [CLI output modes](CLI_JSON_OUTPUT.md).

Every command accepts `--output-page-size <characters>` and `--output-cursor <cursor>`. Run normally without choosing a page size: oversized human output stays readable text and prints one exact continuation command; oversized JSON prints the exact command that opts into versioned JSON page envelopes.
Cross-command evidence citations are off by default. With an explicit `SCIP_QUERY_SESSION`, a complete source unit, a byte-identical exact subset of a prior exact source read, or a graph unit/edge may be replaced by a visible receipt from the same index generation. Preview coverage never suppresses an exact unit; changed bytes, changed graph content, a new generation, or global `--reemit` force full evidence.

### Agent operation catalogue

| Operation | Commands |
|---|---|
| Locate exact roots | `search <exact-text>`, `outline <file>`, `fan-in [symbol]` |
| Project typed relationships | `evidence [symbol]`, `entry-map <entry>` |
| Read selected behavior/source | `inspect`, `code <selectors...>` |
| Analyze declared result units | `stats`, `files <pattern>`, `session`, `methods <className>`, `refs <symbol>`, `trace <symbol>`, `deps <file>`, `rdeps <file>`, `system <module>`, `surface <module>`, `dead [scope]`, `hotspots`, `imports <file>`, `imported-by <symbol>`, `unused-imports <file>`, `members <symbol>`, `fan-out [file]`, `coupling [file1] [file2]`, `cycles`, `architecture`, `bottlenecks`, `isolated`, `by-kind <kind>`, `kind-counts`, `dependency-depth`, `deep-chains`, `hierarchy <symbol>`, `entrypoints [text]`, `call-graph <symbol>`, `similar [symbol] [other]`, `similar-files [file]`, `react-component-duplicates [file]`, `react-hook-candidates [file]`, `react-large-component-pressure [file]`, `vue-component-duplicates [file]`, `vue-composable-candidates [file]`, `vue-large-view-pressure [file]`, `similar-chains`, `extract-candidates`, `locality-candidates [symbol-or-file]`, `affected <symbol>`, `change-surface <file>`, `cleanup-plan`, `co-change [file]`, `recent-duplicates`, `doc-drift [doc]`, `unused-params`, `incomplete-migration`, `context <target>`, `drift [module]`, `wrapper-candidates`, `passthrough-candidates`, `stale-abstractions`, `complexity-hotspots`, `self-audit`, `convergence <symbol1> <symbol2>`, `complexity <symbol>`, `reference-neighborhood <symbol>`, `dataflow <symbol>`, `value-flow <symbol>`, `dependence-slice <symbol-or-location>`, `reference-reachability <symbol>`, `slice <symbol>`, `redundant-reexports`, `duplicate-bodies`, `twin-drift`, `not-implemented`, `decorative-checkers`, `test-quality`, `similar-signatures`, `diff-impact`, `config-validate` |
| Maintain repository/tool state | `reindex`, `augment-sources`, `augment-vue`, `tla <operation> [spec]`, `twin-ab <symbolA> <symbolB>`, `health`, `install-skills`, `check-deps`, `capabilities`, `init`, `suppress <id>`, `doctor`, `setup`, `setup-agent`, `uninstall`, `watch`, `status` |

### Typed relationship meanings

| Family | Establishes | Does not establish | Providers |
|---|---|---|---|
| `execution` | Static may-call reachability between resolved program constructs. | A may-call edge does not prove that a runtime invocation occurred. | SCIP/compiler identity and source ownership, parser-proved intraprocedural control dependence, TypeScript compiler identities, control-flow graph, and reaching definitions |
| `runtime` | A source-grounded handoff between producer and consumer participants through a runtime mechanism. | An unresolved or candidate join does not prove a runtime handoff. | source-grounded runtime-boundary joins |
| `dataflow` | A value, definition, argument, parameter, return, or statically resolved value may flow to another construct. | Current partial providers do not establish general interprocedural definition-use coverage. | source-grounded runtime-boundary joins, compiler callsites and bounded static value evaluation, TypeScript compiler identities, control-flow graph, and reaching definitions, parser-proved local state and temporal facts |
| `state` | A construct reads, writes, creates, deletes, or otherwise changes an identified state resource. | A state edge does not prove transactionality, durability, or exclusive ownership unless qualified. | parser-proved local state and temporal facts |
| `temporal` | One observed construct is locally ordered before or after another under the reported source evidence. | Source order does not imply cross-process happens-before or durability. | source-grounded runtime-boundary joins, parser-proved local state and temporal facts |
| `contract` | A program construct implements, constrains, or is typed by an identified contract. | Contract identity does not prove runtime invocation or conformance outside reported checks. | SCIP/compiler identity and source ownership |
| `identity` | Two observations refer to the same compiler-owned or source-owned program entity. | Shared identity does not establish execution or value transfer. | SCIP/compiler identity and source ownership |
| `ownership` | A source construct, symbol, runtime observation, or state resource is contained or owned by another program entity. | Structural ownership does not establish lifetime, singleton scope, or runtime execution unless qualified. | SCIP/compiler identity and source ownership |
| `dependencies` | A file, module, or symbol statically relies on another indexed entity. | A dependency edge does not establish that the depended-on code executes. | SCIP/compiler identity and source ownership |

### Typed relationship providers

| Provider | Family / subtype | Directions | Support ceiling | Establishes | Does not establish |
|---|---|---|---|---|---|
| `indexed-program-identity` | `execution/call` | `incoming`, `outgoing`, `both` | `partial` | The source construct may call the resolved target. | Static may-call reachability does not prove that an invocation occurred at runtime. |
| `indexed-program-identity` | `execution/result-callback` | `incoming`, `outgoing`, `both` | `partial` | The referenced callable can produce the result consumed by this path. | A callback relationship does not prove invocation order or runtime selection. |
| `indexed-program-identity` | `contract/uses-contract-symbol` | `incoming`, `outgoing`, `both` | `exact` | The source construct refers to the identified contract symbol. | Contract identity does not prove runtime invocation or behavioral conformance. |
| `indexed-program-identity` | `identity/references` | `incoming`, `outgoing`, `both` | `exact` | The occurrence resolves to the identified compiler-owned symbol. | A reference does not establish execution or value transfer. |
| `indexed-program-identity` | `ownership/contains` | `incoming`, `outgoing`, `both` | `exact` | The owner contains the identified program construct. | Structural containment does not establish runtime lifetime or sharing scope. |
| `indexed-program-identity` | `ownership/contains-*` | `incoming`, `outgoing`, `both` | `exact` | The owner contains the identified program construct. | Structural containment does not establish runtime lifetime or sharing scope. |
| `indexed-program-identity` | `ownership/owns-*` | `incoming`, `outgoing`, `both` | `exact` | The owner owns the identified source or runtime observation. | Observation ownership does not establish singleton lifetime or exclusive ownership. |
| `indexed-program-identity` | `dependencies/imports` | `incoming`, `outgoing`, `both` | `partial` | The source file or module statically imports the indexed target. | An import does not establish that imported code executes. |
| `indexed-program-identity` | `dependencies/imports-external` | `incoming`, `outgoing`, `both` | `partial` | The source region statically imports an external package. | An external import does not establish which package behavior executes. |
| `runtime-boundary-join` | `runtime/runtime-handoff` | `incoming`, `outgoing`, `both` | `partial` | A producer and consumer share a source-grounded runtime rendezvous. | A candidate or unresolved join does not prove a runtime handoff. |
| `runtime-boundary-join` | `runtime/discriminator-dispatch` | `incoming`, `outgoing`, `both` | `partial` | A serialized discriminator selects the reported consumer. | The dispatch edge does not prove delivery, retry, or successful handling. |
| `runtime-boundary-join` | `dataflow/serialized-discriminator-transfer` | `incoming`, `outgoing`, `both` | `partial` | The producer serializes the discriminator consumed by dispatch. | This edge does not establish the flow of every payload field. |
| `runtime-boundary-join` | `temporal/enqueue-before-consume` | `incoming`, `outgoing`, `both` | `partial` | The reported enqueue precedes a possible consume through the queue. | Queue order does not establish delivery time, uniqueness, retry count, or durability. |
| `parser-control-dependence` | `execution/predicate-consequence` | `incoming`, `outgoing`, `both` | `partial` | The outcome is control-dependent on the reported predicate or handler. | Local control dependence does not establish that the containing function executes. |
| `parser-control-dependence` | `execution/predicate-alternative` | `incoming`, `outgoing`, `both` | `partial` | The outcome is control-dependent on the reported predicate or handler. | Local control dependence does not establish that the containing function executes. |
| `parser-control-dependence` | `execution/predicate-fallthrough` | `incoming`, `outgoing`, `both` | `partial` | The outcome is control-dependent on the reported predicate or handler. | Local control dependence does not establish that the containing function executes. |
| `parser-control-dependence` | `execution/predicate-case` | `incoming`, `outgoing`, `both` | `partial` | The outcome is control-dependent on the reported predicate or handler. | Local control dependence does not establish that the containing function executes. |
| `parser-control-dependence` | `execution/predicate-default` | `incoming`, `outgoing`, `both` | `partial` | The outcome is control-dependent on the reported predicate or handler. | Local control dependence does not establish that the containing function executes. |
| `parser-control-dependence` | `execution/predicate-return` | `incoming`, `outgoing`, `both` | `partial` | The outcome is control-dependent on the reported predicate or handler. | Local control dependence does not establish that the containing function executes. |
| `parser-control-dependence` | `execution/predicate-throw` | `incoming`, `outgoing`, `both` | `partial` | The outcome is control-dependent on the reported predicate or handler. | Local control dependence does not establish that the containing function executes. |
| `parser-control-dependence` | `execution/loop-iteration` | `incoming`, `outgoing`, `both` | `partial` | The outcome is control-dependent on the reported predicate or handler. | Local control dependence does not establish that the containing function executes. |
| `parser-control-dependence` | `execution/loop-exit` | `incoming`, `outgoing`, `both` | `partial` | The outcome is control-dependent on the reported predicate or handler. | Local control dependence does not establish that the containing function executes. |
| `parser-control-dependence` | `execution/exception-handler` | `incoming`, `outgoing`, `both` | `partial` | The outcome is control-dependent on the reported predicate or handler. | Local control dependence does not establish that the containing function executes. |
| `parser-control-dependence` | `execution/finally-cleanup` | `incoming`, `outgoing`, `both` | `partial` | The outcome is control-dependent on the reported predicate or handler. | Local control dependence does not establish that the containing function executes. |
| `parser-control-dependence` | `execution/handler-return` | `incoming`, `outgoing`, `both` | `partial` | The outcome is control-dependent on the reported predicate or handler. | Local control dependence does not establish that the containing function executes. |
| `parser-control-dependence` | `execution/handler-throw` | `incoming`, `outgoing`, `both` | `partial` | The outcome is control-dependent on the reported predicate or handler. | Local control dependence does not establish that the containing function executes. |
| `parser-control-dependence` | `execution/returns` | `incoming`, `outgoing`, `both` | `partial` | The selected construct contains the reported return terminal. | - |
| `parser-control-dependence` | `execution/throws` | `incoming`, `outgoing`, `both` | `partial` | The selected construct contains the reported throw terminal. | - |
| `bounded-static-value-flow` | `dataflow/argument-to-parameter` | `incoming`, `outgoing`, `both` | `partial` | The reported value may reach the target through the evidenced callsite transfer. | This provider does not establish general local definition-use, alias, field, or heap flow. |
| `bounded-static-value-flow` | `dataflow/constant-to-parameter` | `incoming`, `outgoing`, `both` | `partial` | The reported value may reach the target through the evidenced callsite transfer. | This provider does not establish general local definition-use, alias, field, or heap flow. |
| `bounded-static-value-flow` | `dataflow/property-to-parameter` | `incoming`, `outgoing`, `both` | `partial` | The reported value may reach the target through the evidenced callsite transfer. | This provider does not establish general local definition-use, alias, field, or heap flow. |
| `bounded-static-value-flow` | `dataflow/return-to-parameter` | `incoming`, `outgoing`, `both` | `partial` | The reported value may reach the target through the evidenced callsite transfer. | This provider does not establish general local definition-use, alias, field, or heap flow. |
| `bounded-static-value-flow` | `dataflow/return-to-call-result` | `incoming`, `outgoing`, `both` | `partial` | The reported value may reach the target through the evidenced callsite transfer. | This provider does not establish general local definition-use, alias, field, or heap flow. |
| `typescript-local-dependence` | `dataflow/definition-to-use` | `incoming`, `outgoing`, `both` | `partial` | The definition reaches the reported read on a feasible local control-flow path. | Local reaching definitions do not establish heap aliasing, exceptional flow, or the runtime order of closure invocation. |
| `typescript-local-dependence` | `dataflow/value-to-definition` | `incoming`, `outgoing`, `both` | `partial` | The reported right-hand-side read supplies the assigned local definition. | A local assignment edge does not establish field or heap points-to flow. |
| `typescript-local-dependence` | `dataflow/closure-capture` | `incoming`, `outgoing`, `both` | `candidate` | The nested callable reads the reported binding from an enclosing callable. | Closure capture does not establish whether or when the nested callable executes. |
| `typescript-local-dependence` | `dataflow/field-definition-to-use` | `incoming`, `outgoing`, `both` | `partial` | The reported same-owner field definition can reach the field read. | Field-name identity does not establish whole-program heap aliasing or cross-instance flow. |
| `typescript-local-dependence` | `execution/control-dependence` | `incoming`, `outgoing`, `both` | `partial` | Execution of the reported statement depends on the outcome of the predicate. | Intraprocedural control dependence does not establish that the containing callable executes. |
| `parser-state-temporal` | `dataflow/captured-value-to-state` | `incoming`, `outgoing`, `both` | `partial` | The reported source value is assigned into the identified state resource. | The edge does not establish alias, heap, or later read flow. |
| `parser-state-temporal` | `dataflow/constant-to-state` | `incoming`, `outgoing`, `both` | `partial` | The reported source value is assigned into the identified state resource. | The edge does not establish alias, heap, or later read flow. |
| `parser-state-temporal` | `dataflow/expression-to-state` | `incoming`, `outgoing`, `both` | `partial` | The reported source value is assigned into the identified state resource. | The edge does not establish alias, heap, or later read flow. |
| `parser-state-temporal` | `dataflow/property-to-state` | `incoming`, `outgoing`, `both` | `partial` | The reported source value is assigned into the identified state resource. | The edge does not establish alias, heap, or later read flow. |
| `parser-state-temporal` | `dataflow/return-to-state` | `incoming`, `outgoing`, `both` | `partial` | The reported source value is assigned into the identified state resource. | The edge does not establish alias, heap, or later read flow. |
| `parser-state-temporal` | `dataflow/value-to-state` | `incoming`, `outgoing`, `both` | `partial` | The reported source value is assigned into the identified state resource. | The edge does not establish alias, heap, or later read flow. |
| `parser-state-temporal` | `state/writes-resource` | `incoming`, `outgoing`, `both` | `partial` | The reported construct performs the named operation on the identified resource. | A state operation does not establish transactionality, durability, or exclusive ownership. |
| `parser-state-temporal` | `state/deletes-resource` | `incoming`, `outgoing`, `both` | `partial` | The reported construct performs the named operation on the identified resource. | A state operation does not establish transactionality, durability, or exclusive ownership. |
| `parser-state-temporal` | `state/reads-resource` | `incoming`, `outgoing`, `both` | `partial` | The reported construct performs the named operation on the identified resource. | A state operation does not establish transactionality, durability, or exclusive ownership. |
| `parser-state-temporal` | `state/enqueues-resource` | `incoming`, `outgoing`, `both` | `partial` | The reported construct performs the named operation on the identified resource. | A state operation does not establish transactionality, durability, or exclusive ownership. |
| `parser-state-temporal` | `state/consumes-resource` | `incoming`, `outgoing`, `both` | `partial` | The reported construct performs the named operation on the identified resource. | A state operation does not establish transactionality, durability, or exclusive ownership. |
| `parser-state-temporal` | `temporal/await-completion-before` | `incoming`, `outgoing`, `both` | `partial` | The reported source constructs have the named local ordering relationship. | Local source order does not establish cross-process happens-before or durable completion. |
| `parser-state-temporal` | `temporal/awaits-completion` | `incoming`, `outgoing`, `both` | `partial` | The reported source constructs have the named local ordering relationship. | Local source order does not establish cross-process happens-before or durable completion. |
| `parser-state-temporal` | `temporal/inside-lock-scope` | `incoming`, `outgoing`, `both` | `partial` | The reported source constructs have the named local ordering relationship. | Local source order does not establish cross-process happens-before or durable completion. |
| `parser-state-temporal` | `temporal/lexical-successor` | `incoming`, `outgoing`, `both` | `partial` | The reported source constructs have the named local ordering relationship. | Local source order does not establish cross-process happens-before or durable completion. |

### Indexing

| Command | Description | Cost | Closes disclosed gaps with | Options |
|---|---|---|---|---|
| `reindex` | Index the codebase and convert to SQLite | variable | - | `-l, --language <lang>`<br>`--pnpm-workspaces`<br>`--force`<br>`--allow-partial`<br>`--trust-project-tools`<br>`--install-missing`<br>`--indexer-concurrency <n>`<br>`--json`<br>`--result-only`<br>`--compact` |
| `augment-sources` | Add source files skipped by upstream SCIP indexers to the SQLite documents table | variable | - | - |
| `augment-vue` | Add compiler-resolved Vue SFC references to the SQLite index using Volar | variable | - | `--project <tsconfig>` |

### Core

| Command | Description | Cost | Closes disclosed gaps with | Options |
|---|---|---|---|---|
| `stats` | Show index statistics | bounded | `inspect`, `code` | `--json`<br>`--result-only`<br>`--compact` |

### Navigation

| Command | Description | Cost | Closes disclosed gaps with | Options |
|---|---|---|---|---|
| `files <pattern>` | Find current project files matching a path pattern | bounded | `inspect`, `code` | `--json`<br>`--result-only`<br>`--compact` |
| `session` | Show evidence already delivered in this agent exploration session | bounded | `inspect`, `code` | `--reset` |
| `inspect` | Batch related searches, symbols, and source locations into one deduplicated source packet | potentially-large | - | `--search <text>`<br>`--symbol <symbol>`<br>`--at <file:line>`<br>`-s, --scope <path>`<br>`-C, --context <n>`<br>`-n, --limit <n>`<br>`--max-units <n>`<br>`--max-characters <n>`<br>`--view <view>`<br>`--allow-large-source`<br>`--allow-large-behavior`<br>`--unit-lines <n>`<br>`--total-lines <n>`<br>`--include <part>`<br>`--evidence-budget <channel=n>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `search <exact-text>` | Count current project text matches and preview a bounded, recoverable identity and source manifest | small | `evidence`, `inspect`, `code` | `-s, --scope <path>`<br>`-C, --context <n>`<br>`-n, --limit <n>`<br>`--full`<br>`--regexp`<br>`-i, --ignore-case`<br>`--json`<br>`--result-only`<br>`--compact` |
| `methods <className>` | List methods of one exactly resolved class; ambiguity and missing targets fail explicitly | bounded | `inspect`, `code` | `--json`<br>`--result-only`<br>`--compact` |
| `refs <symbol>` | Find all files referencing a symbol | variable | `inspect`, `code` | `--full`<br>`-n, --limit <n>`<br>`--cursor <cursor>`<br>`--json`<br>`--result-only`<br>`--compact` |
| `trace <symbol>` | Trace a symbol: definition + all references | variable | `inspect`, `code` | `--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `evidence [symbol]` | Traverse selected typed relationships around exact referents, with optional source evidence | bounded | `inspect`, `code` | `--symbol <symbol>`<br>`--at <file:line>`<br>`--search <literal>`<br>`--view <view>`<br>`--edge <family>`<br>`--direction <direction>`<br>`--subtype <subtype>`<br>`--connecting`<br>`--inventory-only`<br>`--fold <id>`<br>`--depth <n>`<br>`--max-edges <n>`<br>`--include <part>`<br>`-C, --context <n>`<br>`--related-source-lines <n>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `deps <file>` | Files this file depends on (internal) | bounded | `inspect`, `code` | `--json`<br>`--result-only`<br>`--compact` |
| `rdeps <file>` | Files that depend on this file/module | bounded | `inspect`, `code` | `--json`<br>`--result-only`<br>`--compact` |
| `system <module>` | One-hop module summary: matched files, documented symbols, and file reference dependencies | bounded | `inspect`, `code` | `--json`<br>`--result-only`<br>`--compact` |
| `surface <module>` | What symbols consumers actually use from this module | bounded | `inspect`, `code` | `--json`<br>`--result-only`<br>`--compact` |
| `imports <file>` | What symbols does this file import? | variable | `inspect`, `code` | `--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `imported-by <symbol>` | Which files import this symbol? | bounded | `inspect`, `code` | `--json`<br>`--result-only`<br>`--compact` |
| `outline <file>` | Tree view of symbols in a file, with line ranges | small | `evidence`, `inspect`, `code` | `--signatures`<br>`--json`<br>`--result-only`<br>`--compact` |
| `members <symbol>` | All children of a symbol (methods, fields, nested types) | bounded | `inspect`, `code` | `--json`<br>`--result-only`<br>`--compact` |
| `by-kind <kind>` | Find symbols by SCIP kind (class, interface, enum, function, etc.) | variable | `inspect`, `code` | `-s, --scope <path>`<br>`-n, --limit <n>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `kind-counts` | Histogram of symbol kinds in the codebase | bounded | `inspect`, `code` | `-s, --scope <path>`<br>`--json`<br>`--result-only`<br>`--compact` |
| `hierarchy <symbol>` | Show a symbol's ancestry chain (method → class → module) | bounded | `inspect`, `code` | `--json`<br>`--result-only`<br>`--compact` |
| `code <selectors...>` | Read exact definitions, ranges with local call closure, or file export surfaces | potentially-large | - | `-C, --context <n>`<br>`--members <exported|all>`<br>`--json`<br>`--result-only`<br>`--compact` |
| `reference-neighborhood <symbol>` | Show definition/reference sites and incoming/outgoing static calls without value-flow claims | variable | `inspect`, `code` | `--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `dataflow <symbol>` | Deprecated compatibility alias for a reference/call neighborhood; use value-flow | variable | `inspect`, `code` | `--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `value-flow <symbol>` | Show only proved argument/parameter and bounded static-value transfers around a symbol | variable | `inspect`, `code` | `--depth <n>`<br>`--max-edges <n>`<br>`--json`<br>`--result-only`<br>`--compact` |
| `dependence-slice <symbol-or-location>` | Directional slice over proved data/control dependencies with explicit supporting call edges | variable | `inspect`, `code` | `--forward`<br>`--depth <n>`<br>`--max-edges <n>`<br>`--json`<br>`--result-only`<br>`--compact` |
| `reference-reachability <symbol>` | Traverse legacy callee or reference-owner reachability without calling it a program slice | variable | `inspect`, `code` | `--forward`<br>`--depth <n>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `slice <symbol>` | Deprecated compatibility alias for reference/call reachability; use dependence-slice | variable | `inspect`, `code` | `--forward`<br>`--depth <n>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |

### Compatibility

| Command | Description | Cost | Closes disclosed gaps with | Options |
|---|---|---|---|---|
| `anchors <question>` | Deprecated compatibility view for query-vocabulary candidate groups; use exact locators plus evidence | small | `evidence`, `inspect`, `code` | `-s, --scope <path>`<br>`-n, --limit <n>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `system-map` | Deprecated compatibility view for collapsed regions and legacy route catalogues; use evidence | bounded | `inspect`, `code` | `--search <literal>`<br>`--symbol <symbol>`<br>`--focus-at <file:line>`<br>`--depth <n>`<br>`--relation <kind>`<br>`--evidence-floor <floor>`<br>`--topology-characters <n>`<br>`--source-scope <scope>`<br>`--full-literal-traversal`<br>`--expand <region-id>`<br>`--frontier <frontier-id>`<br>`--route <route-id>`<br>`--gap-callee <name>`<br>`--selection-term <term>`<br>`--gap-recovery-only`<br>`--json`<br>`--result-only`<br>`--compact` |

### Cleanup

| Command | Description | Cost | Closes disclosed gaps with | Options |
|---|---|---|---|---|
| `dead [scope]` | Find repository-dead code, file-internal symbols, and implicit-usage signals | variable | `inspect`, `code` | `--min-loc <n>`<br>`--include-tests`<br>`--skip-barrels`<br>`--include-members`<br>`--only-dead`<br>`--only-internal`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `unused-imports <file>` | Find imports not referenced in the same file | variable | `inspect`, `code` | `--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `isolated` | Find completely orphaned symbols (no references at all) | variable | `inspect`, `code` | `-s, --scope <path>`<br>`--min-loc <n>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `similar [symbol] [other]` | Find heuristic function similarity candidates from callee fingerprints | variable | `inspect`, `code` | `--min-similarity <n>`<br>`-n, --limit <n>`<br>`-s, --scope <path>`<br>`--min-callees <n>`<br>`--cross-file-only`<br>`--plan`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `similar-files [file]` | Find heuristic similar-file candidates from dependency profiles | variable | `inspect`, `code` | `--min-similarity <n>`<br>`-n, --limit <n>`<br>`-s, --scope <path>`<br>`--min-deps <n>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `react-component-duplicates [file]` | Find heuristic duplicated React component structure candidates from JSX tags, props, events, and bindings | variable | `inspect`, `code` | `--min-similarity <n>`<br>`--min-tokens <n>`<br>`-n, --limit <n>`<br>`-s, --scope <path>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `react-hook-candidates [file]` | Find heuristic React hook extraction candidates from shared state, effects, requests, and handlers | variable | `inspect`, `code` | `--min-similarity <n>`<br>`--min-shared-behaviors <n>`<br>`-n, --limit <n>`<br>`-s, --scope <path>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `react-large-component-pressure [file]` | Find heuristic large React component pressure candidates from component lines, JSX structure, and hook behavior | variable | `inspect`, `code` | `--min-component-lines <n>`<br>`--min-file-lines <n>`<br>`--min-jsx-tokens <n>`<br>`--min-behavior-tokens <n>`<br>`-n, --limit <n>`<br>`-s, --scope <path>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `vue-component-duplicates [file]` | Find heuristic duplicated Vue component structure candidates from template tags, bindings, slots, and directives | variable | `inspect`, `code` | `--min-similarity <n>`<br>`--min-tokens <n>`<br>`-n, --limit <n>`<br>`-s, --scope <path>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `vue-composable-candidates [file]` | Find heuristic Vue composable extraction candidates from shared state, effects, requests, and template bindings | variable | `inspect`, `code` | `--min-similarity <n>`<br>`--min-shared-behaviors <n>`<br>`-n, --limit <n>`<br>`-s, --scope <path>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `vue-large-view-pressure [file]` | Find heuristic large Vue view pressure candidates from template, script, style, and external script line counts | variable | `inspect`, `code` | `--min-total-lines <n>`<br>`--min-template-lines <n>`<br>`--min-script-lines <n>`<br>`--min-style-lines <n>`<br>`--review-thresholds`<br>`-n, --limit <n>`<br>`-s, --scope <path>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `similar-chains` | Find heuristic similar-chain candidates from dependency flows | variable | `inspect`, `code` | `--min-similarity <n>`<br>`-n, --limit <n>`<br>`-s, --scope <path>`<br>`--min-length <n>`<br>`--max-length <n>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `extract-candidates` | Find heuristic extraction candidates from isolated callee clusters | variable | `inspect`, `code` | `-s, --scope <path>`<br>`--min-loc <n>`<br>`--min-callees <n>`<br>`-n, --limit <n>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `locality-candidates [symbol-or-file]` | Find directory-locality and ancestry candidates from consumer ownership | variable | `inspect`, `code` | `-s, --scope <path>`<br>`--min-consumers <n>`<br>`-n, --limit <n>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `cleanup-plan` | Ordered, batched deletion plan: graph-fact dead code plus the cascade candidates it unlocks | variable | `inspect`, `code` | `-s, --scope <path>`<br>`--min-loc <n>`<br>`--max-depth <n>`<br>`--verify`<br>`--patch`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `recent-duplicates` | Directional duplicate candidates: recent code that re-implements established callable, React, or Vue code | variable | `inspect`, `code` | `--window <n>`<br>`--min-similarity <n>`<br>`-n, --limit <n>`<br>`-s, --scope <path>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `doc-drift [doc]` | Stale-doc candidates: code the doc references or co-changed with kept changing after the doc stopped | variable | `inspect`, `code` | `-n, --limit <n>`<br>`--min-coupling <n>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `unused-params` | Speculative-generality candidates: trailing parameters no body ever uses (TS/JS) | variable | `inspect`, `code` | `-s, --scope <path>`<br>`-n, --limit <n>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `drift [module]` | Detect drift candidates: unused imports and declared architecture violations; pass --architecture for boundary context | variable | `inspect`, `code` | `--min-deviation <n>`<br>`--patterns`<br>`--architecture`<br>`-n, --limit <n>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `wrapper-candidates` | Find heuristic wrapper candidates only called by one consumer (high false-positive rate on codebases with intentional layering/ambient types — treat as exploration, not findings) | variable | `inspect`, `code` | `-s, --scope <path>`<br>`--max-loc <n>`<br>`-n, --limit <n>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `passthrough-candidates` | Find heuristic passthrough candidates that forward to one callee | variable | `inspect`, `code` | `-s, --scope <path>`<br>`--max-loc <n>`<br>`-n, --limit <n>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `stale-abstractions` | Find heuristic stale abstraction candidates with 0-1 consumers (high false-positive rate on codebases with intentional layering/ambient types — treat as exploration, not findings) | variable | `inspect`, `code` | `-s, --scope <path>`<br>`--min-loc <n>`<br>`-n, --limit <n>`<br>`--include-low-confidence`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `complexity-hotspots` | Find heuristic complexity hotspot candidates from LOC x fan-in x fan-out | variable | `inspect`, `code` | `-s, --scope <path>`<br>`--min-loc <n>`<br>`-n, --limit <n>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `convergence <symbol1> <symbol2>` | Deprecated alias for similar <symbol1> <symbol2> --plan | variable | `inspect`, `code` | `--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `redundant-reexports` | Find barrel re-exports that nobody imports through | variable | `inspect`, `code` | `-s, --scope <path>`<br>`-n, --limit <n>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `duplicate-bodies` | Find exact duplicate small-body candidates across files | variable | `inspect`, `code` | `-s, --scope <path>`<br>`--max-loc <n>`<br>`--min-loc <n>`<br>`-n, --limit <n>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `twin-drift` | Twin drift candidates: same-name (or near-name) functions across files with diverged bodies | variable | `inspect`, `code` | `-s, --scope <path>`<br>`--min-similarity <n>`<br>`--include-homonyms`<br>`-n, --limit <n>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `twin-ab <symbolA> <symbolB>` | Generate a behavioral A/B scaffold comparing two same-concept twins (cleanup integrity scenario) — a ready-to-fill vitest file, not an auto-executor | variable | - | `--out <path>`<br>`--force`<br>`--json`<br>`--result-only`<br>`--compact` |
| `not-implemented` | Reachable placeholder stub candidates (throw-stub, TODO+return-default, empty body) — production callers can actually reach these; an unreachable stub is dead's job, not this one's | variable | `inspect`, `code` | `-s, --scope <path>`<br>`-n, --limit <n>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `decorative-checkers` | Decorative checker candidates: validate*/verify*/check*/assert*/is*/has* callables with no reachable failure exit anywhere in their body | variable | `inspect`, `code` | `-s, --scope <path>`<br>`-n, --limit <n>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `test-quality` | Test-quality candidates: assertion-free it/test bodies, a skipped-test ledger with git-blame age, and mock-echo tests that assert the same literal they stubbed into a mock | variable | `inspect`, `code` | `-s, --scope <path>`<br>`-n, --limit <n>`<br>`--rot-days <n>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `similar-signatures` | Find functions with near-identical type signatures (same shape) | variable | `inspect`, `code` | `-s, --scope <path>`<br>`--min-loc <n>`<br>`--max-shape-frequency <n>`<br>`-n, --limit <n>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |

### Graph

| Command | Description | Cost | Closes disclosed gaps with | Options |
|---|---|---|---|---|
| `hotspots` | Rank symbols by cross-file reference count; a reference metric, not runtime contention | variable | `inspect`, `code` | `-n, --limit <n>`<br>`-s, --scope <path>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `fan-in [symbol]` | Count files referencing an exact symbol; top JSON rows include exact symbol identity | small | `evidence`, `inspect`, `code` | `-n, --limit <n>`<br>`-s, --scope <path>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `fan-out [file]` | How many external symbols a file uses (or top fan-out across codebase) | variable | `inspect`, `code` | `-n, --limit <n>`<br>`-s, --scope <path>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `coupling [file1] [file2]` | Count shared-symbol coupling between two files, or rank file pairs by that metric | variable | `inspect`, `code` | `-n, --limit <n>`<br>`-s, --scope <path>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `cycles` | Find every cyclic file-dependency component and show one deterministic witness for each | bounded | `inspect`, `code` | `-s, --scope <path>`<br>`--imports-only`<br>`--max-depth <n>`<br>`--json`<br>`--result-only`<br>`--compact` |
| `architecture` | Evaluate project-owned architectural boundaries and dependency rules | bounded | `inspect`, `code` | `-s, --scope <path>`<br>`--json`<br>`--result-only`<br>`--compact` |
| `bottlenecks` | Rank coordination hubs by incoming evidence files × outgoing cross-file callable targets | variable | `inspect`, `code` | `-n, --limit <n>`<br>`-s, --scope <path>`<br>`--min-fan-in <n>`<br>`--min-fan-out <n>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `dependency-depth` | Find longest paths through the SCC-condensed file dependency graph | variable | `inspect`, `code` | `-n, --limit <n>`<br>`-s, --scope <path>`<br>`--min-depth <n>`<br>`--imports-only`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `deep-chains` | Deprecated alias for dependency-depth | variable | `inspect`, `code` | `-n, --limit <n>`<br>`-s, --scope <path>`<br>`--min-depth <n>`<br>`--imports-only`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `entrypoints [text]` | Find callables where control may enter from outside the indexed call graph | bounded | `inspect`, `code` | `-s, --scope <path>`<br>`--json`<br>`--result-only`<br>`--compact` |
| `entry-map <entry>` | Map the complete indexed call graph from one detected entry point, collapsed by file | bounded | `inspect`, `code` | `--expand <region-id>`<br>`--json`<br>`--result-only`<br>`--compact` |
| `call-graph <symbol>` | Show static may-call edges with exact/candidate evidence and explicit blind spots | variable | `inspect`, `code` | `--full`<br>`--json`<br>`--result-only`<br>`--compact` |

### Impact

| Command | Description | Cost | Closes disclosed gaps with | Options |
|---|---|---|---|---|
| `affected <symbol>` | Conservative reverse caller/reference closure of symbols that may be impacted by a change | variable | `inspect`, `code` | `--full`<br>`--max-depth <n>`<br>`-s, --scope <path>`<br>`--json`<br>`--result-only`<br>`--compact` |
| `change-surface <file>` | Pre-change briefing: consumers, published API, operational roots, and explained change risk | variable | `inspect`, `code` | `--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `co-change [file]` | Files that change together in git history without a dependency edge — hidden coupling candidates | variable | `inspect`, `code` | `--min-together <n>`<br>`-n, --limit <n>`<br>`--all`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `incomplete-migration` | Partially-completed extraction candidates: new helpers in the diff wired into some sites while similar un-migrated sites remain | variable | `inspect`, `code` | `--base <ref>`<br>`--min-containment <n>`<br>`--max-helpers <n>`<br>`-n, --limit <n>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `diff-impact` | Map changed symbols and downstream consumers from the current git diff | variable | `inspect`, `code` | `--base <ref>`<br>`--json`<br>`--result-only`<br>`--compact` |

### Formal Models

| Command | Description | Cost | Closes disclosed gaps with | Options |
|---|---|---|---|---|
| `tla <operation> [spec]` | TLA+ model workflow: verify a model and mapping contract, scaffold a draft model from indexed code, generate a trace recorder, or check a recorded trace against the next-state relation | variable | - | `--map <file>`<br>`--config <file>`<br>`--checker <mode>`<br>`--tla-tools <jar>`<br>`--apalache <binary>`<br>`--length <n>`<br>`--timeout-ms <n>`<br>`--trace <file>`<br>`--next <operator>`<br>`--coverage`<br>`--allow-unknown`<br>`--out <path>`<br>`--module-name <name>`<br>`--force`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |

### Exploration

| Command | Description | Cost | Closes disclosed gaps with | Options |
|---|---|---|---|---|
| `context <target>` | Compiler-backed context for a symbol, file, or module | variable | `inspect`, `code` | `--impact-depth <n>`<br>`--slice-depth <n>`<br>`-s, --scope <path>`<br>`-n, --limit <n>`<br>`--detail`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |

### Health

| Command | Description | Cost | Closes disclosed gaps with | Options |
|---|---|---|---|---|
| `self-audit` | Score cheap evidence paths against the best available semantic/source oracle on sampled symbols | variable | `inspect`, `code` | `--samples <n>`<br>`-s, --scope <path>`<br>`--json`<br>`--result-only`<br>`--compact` |
| `complexity <symbol>` | Per-symbol complexity: branches, cyclomatic estimate, fan-in/out, callees | variable | `inspect`, `code` | `--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `health` | Composite repository health report with React, Vue, and general cleanup findings | variable | - | `-s, --scope <path>`<br>`--full`<br>`--baseline`<br>`--write-baseline`<br>`--json`<br>`--result-only`<br>`--compact` |

### Maintenance

| Command | Description | Cost | Closes disclosed gaps with | Options |
|---|---|---|---|---|
| `install-skills` | Install skills (scip-query, scip-explore, concrete-plan) into Claude Code, Codex, and shared agent roots | variable | - | - |
| `check-deps` | Check whether scip-query and the detected language indexers are runnable | variable | - | - |
| `capabilities` | Report which mapping and analysis capabilities are available in this project | variable | - | `--matrix`<br>`--json`<br>`--result-only`<br>`--compact` |
| `init` | Create a .scipquery.json configuration file for this project | variable | - | - |
| `config-validate` | Validate .scipquery.json, structured suppressions, architecture, and coupling groups | bounded | `inspect`, `code` | `--json`<br>`--result-only`<br>`--compact` |
| `suppress <id>` | Record an accepted finding under .scipquery/suppressions with a required reason | variable | - | `--reason <text>`<br>`--reason-code <code>`<br>`--evidence <kind:referent>`<br>`--check <check>`<br>`--file <path>`<br>`--expires-at <iso>`<br>`--replace <revision>`<br>`--json`<br>`--result-only`<br>`--compact` |
| `doctor` | Diagnose configuration, index freshness, dependencies, and project capabilities | variable | - | `--json`<br>`--result-only`<br>`--compact` |
| `setup` | Install skills, write agent guidance, refresh the index, and report repository health | variable | - | `--guided`<br>`--yes`<br>`--no-skills`<br>`--no-parsers`<br>`--install-missing`<br>`--no-health`<br>`--dossier-dir <path>`<br>`--json`<br>`--result-only`<br>`--compact` |
| `setup-agent` | Write concise scip-query mapping and cleanup guidance to AGENTS.md and CLAUDE.md | variable | - | - |
| `uninstall` | Remove selected scip-query-owned skills or project guidance | variable | - | `--global`<br>`--project`<br>`--dry-run`<br>`--verbose`<br>`--json`<br>`--result-only`<br>`--compact` |
| `watch` | Watch in the foreground or manage the project refresh service | variable | - | `--daemon`<br>`--status`<br>`--stop`<br>`--debounce <ms>`<br>`--cooldown <ms>`<br>`--git-poll <ms>`<br>`--idle-timeout <ms>`<br>`--json`<br>`--result-only`<br>`--compact` |
| `status` | Show index status for this project | variable | - | `--capabilities`<br>`--json`<br>`--result-only`<br>`--compact` |

<!-- END GENERATED COMMAND REFERENCE -->
