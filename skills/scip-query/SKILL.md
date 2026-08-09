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

scip-query is a repository exploration surface: an indexed code reader that joins exact current text to compiler-owned constructs, typed relationships, source-grounded runtime handoffs, compressed behavior, and recoverable omissions. The agent chooses what can answer the task; the CLI performs that declared graph operation. It does not infer a relevant subsystem, choose a route, recommend the next symbol, or decide that the user's question is complete.

For an investigation, `$scip-explore` owns the purpose, material-claim ledger, and stopping rule. This skill owns command selection and the meaning of returned evidence. When both are loaded, a suggested command count is an efficiency heuristic only; it never overrides an unresolved material claim with an exact in-scope recovery path.

## Default end-to-end workflow

Privately name the few material facts the request requires. A material fact is a relevant predicate, authorization check, data transformation, hard bound, runtime crossing, durable state change, emitted notification, or returned value that can change the answer. For multi-step mutations preserve external-effect order plus compaction, rollback, or cleanup. For every event, log, or outbox write, preserve its operation kind and record-identity fields. For coordination state lock scope and which read/check/write steps it encloses; for interrupted updates state whether failure is prevented atomically, rolled back, or repaired later.

Run `scip-query status --capabilities` only when you need the generated operation catalogue or current provider support. Locate concrete referents with the cheapest exact surface: `search` for trustworthy repository text or a runtime key, `outline` for a known file, `entrypoints` for an external callable root, or an exact symbol or file/line already supplied by the task. Any exact returned symbol, location, entry point, or runtime key can begin traversal. There is no anchor-discovery phase and no mandatory first map. Locate independent roots together when the question already implies several participants; once usable roots are known, prefer one batched projection over repeated overlapping locator or source reads.

For each unanswered fact, choose the relationship that can establish it and batch compatible roots into an `evidence` projection. The canonical CLI requires explicit roots, one or more repeated `--edge` families, `--direction`, `--depth`, and `--max-edges`; for example, `scip-query evidence --symbol '<exact>' --edge execution --edge dataflow --direction both --depth 2 --max-edges 32`. Request `--connecting` only for paths between several chosen roots. Normal evidence already includes exact cardinality; use `--inventory-only` only when counts themselves determine the next request or materializing the requested projection would predictably be very large. Do not request `complete`, `all`, or every family merely to discover what exists. Repeat `--symbol`, `--at`, or `--search` to batch roots. Calls and exact runtime handoffs prove executable reachability. Other edge families prove only the relationship they name. Run another projection only when prior evidence exposes a new exact root or relationship needed by a still-unresolved fact.

After the graph packet, make a private evidence ledger with one row per material fact. A row is complete only when it records the condition, outcome, and exact qualifiers carried by evidence: ownership and lifetime; normalization rules; invocation arguments and environment; bounds and defaults; returned fields; loop-stopping conditions; policy or dispatch precedence; and rethrown-versus-rendered interruption behavior. A constant name is not a recovered bound when its value can change the answer. Query completion means only that the requested graph packet is accounted, not that the user's question is answered.

If a named fact still requires implementation behavior, batch `inspect --view behavior` over only the exact symbols or locations capable of establishing it. Treat returned behavior as already-read source. Use `code` only when exact syntax itself can change the decision, never as the primary exploration surface after a successful locator. Repeat a gap-resolution wave only while a named fact remains unresolved and the previous packet exposes an exact in-scope recovery path. Query count and token cost measure efficiency; they never make a known recoverable material fact optional. `anchors` and `system-map` are deprecated compatibility views; do not use them in the ordinary locate/project/read workflow. Before sending, audit the draft itself: evidence seen but left implicit is not recovered, and citations must copy returned file/line identities exactly.

## Evidence and coverage contract

- Exact compiler and runtime-boundary edges are facts only within reported coverage. Derived edges need their displayed source; candidates are leads.
- Read cardinality, omissions, folds, and completion. `accounted` covers the declared bounded projection; `bounded` means eligible relationships were withheld by the output budget; `incomplete` means a selector or provider could not be resolved. None means the user's task is finished.
- Broad search reports exact cardinality and recoverable identities. Narrow by an explicit scope when only that scope can establish the fact.
- An absence claim requires complete coverage for that relationship. A claim about every callsite's arguments requires eligible `trace` or `evidence` callsite support.
- Reflection, generated names, unsupported adapters, and factory or data-mediated dispatch may remain unresolved. Add a distinctive literal, exact participant, or source range only when that disclosed gap matters.

## Spend tokens once

Treat returned behavior and source as already read. Do not reopen the same range, repeat instruction reads, rerun a successful human command as JSON, or enumerate helpers merely because they were surfaced. Batch independent named gaps. Use JSON only for a programmatic consumer. If output says `Continue exactly:`, run it unchanged until transport completes; do not choose a page size in advance.

For tracked text, keep scip-query as the exploration workflow, not a second workflow layered on top of grep. Native tools are for edits, checks, binary content, or one explicitly reported unsupported gap. After edits, run the checks appropriate to the change, then use `diff-impact` when consumers matter and `architecture` when declared boundaries are in scope.
