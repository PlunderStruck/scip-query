---
name: scip-query
description: Use FIRST for codebase work when compiler-resolved identity, runtime boundaries, callers, dependencies, consumers, architecture, change impact, or cleanup relationships can affect the answer. It exposes exact referents, explicit typed-graph projections, and source evidence; it does not infer task relevance.
commands:
  - template: 'scip-query search <text>'
    when: 'Locate exact repository text, a runtime key, or a compiler symbol.'
  - template: 'scip-query outline <file>'
    when: 'Locate compiler-owned constructs in a known file.'
  - template: 'scip-query entrypoints <text>'
    when: 'Locate an external callable root when its entry surface is known.'
  - template: 'scip-query evidence --symbol <symbol> --edge <family> --direction <direction> --depth <n> --max-edges <n>'
    when: 'Project explicitly selected typed relationships from one exact root.'
  - template: 'scip-query inspect --at <file:line> --view behavior'
    when: 'Read connected behavior for a named implementation gap.'
  - template: 'scip-query code <selector>'
    when: 'Read exact source only when syntax itself can change the decision.'
  - template: 'scip-query diff-impact'
    when: 'Map changed symbols and downstream consumers after an edit.'
  - template: 'scip-query architecture'
    when: 'Validate declared structural boundaries.'
  - template: 'scip-query health --full'
    when: 'Run configured cleanup and quality detectors.'
---

# scip-query

<!-- BEGIN GENERATED SKILL COMMANDS -->
## Commands for this skill

| Command | Purpose | Returns | Coverage | When |
| --- | --- | --- | --- | --- |
| `scip-query search <text>` | Count current project text matches and preview a bounded, recoverable identity and source manifest | exact cardinality, bounded identities and source, and scope commands that recover withheld matches | `bounded` | Locate exact repository text, a runtime key, or a compiler symbol. |
| `scip-query outline <file>` | Tree view of symbols in a file, with line ranges | symbol names, nesting, and line ranges | `complete` | Locate compiler-owned constructs in a known file. |
| `scip-query entrypoints <text>` | Find callables where control may enter from outside the indexed call graph | entry symbols with files, confidence, evidence, and indexed caller counts | `complete` | Locate an external callable root when its entry surface is known. |
| `scip-query evidence --symbol <symbol> --edge <family> --direction <direction> --depth <n> --max-edges <n>` | Traverse selected typed relationships around exact referents; recover source separately when needed | batched exact selectors and typed graph relationships; compact endpoints with exact locations and follow-up commands; coverage and recoverable omissions; exact source-recovery command when source was requested with a graph projection; explicit ambiguity failure with exact rerun commands | `bounded` | Project explicitly selected typed relationships from one exact root. |
| `scip-query inspect --at <file:line> --view behavior` | Batch related searches, symbols, and source locations into one deduplicated source packet | one ranked, deduplicated semantic packet plus exact selector cardinality and explicit expansion coverage | `bounded` | Read connected behavior for a named implementation gap. |
| `scip-query code <selector>` | Read exact definitions, ranges with local call closure, or file export surfaces | per-selector resolution, complete definition source, exact ranges with statically attributed same-file call closure, file export surfaces, omitted-local ledgers, and line ranges | `complete` | Read exact source only when syntax itself can change the decision. |
| `scip-query diff-impact` | Map changed symbols and downstream consumers from the current git diff | changed symbols, downstream consumer identities, and impact paths | `bounded` | Map changed symbols and downstream consumers after an edit. |
| `scip-query architecture` | Evaluate project-owned architectural boundaries and dependency rules | boundary coverage and dependency-rule violations | `complete` | Validate declared structural boundaries. |
| `scip-query health --full` | Composite repository health report with React, Vue, and general cleanup findings | health score, findings, priorities, baselines, and coverage notes | `bounded` | Run configured cleanup and quality detectors. |

Use this shortlist first. Run a command's `--help` only when a named uncertainty needs another option.
<!-- END GENERATED SKILL COMMANDS -->

<!-- BEGIN GENERATED EXPLORATION MANUAL -->
### Exploration control manual

The operator chooses the material question and deliberately selects a control. These contracts describe observations; they do not infer task relevance.

| Stage | Control | Question answered | Required input | Returned fact | Evidence ceiling | Does not establish | Cost | Contrast | Close a gap with |
|---|---|---|---|---|---|---|---|---|---|
| locate | `search <exact-text>` | Where does this exact text occur in current project text, and which aligned compiler symbol owns each line? | One exact text literal or deliberately bounded regular expression. | exact cardinality, bounded identities and source, and scope commands that recover withheld matches | Exact current-text cardinality and locations within reported text coverage; compiler ownership only where aligned. | Structural source ranking orders exact matches but does not establish task relevance. A literal co-occurrence does not establish a graph relationship. | `small` | outline: search locates exact text across files; outline enumerates compiler-owned constructs in one known file. | `evidence`, `inspect`, `code` |
| locate | `outline <file>` | What symbols and nesting exist in this file? | One exact current project file path. | symbol names, nesting, and line ranges | Exact compiler-owned constructs and ranges when the file is indexed; no invented semantic overlay. | File ownership and nesting do not establish execution or task relevance. | `small` | search: outline enumerates constructs in one known file; search locates exact text across current project text. code: outline returns identities and ranges; code materializes exact source for selected identities. | `evidence`, `inspect`, `code` |
| locate | `entrypoints [text]` | Which detected external roots or entry-surface candidates match this text? | Optional exact text to filter candidates; otherwise the current indexed repository. | entry symbols with files, confidence, evidence, and indexed caller counts | Source/compiler-grounded entry evidence and indexed caller counts; exported-only candidates remain candidates. | A package-public export or zero indexed callers is an entry candidate, not proof of runtime ingress. Entry classification does not establish that the callable executes. | `bounded` | entry-map: entrypoints locates possible external roots; entry-map traverses static calls from one selected root. search: entrypoints classifies callable roots; search only locates exact text and ownership. | `evidence`, `inspect`, `code` |
| project | `evidence` | Which exact execution, runtime, data, state, temporal, contract, identity, ownership, or dependency relationships surround these referents? Which related source must be read only when graph evidence leaves a named implementation gap? | One or more exact symbol, file:line, or literal roots plus explicit family, direction, depth, and output bound. | batched exact selectors and typed graph relationships; compact endpoints with exact locations and follow-up commands; coverage and recoverable omissions; exact source-recovery command when source was requested with a graph projection; explicit ambiguity failure with exact rerun commands | Typed edges only to each registered provider ceiling within the explicitly selected projection and reported coverage. | The projection does not infer which relationships are relevant to the user task. Reference, dependency, data, state, temporal, contract, and identity edges do not become execution claims. | `bounded` | refs: refs enumerates direct reference sites; evidence traverses explicitly selected typed relationships. call-graph: call-graph specializes in static calls; evidence can combine execution with other selected families. value-flow: value-flow specializes in proved transfers; evidence projects bounded dataflow alongside other families. dependence-slice: dependence-slice computes a program-dependence slice; evidence performs bounded graph projection. | `inspect`, `code` |
| read | `inspect` | Which related source units across several known text, symbol, or location anchors should be read together? | One or more exact text, symbol, or file:line selectors naming the unresolved behavior. | one ranked, deduplicated semantic packet plus exact selector cardinality and explicit expansion coverage | Complete current source for every materialized syntax unit; bounded selector and packet coverage remain explicit. | A source packet does not choose which implementation details are relevant to the user task. A reference mention does not establish executable reachability. | `potentially-large` | code: inspect batches bounded behavior or source gaps; code materializes complete exact source. evidence: inspect reads implementation units; evidence projects typed relationships without source. | - |
| read | `code <selectors...>` | What exact source defines these symbols, ranges, or file surfaces? | One or more exact symbols, file:line ranges, or file paths. | per-selector resolution, complete definition source, exact ranges with statically attributed same-file call closure, file export surfaces, omitted-local ledgers, and line ranges | Exact current source bytes for every resolved selector, with omitted file-local constructs disclosed. | Source materialization does not establish callers, runtime reachability, or task relevance by itself. | `potentially-large` | inspect: code materializes complete exact source; inspect batches bounded behavior or source gaps. outline: code reads selected implementations; outline enumerates file structure without reading every body. | - |

### Relationship question manual

| Material question | Family | Direction | Establishes | Reported strengths | Provider ceilings | Does not establish |
|---|---|---|---|---|---|---|
| Who can call or reach this? | `execution` | `incoming` | Static may-call reachability between resolved program constructs. | `exact`, `derived`, `mixed` | `partial` | A may-call edge does not prove that a runtime invocation occurred. |
| What can this call or reach? | `execution` | `outgoing` | Static may-call reachability between resolved program constructs. | `exact`, `derived`, `mixed` | `partial` | A may-call edge does not prove that a runtime invocation occurred. |
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
<!-- END GENERATED EXPLORATION MANUAL -->

scip-query is a repository exploration surface: an indexed code reader that joins exact current text to compiler-owned constructs, typed relationships, source-grounded runtime handoffs, compressed behavior, and recoverable omissions. The agent chooses what can answer the task; the CLI performs that declared graph operation. It does not infer a relevant subsystem, choose a route, recommend the next symbol, or decide that the user's question is complete.

For an investigation, `$scip-explore` owns the purpose, material-claim ledger, and stopping rule. This skill owns command selection and the meaning of returned evidence. When both are loaded, a suggested command count is an efficiency heuristic only; it never overrides an unresolved material claim with an exact in-scope recovery path.

## Default end-to-end workflow

Privately name the few material facts the request requires. A material fact is a relevant predicate, authorization check, data transformation, hard bound, runtime crossing, durable state change, emitted notification, or returned value that can change the answer. For multi-step mutations preserve external-effect order plus compaction, rollback, or cleanup. For every event, log, or outbox write, preserve its operation kind and record-identity fields. For coordination state lock scope and which read/check/write steps it encloses; for interrupted updates state whether failure is prevented atomically, rolled back, or repaired later.

Run `scip-query capabilities` only when you need the generated control manual or current relationship support; add `--matrix` only for exhaustive provider and language details. Locate concrete referents with the cheapest exact surface: `search` for trustworthy repository text or a runtime key, `outline` for a known file, `entrypoints` for an external callable root, or an exact symbol or file/line already supplied by the task. Any exact returned symbol, location, entry point, or runtime key can begin traversal. There is no anchor-discovery phase and no mandatory first map. Locate independent roots together when the question already implies several participants; once usable roots are known, prefer one batched projection over repeated overlapping locator or source reads.

For each unanswered fact, choose the relationship that can establish it and batch compatible roots into an `evidence` projection. The canonical CLI requires explicit roots, one or more repeated `--edge` families, `--direction`, `--depth`, and `--max-edges`; for example, `scip-query evidence --symbol '<exact>' --edge execution --edge dataflow --direction both --depth 2 --max-edges 32`. Request `--connecting` only for paths between several chosen roots. Normal evidence already includes exact cardinality; use `--inventory-only` only when counts themselves determine the next request or materializing the requested projection would predictably be very large. Do not request `complete`, `all`, or every family merely to discover what exists. Repeat `--symbol`, `--at`, or `--search` to batch roots. Calls and exact runtime handoffs prove executable reachability. Other edge families prove only the relationship they name. Run another projection only when prior evidence exposes a new exact root or relationship needed by a still-unresolved fact.

After the graph packet, make a private evidence ledger with one row per material fact. A row is complete only when it records the condition, outcome, and exact qualifiers carried by evidence: ownership and lifetime; normalization rules; invocation arguments and environment; bounds and defaults; returned fields; loop-stopping conditions; policy or dispatch precedence; and rethrown-versus-rendered interruption behavior. A constant name is not a recovered bound when its value can change the answer. Query completion means only that the requested graph packet is accounted, not that the user's question is answered.

If a named fact still requires implementation behavior, batch `inspect --view behavior` over only the exact symbols or locations capable of establishing it. Treat returned behavior as already-read source. Use `code` only when exact syntax itself can change the decision, never as the primary exploration surface after a successful locator. Repeat a gap-resolution wave only while a named fact remains unresolved and the previous packet exposes an exact in-scope recovery path. Query count and token cost measure efficiency; they never make a known recoverable material fact optional. Before sending, audit the draft itself: evidence seen but left implicit is not recovered, and citations must copy returned file/line identities exactly.

## Evidence and coverage contract

- Exact compiler and runtime-boundary edges are facts only within reported coverage. Derived edges need their displayed source; candidates are leads.
- Read cardinality, omissions, folds, and completion. `accounted` covers the declared bounded projection; `bounded` means eligible relationships were withheld by the output budget; `incomplete` means a selector or provider could not be resolved. None means the user's task is finished.
- Broad search reports exact cardinality and recoverable identities. Narrow by an explicit scope when only that scope can establish the fact.
- An absence claim requires complete coverage for that relationship. A claim about every callsite's arguments requires eligible `trace` or `evidence` callsite support.
- Reflection, generated names, unsupported adapters, and factory or data-mediated dispatch may remain unresolved. Add a distinctive literal, exact participant, or source range only when that disclosed gap matters.

## Spend tokens once

Treat returned behavior and source as already read. Do not reopen the same range, repeat instruction reads, rerun a successful human command as JSON, or enumerate helpers merely because they were surfaced. Batch independent named gaps. Use JSON only for a programmatic consumer. If output says `Continue exactly:`, run it unchanged until transport completes; do not choose a page size in advance.

For tracked text, keep scip-query as the exploration workflow, not a second workflow layered on top of grep. Native tools are for edits, checks, binary content, or one explicitly reported unsupported gap. After edits, run the checks appropriate to the change, then use `diff-impact` when consumers matter and `architecture` when declared boundaries are in scope.
