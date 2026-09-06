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

### Exploration control manual

The operator chooses the material question and deliberately selects a control. These contracts describe observations; they do not infer task relevance.

| Stage | Control | Question answered | Required input | Returned fact | Evidence ceiling | Does not establish | Cost | Contrast | Close a gap with |
|---|---|---|---|---|---|---|---|---|---|
| locate | `search <exact-text>` | Where does this exact text occur in current project text, and which aligned compiler symbol owns each line? | One exact text literal or deliberately bounded regular expression; insert \`--\` before a literal that starts with a dash. | exact cardinality, bounded identities and source, and scope commands that recover withheld matches | Exact current-text cardinality and locations within reported text coverage; compiler ownership only where aligned. | Structural source ranking orders exact matches but does not establish task relevance. A literal co-occurrence does not establish a graph relationship. | `small` | outline: search locates exact text across files; outline enumerates compiler-owned constructs in one known file. | `evidence`, `inspect`, `code` |
| locate | `outline <file>` | What symbols and nesting exist in this file? | One exact current project file path. | symbol names, nesting, and line ranges | Exact compiler-owned constructs and ranges when the file is indexed; no invented semantic overlay. | File ownership and nesting do not establish execution or task relevance. | `small` | search: outline enumerates constructs in one known file; search locates exact text across current project text. code: outline returns identities and ranges; code materializes exact source for selected identities. | `evidence`, `inspect`, `code` |
| locate | `entrypoints [text]` | Which detected external roots or entry-surface candidates match this text? | Optional exact text to filter candidates; otherwise the current indexed repository. | entry symbols with files, confidence, evidence, and observed static caller counts | Source/compiler-grounded entry evidence and observed static caller counts; exported-only candidates remain candidates. | A package-public export or zero indexed callers is an entry candidate, not proof of runtime ingress. Entry classification does not establish that the callable executes. | `bounded` | entry-map: entrypoints locates possible external roots; entry-map traverses static calls from one selected root. search: entrypoints classifies callable roots; search only locates exact text and ownership. | `evidence`, `inspect`, `code` |
| project | `evidence` | Which exact execution, runtime, data, state, temporal, contract, identity, ownership, or dependency relationships surround these referents? Which related source must be read only when graph evidence leaves a named implementation gap? | One or more exact symbol, file:line, or literal roots plus explicit family, direction, depth, and output bound. | batched exact selectors and typed graph relationships; compact endpoints with exact locations and follow-up commands; coverage and recoverable omissions; exact source-recovery command when source was requested with a graph projection; explicit ambiguity failure with exact rerun commands | Typed edges only to each registered provider ceiling within the explicitly selected projection and reported coverage. | The projection does not infer which relationships are relevant to the user task. Reference, dependency, data, state, temporal, contract, and identity edges do not become execution claims. | `bounded` | refs: refs enumerates direct reference sites; evidence traverses explicitly selected typed relationships. call-graph: call-graph specializes in static calls; evidence can combine execution with other selected families. dependence-slice: dependence-slice computes a program-dependence slice; evidence performs bounded graph projection. | `inspect`, `code` |
| read | `inspect` | Which related source units across several known text, symbol, or location anchors should be read together? | One or more exact text, symbol, or file:line selectors naming the unresolved behavior. | one ranked, deduplicated semantic packet plus exact selector cardinality and explicit expansion coverage | Complete current source for every materialized syntax unit; bounded selector and packet coverage remain explicit. | A source packet does not choose which implementation details are relevant to the user task. A reference mention does not establish executable reachability. | `potentially-large` | code: inspect batches bounded behavior or source gaps; code materializes complete exact source. evidence: inspect reads implementation units; evidence projects typed relationships without source. | - |
| read | `code <selectors...>` | What exact source defines these symbols, ranges, or file surfaces? | One or more exact symbols, file:line ranges, or file paths. | per-selector resolution, complete definition source, exact ranges, optional same-file call closure, file export surfaces, and omitted-local ledgers | Exact current source bytes for every resolved selector, with omitted file-local constructs disclosed. | Source materialization does not establish callers, runtime reachability, or task relevance by itself. | `potentially-large` | inspect: code materializes complete exact source; inspect batches bounded behavior or source gaps. outline: code reads selected implementations; outline enumerates file structure without reading every body. | - |

### Relationship question manual

| Material question | Family | Direction | Establishes | Reported strengths | Provider ceilings | Does not establish |
|---|---|---|---|---|---|---|
| Who can call or reach this? | `execution` | `incoming` | Static may-call reachability between resolved program constructs. | `exact`, `derived`, `candidate`, `mixed` | `partial` | A may-call edge does not prove that a runtime invocation occurred. |
| What can this call or reach? | `execution` | `outgoing` | Static may-call reachability between resolved program constructs. | `exact`, `derived`, `candidate`, `mixed` | `partial` | A may-call edge does not prove that a runtime invocation occurred. |
| Where can this value come from? | `dataflow` | `incoming` | A value, definition, argument, parameter, return, or statically resolved value may flow to another construct. | `exact`, `derived`, `mixed`, `candidate` | `partial`, `candidate` | Current partial providers do not establish general interprocedural definition-use coverage. |
| Where can this value go? | `dataflow` | `outgoing` | A value, definition, argument, parameter, return, or statically resolved value may flow to another construct. | `exact`, `derived`, `mixed`, `candidate` | `partial`, `candidate` | Current partial providers do not establish general interprocedural definition-use coverage. |
| Which producer and consumer rendezvous? | `runtime` | `both` | A source-grounded handoff between producer and consumer participants through a runtime mechanism. | `exact`, `derived`, `candidate`, `mixed` | `partial` | An unresolved or candidate join does not prove a runtime handoff. |
| What resource is observed or changed? | `state` | `both` | A construct reads, writes, creates, deletes, or otherwise changes an identified state resource. | `exact` | `partial` | A state edge does not prove transactionality, durability, or exclusive ownership unless qualified. |
| What occurs before or after this? | `temporal` | `both` | One observed construct is locally ordered before or after another under the reported source evidence. | `exact`, `derived`, `mixed` | `partial` | Source order does not imply cross-process happens-before or durability. |
| What interface constrains this? | `contract` | `both` | A program construct implements, constrains, or is typed by an identified contract. | `exact`, `derived`, `mixed` | `exact` | Contract identity does not prove runtime invocation or conformance outside reported checks. |
| Are these observations the same entity? | `identity` | `both` | Two observations refer to the same compiler-owned or source-owned program entity. | `exact`, `derived`, `mixed` | `exact` | Shared identity does not establish execution or value transfer. |
| What contains or owns this? | `ownership` | `both` | A source construct, symbol, runtime observation, or state resource is contained or owned by another program entity. | `exact`, `derived`, `mixed` | `exact` | Structural ownership does not establish lifetime, singleton scope, or runtime execution unless qualified. |
| What does this statically rely on? | `dependencies` | `outgoing` | A file, module, or symbol statically relies on another indexed entity. | `exact`, `derived`, `mixed` | `partial` | A dependency edge does not establish that the depended-on code executes. |

### Evidence strength legend

| Strength | Meaning |
|---|---|
| `exact` | Direct compiler or source evidence establishes this relationship within the provider's reported coverage. |
| `derived` | A deterministic analysis computed this relationship from reported input facts; it was not directly observed. |
| `candidate` | Ambiguous or heuristic evidence identifies a lead that requires exact graph or source confirmation. |
| `mixed` | The relationship combines evidence of different strengths; its constituent methods and strengths remain disclosed. |
| `unknown` | The relationship has no calibrated evidence strength and cannot support a stronger claim than its raw observation. |

### Agent operation catalogue

| Operation | Commands |
|---|---|
| Locate exact roots | `search <exact-text>`, `outline <file>`, `fan-in [symbol]`, `entrypoints [text]` |
| Project typed relationships | `evidence`, `entry-map <entry>` |
| Read selected behavior/source | `inspect`, `code <selectors...>` |
| Analyze declared result units | `review`, `stats`, `files <pattern>`, `methods <className>`, `refs <symbol>`, `deps <file>`, `rdeps <file>`, `system [module]`, `surface <module>`, `dead [scope]`, `hotspots`, `imports <file>`, `imported-by <symbol>`, `unused-imports <file>`, `members <symbol>`, `fan-out [file]`, `coupling [file1] [file2]`, `cycles`, `architecture`, `bottlenecks`, `by-kind <kind>`, `kind-counts`, `dependency-depth`, `hierarchy <symbol>`, `call-graph <symbol>`, `similar [symbol] [other]`, `similar-files [file]`, `react-component-duplicates [file]`, `react-hook-candidates [file]`, `react-large-component-pressure [file]`, `vue-component-duplicates [file]`, `vue-composable-candidates [file]`, `vue-large-view-pressure [file]`, `locality-candidates [symbol-or-file]`, `affected <symbol>`, `change-surface <file>`, `cleanup-plan`, `co-change [file]`, `recent-duplicates`, `doc-drift [doc]`, `unused-params`, `incomplete-migration`, `context <target>`, `drift [module]`, `passthrough-candidates`, `slice-cohesion [symbol]`, `complexity <symbol>`, `dependence-slice <file:line>`, `redundant-reexports`, `duplicate-bodies`, `twin-drift`, `not-implemented`, `decorative-checkers`, `test-quality`, `similar-signatures`, `diff-impact`, `check-deps`, `capabilities`, `config-validate`, `doctor`, `status` |
| Maintain repository/tool state | `reindex`, `augment-sources`, `augment-vue`, `session`, `health`, `install-skills`, `init`, `suppress <id>`, `setup`, `setup-agent`, `uninstall`, `watch` |

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
| `parser-control-dependence` | `execution/returns` | `incoming`, `outgoing`, `both` | `partial` | The selected construct contains the reported return terminal. | A local return terminal does not establish that the containing callable executes. |
| `parser-control-dependence` | `execution/throws` | `incoming`, `outgoing`, `both` | `partial` | The selected construct contains the reported throw terminal. | A local throw terminal does not establish propagation, handling, or callable execution. |
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

### Explicitly unavailable relationship analyses

An unavailable frontier is a relationship class for which no registered analyzer can provide complete evidence. Its absence from a graph is therefore not evidence that the relationship does not exist.

| Frontier | Families | Unavailable capability | Consequence | Recover selected paths with |
|---|---|---|---|---|
| `general-interprocedural-value-flow` | `dataflow` | Whole-program definition-use flow through arbitrary calls and returns is unavailable. | Missing dataflow edges cannot establish that a value never crosses an unmodeled call. | `value-flow`, `dependence-slice`, `inspect`, `code` |
| `heap-aliasing` | `dataflow`, `state` | Heap points-to and cross-instance alias analysis are unavailable. | Missing field or state edges cannot establish that two references never reach the same object. | `value-flow`, `dependence-slice`, `inspect`, `code` |
| `exceptional-flow` | `execution`, `dataflow`, `temporal` | Interprocedural exception propagation and finally completion flow are unavailable. | Normal-path reachability and ordering do not establish behavior after a throw or rejection. | `dependence-slice`, `inspect`, `code` |
| `reflection` | `execution`, `runtime`, `identity`, `dependencies` | Reflective lookup, dynamic loading, and name-computed invocation are unavailable without exact evidence. | Missing static edges cannot establish that a construct is unreachable through reflection. | `search`, `inspect`, `code` |
| `generated-dispatch` | `execution`, `runtime`, `identity` | Dispatch tables or names created only by generated or unavailable source are unavailable. | Missing dispatch edges cannot establish that no generated consumer exists. | `search`, `inspect`, `code` |
| `unsupported-framework-adapters` | `runtime`, `dataflow`, `state`, `temporal` | Framework runtime crossings without a registered source adapter are unavailable. | Missing boundary edges cannot establish that no producer, consumer, state effect, or ordering exists. | `search`, `inspect`, `code` |

### Health

| Command | Description | Cost | Closes disclosed gaps with | Options |
|---|---|---|---|---|
| `review` | Review current TS/JS changes against a Git commit, including new and untracked functions | variable | `inspect`, `code` | `--base <ref>`<br>`--coverage <path>`<br>`-s, --scope <path>`<br>`--include-tests`<br>`--include-references`<br>`--include-generated`<br>`--max-files <n>`<br>`--limit <n>`<br>`--full`<br>`--check`<br>`--json`<br>`--result-only`<br>`--compact` |
| `complexity <symbol>` | Per-symbol complexity: branches, cyclomatic estimate, fan-in/out, callees | variable | `inspect`, `code` | `--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `health` | Find concrete TS/JS complexity, duplication, and dependency issues without an index | variable | - | `-s, --scope <path>`<br>`--full`<br>`--indexed`<br>`--coverage <path>`<br>`--include-tests`<br>`--include-references`<br>`--include-generated`<br>`--max-files <n>`<br>`--limit <n>`<br>`--check`<br>`--baseline`<br>`--write-baseline`<br>`--json`<br>`--result-only`<br>`--compact` |

### Indexing

| Command | Description | Cost | Closes disclosed gaps with | Options |
|---|---|---|---|---|
| `reindex` | Index the codebase and convert to SQLite | variable | - | `-l, --language <lang>`<br>`--force`<br>`--allow-partial`<br>`--allow-expensive-rebuild`<br>`--trust-project-tools`<br>`--install-missing`<br>`--indexer-concurrency <n>`<br>`--json`<br>`--result-only`<br>`--compact` |
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
| `session` | Show evidence already delivered in this agent exploration session | variable | - | `--reset` |
| `inspect` | Batch related searches, symbols, and source locations into one deduplicated source packet | potentially-large | - | `--search <text>`<br>`--symbol <symbol>`<br>`--at <file:line>`<br>`-s, --scope <path>`<br>`-C, --context <n>`<br>`-n, --limit <n>`<br>`--max-units <n>`<br>`--max-characters <n>`<br>`--view <view>`<br>`--allow-large-source`<br>`--allow-large-behavior`<br>`--unit-lines <n>`<br>`--total-lines <n>`<br>`--include <part>`<br>`--evidence-budget <channel=n>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `search <exact-text>` | Count current project text matches and preview a bounded, recoverable identity and source manifest | small | `evidence`, `inspect`, `code` | `-s, --scope <path>`<br>`-C, --context <n>`<br>`-n, --limit <n>`<br>`--full`<br>`--regexp`<br>`-i, --ignore-case`<br>`--json`<br>`--result-only`<br>`--compact` |
| `methods <className>` | List methods of one exactly resolved class; ambiguity and missing targets fail explicitly | bounded | `inspect`, `code` | `--json`<br>`--result-only`<br>`--compact` |
| `refs <symbol>` | Find all files referencing a symbol | bounded | `inspect`, `code` | `--full`<br>`-n, --limit <n>`<br>`--cursor <cursor>`<br>`--json`<br>`--result-only`<br>`--compact` |
| `evidence` | Traverse selected typed relationships around exact referents; recover source separately when needed | bounded | `inspect`, `code` | `--symbol <symbol>`<br>`--at <file:line>`<br>`--search <literal>`<br>`--view <view>`<br>`--edge <family>`<br>`--direction <direction>`<br>`--subtype <subtype>`<br>`--connecting`<br>`--inventory-only`<br>`--fold <id>`<br>`--depth <n>`<br>`--max-edges <n>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `deps <file>` | Files this file depends on (internal) | bounded | `inspect`, `code` | `--json`<br>`--result-only`<br>`--compact` |
| `rdeps <file>` | Files that depend on this file/module | bounded | `inspect`, `code` | `--json`<br>`--result-only`<br>`--compact` |
| `system [module]` | Module files and dependencies; --source adds a first-use inventory, exports, policy and findings without an index | bounded | `inspect`, `code` | `--source`<br>`--include-tests`<br>`--include-references`<br>`--include-generated`<br>`--max-files <n>`<br>`-n, --limit <n>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `surface <module>` | What symbols consumers actually use from this module | bounded | `inspect`, `code` | `--json`<br>`--result-only`<br>`--compact` |
| `imports <file>` | What symbols does this file import? | variable | `inspect`, `code` | `--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `imported-by <symbol>` | Which files import this symbol? | variable | `inspect`, `code` | `--json`<br>`--result-only`<br>`--compact` |
| `outline <file>` | Tree view of symbols in a file, with line ranges | small | `evidence`, `inspect`, `code` | `--signatures`<br>`--json`<br>`--result-only`<br>`--compact` |
| `members <symbol>` | All children of a symbol (methods, fields, nested types) | bounded | `inspect`, `code` | `--json`<br>`--result-only`<br>`--compact` |
| `by-kind <kind>` | Find symbols by SCIP kind (class, interface, enum, function, etc.) | variable | `inspect`, `code` | `-s, --scope <path>`<br>`-n, --limit <n>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `kind-counts` | Histogram of symbol kinds in the codebase | bounded | `inspect`, `code` | `-s, --scope <path>`<br>`--json`<br>`--result-only`<br>`--compact` |
| `hierarchy <symbol>` | Show indexed lexical owners of a symbol (method → class → module) | bounded | `inspect`, `code` | `--json`<br>`--result-only`<br>`--compact` |
| `code <selectors...>` | Read exact definitions, line ranges, or file export surfaces | potentially-large | - | `-C, --context <n>`<br>`--local-calls`<br>`--members <exported|all>`<br>`--json`<br>`--result-only`<br>`--compact` |
| `dependence-slice <file:line>` | Slice one variable occurrence through function-local value and control dependencies | variable | `inspect`, `code` | `--forward`<br>`--variable <name>`<br>`--column <n>`<br>`--depth <n>`<br>`--max-edges <n>`<br>`--json`<br>`--result-only`<br>`--compact` |

### Cleanup

| Command | Description | Cost | Closes disclosed gaps with | Options |
|---|---|---|---|---|
| `dead [scope]` | Find repository-dead code, file-internal symbols, and implicit-usage signals | variable | `inspect`, `code` | `--min-loc <n>`<br>`--include-tests`<br>`--skip-barrels`<br>`--include-members`<br>`--only-dead`<br>`--only-internal`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `unused-imports <file>` | Find imports not referenced in the same file | variable | `inspect`, `code` | `--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `similar [symbol] [other]` | Find heuristic function similarity candidates from callee fingerprints | variable | `inspect`, `code` | `--min-similarity <n>`<br>`-n, --limit <n>`<br>`-s, --scope <path>`<br>`--min-callees <n>`<br>`--cross-file-only`<br>`--plan`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `similar-files [file]` | Find heuristic similar-file candidates from dependency profiles | variable | `inspect`, `code` | `--min-similarity <n>`<br>`-n, --limit <n>`<br>`-s, --scope <path>`<br>`--min-deps <n>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `react-component-duplicates [file]` | Find heuristic duplicated React component structure candidates from JSX tags, props, events, and bindings | variable | `inspect`, `code` | `--min-similarity <n>`<br>`--min-tokens <n>`<br>`-n, --limit <n>`<br>`-s, --scope <path>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `react-hook-candidates [file]` | Find heuristic React hook extraction candidates from shared state, effects, requests, and handlers | variable | `inspect`, `code` | `--min-similarity <n>`<br>`--min-shared-behaviors <n>`<br>`-n, --limit <n>`<br>`-s, --scope <path>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `react-large-component-pressure [file]` | Find heuristic large React component pressure candidates from component lines, JSX structure, and hook behavior | variable | `inspect`, `code` | `--min-component-lines <n>`<br>`--min-file-lines <n>`<br>`--min-jsx-tokens <n>`<br>`--min-behavior-tokens <n>`<br>`-n, --limit <n>`<br>`-s, --scope <path>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `vue-component-duplicates [file]` | Find heuristic duplicated Vue component structure candidates from template tags, bindings, slots, and directives | variable | `inspect`, `code` | `--min-similarity <n>`<br>`--min-tokens <n>`<br>`-n, --limit <n>`<br>`-s, --scope <path>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `vue-composable-candidates [file]` | Find heuristic Vue composable extraction candidates from shared state, effects, requests, and template bindings | variable | `inspect`, `code` | `--min-similarity <n>`<br>`--min-shared-behaviors <n>`<br>`-n, --limit <n>`<br>`-s, --scope <path>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `vue-large-view-pressure [file]` | Find heuristic large Vue view pressure candidates from template, script, style, and external script line counts | variable | `inspect`, `code` | `--min-total-lines <n>`<br>`--min-template-lines <n>`<br>`--min-script-lines <n>`<br>`--min-style-lines <n>`<br>`--review-thresholds`<br>`-n, --limit <n>`<br>`-s, --scope <path>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `locality-candidates [symbol-or-file]` | Find directory-locality and ancestry candidates from consumer ownership | variable | `inspect`, `code` | `-s, --scope <path>`<br>`--min-consumers <n>`<br>`-n, --limit <n>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `cleanup-plan` | Ordered, batched deletion plan: graph-fact dead code plus the cascade candidates it unlocks | variable | `inspect`, `code` | `-s, --scope <path>`<br>`--min-loc <n>`<br>`--max-depth <n>`<br>`--verify`<br>`--patch`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `recent-duplicates` | Similarity candidates in recently added files, oriented by file age; function creation time is not known | variable | `inspect`, `code` | `--window <n>`<br>`--min-similarity <n>`<br>`-n, --limit <n>`<br>`-s, --scope <path>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `doc-drift [doc]` | Stale-doc candidates: code the doc references or co-changed with kept changing after the doc stopped | variable | `inspect`, `code` | `-n, --limit <n>`<br>`--min-coupling <n>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `unused-params` | Speculative-generality candidates: trailing parameters no body ever uses (TS/JS) | variable | `inspect`, `code` | `-s, --scope <path>`<br>`-n, --limit <n>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `drift [module]` | Detect drift candidates: unused imports and declared architecture violations; pass --architecture for boundary context | variable | `inspect`, `code` | `--min-deviation <n>`<br>`--patterns`<br>`--architecture`<br>`-n, --limit <n>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `passthrough-candidates` | Find heuristic passthrough candidates that forward to one callee | variable | `inspect`, `code` | `-s, --scope <path>`<br>`--max-loc <n>`<br>`-n, --limit <n>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `slice-cohesion [symbol]` | Find low-cohesion candidates from backward slices: outputs whose statements never meet are separate local computations | variable | `inspect`, `code` | `-s, --scope <path>`<br>`--min-loc <n>`<br>`--min-statements <n>`<br>`--min-cluster <n>`<br>`-n, --limit <n>`<br>`--scan-limit <n>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `redundant-reexports` | Find re-export candidates with no resolved local source imports or re-exports; external use is unknown | variable | `inspect`, `code` | `-s, --scope <path>`<br>`-n, --limit <n>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `duplicate-bodies` | Find exact duplicate small-body candidates across files | variable | `inspect`, `code` | `-s, --scope <path>`<br>`--max-loc <n>`<br>`--min-loc <n>`<br>`-n, --limit <n>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `twin-drift` | Twin drift candidates: same-name (or near-name) functions across files with diverged bodies | variable | `inspect`, `code` | `-s, --scope <path>`<br>`--min-similarity <n>`<br>`--include-homonyms`<br>`-n, --limit <n>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `not-implemented` | Placeholder candidates with observed consumer or entry-surface evidence: throw-stub, TODO plus default return, or empty body | variable | `inspect`, `code` | `-s, --scope <path>`<br>`-n, --limit <n>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `decorative-checkers` | Checker candidates lacking detected explicit failure syntax; implicit exceptions and property effects are not proved absent | variable | `inspect`, `code` | `-s, --scope <path>`<br>`-n, --limit <n>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `test-quality` | Test-quality candidates: assertion-free it/test bodies, a skipped-test ledger with git-blame age, and mock-echo tests that assert the same literal they stubbed into a mock | variable | `inspect`, `code` | `-s, --scope <path>`<br>`-n, --limit <n>`<br>`--rot-days <n>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `similar-signatures` | Group functions by normalized signature text; shared type identity or responsibility is not established | variable | `inspect`, `code` | `-s, --scope <path>`<br>`--min-loc <n>`<br>`--max-shape-frequency <n>`<br>`-n, --limit <n>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |

### Graph

| Command | Description | Cost | Closes disclosed gaps with | Options |
|---|---|---|---|---|
| `hotspots` | Rank symbols by referencing chunks, or incoming evidence rows when SCIP mentions are unavailable | variable | `inspect`, `code` | `-n, --limit <n>`<br>`-s, --scope <path>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `fan-in [symbol]` | Count files referencing an exact symbol; top JSON rows include exact symbol identity | small | `evidence`, `inspect`, `code` | `-n, --limit <n>`<br>`-s, --scope <path>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `fan-out [file]` | How many external symbols a file uses (or top fan-out across codebase) | variable | `inspect`, `code` | `-n, --limit <n>`<br>`-s, --scope <path>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `coupling [file1] [file2]` | Count shared-symbol coupling between two files, or rank file pairs by that metric | variable | `inspect`, `code` | `-n, --limit <n>`<br>`-s, --scope <path>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `cycles` | Find every cyclic file-dependency component and show one deterministic witness for each | bounded | `inspect`, `code` | `-s, --scope <path>`<br>`--imports-only`<br>`--max-depth <n>`<br>`--json`<br>`--result-only`<br>`--compact` |
| `architecture` | Evaluate project-owned architectural boundaries and dependency rules | bounded | `inspect`, `code` | `-s, --scope <path>`<br>`--json`<br>`--result-only`<br>`--compact` |
| `bottlenecks` | Rank coordination hubs by incoming evidence files × outgoing cross-file callable targets | variable | `inspect`, `code` | `-n, --limit <n>`<br>`-s, --scope <path>`<br>`--min-fan-in <n>`<br>`--min-fan-out <n>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `dependency-depth` | Find longest paths through the SCC-condensed file dependency graph | variable | `inspect`, `code` | `-n, --limit <n>`<br>`-s, --scope <path>`<br>`--min-depth <n>`<br>`--imports-only`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `entrypoints [text]` | Find callables where control may enter from outside the indexed call graph | bounded | `evidence`, `inspect`, `code` | `-s, --scope <path>`<br>`--json`<br>`--result-only`<br>`--compact` |
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

### Exploration

| Command | Description | Cost | Closes disclosed gaps with | Options |
|---|---|---|---|---|
| `context <target>` | Compiler-backed context for a symbol, file, or module | bounded | `inspect`, `code` | `--impact-depth <n>`<br>`-s, --scope <path>`<br>`-n, --limit <n>`<br>`--detail`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |

### Maintenance

| Command | Description | Cost | Closes disclosed gaps with | Options |
|---|---|---|---|---|
| `install-skills` | Install the six agent workflows into Claude Code, Codex, and shared agent roots | variable | - | `--all` |
| `check-deps` | Check whether scip-query and the detected language indexers are runnable | bounded | `inspect`, `code` | - |
| `capabilities` | Report which mapping and analysis capabilities are available in this project | bounded | `inspect`, `code` | `--matrix`<br>`--json`<br>`--result-only`<br>`--compact` |
| `init` | Create a .scipquery.json configuration file for this project | variable | - | - |
| `config-validate` | Validate .scipquery.json, structured suppressions, architecture, and coupling groups | bounded | `inspect`, `code` | `--json`<br>`--result-only`<br>`--compact` |
| `suppress <id>` | Record an accepted finding under .scipquery/suppressions with a required reason | variable | - | `--reason <text>`<br>`--reason-code <code>`<br>`--evidence <kind:referent>`<br>`--check <check>`<br>`--file <path>`<br>`--expires-at <iso>`<br>`--replace <revision>`<br>`--json`<br>`--result-only`<br>`--compact` |
| `doctor` | Diagnose configuration, index freshness, dependencies, and project capabilities | bounded | `inspect`, `code` | `--json`<br>`--result-only`<br>`--compact` |
| `setup` | Install skills, write agent guidance, refresh the index, and report readiness | variable | - | `--guided`<br>`--yes`<br>`--no-skills`<br>`--no-parsers`<br>`--install-missing`<br>`--health`<br>`--dossier-dir <path>`<br>`--json`<br>`--result-only`<br>`--compact` |
| `setup-agent` | Write concise scip-query mapping and cleanup guidance to AGENTS.md and CLAUDE.md | variable | - | - |
| `uninstall` | Remove selected scip-query-owned skills or project guidance | variable | - | `--global`<br>`--project`<br>`--dry-run`<br>`--verbose`<br>`--json`<br>`--result-only`<br>`--compact` |
| `watch` | Watch in the foreground or manage the project refresh service | variable | - | `--daemon`<br>`--status`<br>`--stop`<br>`--prune`<br>`--debounce <ms>`<br>`--cooldown <ms>`<br>`--git-poll <ms>`<br>`--idle-timeout <ms>`<br>`--json`<br>`--result-only`<br>`--compact` |
| `status` | Show index status for this project | bounded | `inspect`, `code` | `--json`<br>`--result-only`<br>`--compact` |

<!-- END GENERATED COMMAND REFERENCE -->
