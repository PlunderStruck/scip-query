# Descriptor-owned command contracts

Use this catalog when choosing between commands or deciding whether a result
can support a complete claim. Each row is generated from the CLI descriptor
that also drives help and JSON metadata. “Default coverage” describes the
normal invocation; the actual JSON result remains authoritative when options,
scope, runtime capability, or pagination change it.

<!-- BEGIN GENERATED AGENT CONTRACT CATALOG -->
| Command | Questions it answers | Returns | Default coverage |
| --- | --- | --- | --- |
| `scip-query reindex` | Can the repository index be refreshed, and which language shards succeeded? | index generation, shard statuses, reuse diagnostics, and failures | `complete` |
| `scip-query augment-sources` | Can source files omitted by upstream indexers be added to the index? | added document counts and augmentation status | `complete` |
| `scip-query augment-vue` | Can Vue SFC references be compiler-resolved and added to the index? | Vue augmentation counts, project, and diagnostics | `complete` |
| `scip-query stats` | How large and fresh is the current index? | document, symbol, definition, reference, size, and build-time totals | `complete` |
| `scip-query files <pattern>` | Which indexed files match this text pattern? | matching file paths | `complete` |
| `scip-query methods <className>` | Which methods belong to this class? | method names and line ranges | `complete` |
| `scip-query refs <symbol>` | Which files reference this symbol?; Is this symbol used anywhere, or only defined? | referencing file paths; reference line numbers grouped by file | `bounded` |
| `scip-query trace <symbol>` | Where is this symbol defined, and everywhere is it referenced? | definition sites with source and signature; referencing files with line numbers | `bounded` |
| `scip-query deps <file>` | Which internal files does this file depend on? | dependency file paths | `complete` |
| `scip-query rdeps <file>` | Which internal files depend on this file? | reverse-dependency file paths | `complete` |
| `scip-query system <module>` | What is in this module?; What does this module depend on, and what depends on it? | module file paths; exported symbols with line ranges; internal dependencies; reverse dependencies | `complete` |
| `scip-query surface <module>` | Which exported symbols do external consumers actually use? | consumer paths and consumed symbol identities | `complete` |
| `scip-query dead [scope]` | Which symbols have no repository use or only file-internal use? | symbol identities, ranges, liveness classes, and evidence | `bounded` |
| `scip-query hotspots` | Which symbols are the largest reference choke points? | ranked symbol identities with reference and file counts | `bounded` |
| `scip-query imports <file>` | Which symbols does this file import? | imported symbol identities and source files | `bounded` |
| `scip-query imported-by <symbol>` | Which files import this symbol? | importing file paths | `complete` |
| `scip-query unused-imports <file>` | Which imports in this file are unused? | import symbol identities and source ranges | `bounded` |
| `scip-query outline <file>` | What symbols and nesting exist in this file? | symbol names, nesting, and line ranges | `complete` |
| `scip-query members <symbol>` | Which members or nested symbols belong to this symbol? | child symbol identities, kinds, and ranges | `complete` |
| `scip-query fan-in [symbol]` | How many files reference this symbol, or which symbols have highest fan-in? | exact symbols with referencing-file counts | `bounded` |
| `scip-query fan-out [file]` | How many external symbols does this file use, or which files have highest fan-out? | files with external-symbol counts | `bounded` |
| `scip-query coupling [file1] [file2]` | How strongly are these files coupled, or which pairs are most coupled? | file pairs with coupling evidence and scores | `bounded` |
| `scip-query cycles` | Which file dependency cycles exist? | dependency-cycle file chains | `bounded` |
| `scip-query architecture` | Does the repository obey its declared architecture boundaries? | boundary coverage and dependency-rule violations | `complete` |
| `scip-query bottlenecks` | Which files are high-connectivity coupling hubs? | ranked files with fan-in and fan-out counts | `bounded` |
| `scip-query isolated` | Which symbols are disconnected from the repository reference graph? | isolated symbol identities and files | `bounded` |
| `scip-query by-kind <kind>` | Which symbols have this SCIP kind? | symbol identities, kinds, files, and ranges | `bounded` |
| `scip-query kind-counts` | How many indexed symbols exist for each kind? | symbol-kind counts | `complete` |
| `scip-query deep-chains` | Which dependency chains are deepest and riskiest? | ranked component chains with depth, risk, and recommendation | `bounded` |
| `scip-query hierarchy <symbol>` | What lexical ownership chain contains this symbol? | ancestor symbol identities and depths | `complete` |
| `scip-query call-graph <symbol>` | Who calls this symbol and what does it call? | caller and callee symbol identities with files | `bounded` |
| `scip-query similar [symbol] [other]` | Which callable resembles this one, or how similar are these two? | symbol pairs, similarity scores, and shared evidence | `bounded` |
| `scip-query similar-files [file]` | Which files have similar callable structure? | file pairs with similarity scores and shared symbols | `bounded` |
| `scip-query react-component-duplicates [file]` | Which React components appear to duplicate one another? | component pairs with structural similarity evidence | `bounded` |
| `scip-query react-hook-candidates [file]` | Which repeated React logic could become a custom hook? | component groups and shared hook-shaped behavior | `bounded` |
| `scip-query react-large-component-pressure [file]` | Which React components have evidence of being too large or overloaded? | component identities with size and responsibility pressure | `bounded` |
| `scip-query vue-component-duplicates [file]` | Which Vue components appear to duplicate one another? | component pairs with structural similarity evidence | `bounded` |
| `scip-query vue-composable-candidates [file]` | Which repeated Vue logic could become a composable? | component groups and shared composable-shaped behavior | `bounded` |
| `scip-query vue-large-view-pressure [file]` | Which Vue views have evidence of being too large or overloaded? | view identities with size and responsibility pressure | `bounded` |
| `scip-query similar-chains` | Which transitive chains of similar symbols suggest repeated designs? | similarity-connected symbol chains and scores | `bounded` |
| `scip-query extract-candidates` | Which cohesive code regions are strong extraction candidates? | symbol identities with cohesion, reuse, and extraction evidence | `bounded` |
| `scip-query locality-candidates [symbol-or-file]` | Which definitions live far from most of their consumers? | symbols, current homes, consumer locality, and suggested homes | `bounded` |
| `scip-query affected <symbol>` | Which downstream symbols could break if this symbol changes? | affected symbol identities, files, and traversal depths | `bounded` |
| `scip-query change-surface <file>` | What public surface and consumers make this file risky to change? | defined symbols, external consumer counts, and risk levels | `bounded` |
| `scip-query cleanup-plan` | What code can be deleted safely, and in what dependency order? | ordered cleanup batches, evidence, and optional verification outcomes | `bounded` |
| `scip-query cleanup-apply` | Can a compiler-verified cleanup batch be applied to this working tree? | applied files, deletions, verification, and refusal reasons | `bounded` |
| `scip-query co-change [file]` | Which files repeatedly change together without a declared dependency? | file pairs, co-change counts, confidence, and history context | `bounded` |
| `scip-query recent-duplicates` | Did recent code reimplement established code? | recent and established symbol pairs with similarity evidence | `bounded` |
| `scip-query doc-drift [doc]` | Which documentation may be stale relative to changing code? | document paths, coupled code subjects, and history evidence | `bounded` |
| `scip-query unused-params` | Which trailing parameters are never read by their bodies? | candidate parameters with callable and file identities | `bounded` |
| `scip-query diff-gate` | Does my current diff introduce something this repo blocks on?; What must I fix or explicitly accept before reporting the work done? | blocking findings with check id, message, and remediation; advisory findings; root-cause groups; changed file and symbol counts; process exit status (1 when blocking findings exist) | `bounded` |
| `scip-query incomplete-migration` | Did this diff leave a helper extraction only partly migrated? | new helpers and similar unmigrated call sites | `bounded` |
| `scip-query tla <operation> [spec]` | Does this TLA+ model and code mapping agree, or can the requested model artifact be generated? | checker status, conformance findings, trace coverage, or generated artifact paths | `bounded` |
| `scip-query plan-context <target>` | What must I know before editing this target?; Who consumes it, and what breaks if I change it?; Has this target historically changed together with anything else? | definitions and references; callers and callees; dataflow producers and consumers; backward and forward slices; affected symbols; change-surface risk; dependencies and reverse dependencies; module files and exports; external surface use; complexity; churn; co-change partners; active suppressions | `bounded` |
| `scip-query diff-impact` | Which symbols changed in this diff and which downstream consumers are affected? | changed symbols, downstream consumer identities, and impact paths | `bounded` |
| `scip-query drift [module]` | Where has a module or abstraction drifted across parallel implementations? | drifted symbol families, files, and evidence | `bounded` |
| `scip-query wrapper-candidates` | Which callables are unnecessary forwarding wrappers? | wrapper identities, targets, and forwarding evidence | `bounded` |
| `scip-query passthrough-candidates` | Which parameters are passed through layers without local use? | parameter paths across call chains | `bounded` |
| `scip-query stale-abstractions` | Which abstractions no longer earn their indirection? | abstraction identities with usage, change, and replacement evidence | `bounded` |
| `scip-query complexity-hotspots` | Which symbols combine high complexity with high change pressure? | ranked symbols with complexity and churn evidence | `bounded` |
| `scip-query self-audit` | How accurate are the fast evidence paths on a sample? | sample coverage, agreement scores, and disagreements | `sampled` |
| `scip-query health` | What are the highest-priority verified health problems in this codebase? | health score, findings, priorities, baselines, and coverage notes | `bounded` |
| `scip-query bench` | How fast are indexing and selected commands under this benchmark matrix? | timings, command outcomes, environment, and optional profiles | `sampled` |
| `scip-query work-audit <profile>` | Which repeated computations in this profile waste the most measured time? | ranked repeated-work groups, counts, and avoidable duration | `bounded` |
| `scip-query convergence <symbol1> <symbol2>` | How should these two similar symbols converge? | deprecated alias result for a two-symbol similarity plan | `bounded` |
| `scip-query code <symbol>` | What is the compiler-resolved definition source for this symbol? | definition identity, source, and line range | `complete` |
| `scip-query complexity <symbol>` | How structurally complex and connected is this symbol? | LOC, branch, complexity, callee, fan-in, and fan-out counts | `bounded` |
| `scip-query dataflow <symbol>` | What defines, uses, produces, and consumes this symbol? | definition sites, usage sites, producer symbols, and consumer symbols | `bounded` |
| `scip-query slice <symbol>` | What transitively affects this symbol, or what does it affect? | connected symbols with relationship and depth | `bounded` |
| `scip-query install-skills` | Which scip-query skills were installed, updated, skipped, or conflicted? | skill target paths and install outcomes | `complete` |
| `scip-query setup-hooks` | Were project-local agent hooks installed or removed safely? | hook config targets, changes, skips, and warnings | `complete` |
| `scip-query check-deps` | Which scip-query and language-indexer dependencies are runnable? | dependency readiness statuses and remediation | `complete` |
| `scip-query capabilities` | Which evidence and verification capabilities are available here? | capability matrix with availability and reasons | `complete` |
| `scip-query capability-matrix` | Which evidence and verification capabilities are available here? | deprecated alias of the capability matrix | `complete` |
| `scip-query redundant-reexports` | Which re-exports add no useful API boundary? | re-export sites, original definitions, and consumer evidence | `bounded` |
| `scip-query duplicate-bodies` | Which callable bodies are exact duplicates? | callable groups with exact normalized-body identity | `bounded` |
| `scip-query twin-drift` | Which same-concept twin implementations have drifted? | twin symbol pairs, history, and divergence evidence | `bounded` |
| `scip-query twin-ab <symbolA> <symbolB>` | How do these two twin implementations differ in structure and behavior? | side-by-side symbol evidence and divergence classification | `complete` |
| `scip-query not-implemented` | Which callables are placeholders rather than real implementations? | callable identities and placeholder evidence | `bounded` |
| `scip-query decorative-checkers` | Which validation checks cannot meaningfully fail? | checker identities, call sites, and decorative behavior evidence | `bounded` |
| `scip-query test-quality` | Which tests have weak assertions or poor production-code reach? | test identities with assertion and reachability evidence | `bounded` |
| `scip-query similar-signatures` | Which callables have suspiciously similar signatures? | callable pairs with signature similarity evidence | `bounded` |
| `scip-query init` | Can a starter scip-query configuration be created for this project? | configuration path and creation outcome | `complete` |
| `scip-query config-validate` | Is this project configuration valid and internally consistent? | validation diagnostics with config paths | `complete` |
| `scip-query suppress <id>` | Can this accepted finding be recorded with an auditable reason? | suppression identity, path, scope, and expiry | `complete` |
| `scip-query effectiveness` | What handling outcomes has diff-gate observed, and what authority produced those observations? | per-check caught, fixed, suppressed, unresolved, provenance, and resolution-vs-suppression telemetry | `complete` |
| `scip-query doctor` | Why is scip-query unhealthy or unavailable in this project? | config, freshness, dependency, and capability diagnostics | `complete` |
| `scip-query setup` | Can scip-query be bootstrapped end to end in this project? | setup step outcomes, files, capabilities, smoke tests, and warnings | `complete` |
| `scip-query setup-agent` | Can project agent guidance and optional git enforcement be seeded? | written, unchanged, and skipped agent files or hooks | `complete` |
| `scip-query setup-ci` | Can a CI workflow enforce reindex and diff-gate on pull requests? | workflow path, rendered content, and write outcome | `complete` |
| `scip-query uninstall` | Which scip-query-owned integrations can be removed without touching user-owned files? | removed, retained, skipped, and dry-run targets | `complete` |
| `scip-query watch` | What is the watcher doing, or can its background service be started or stopped? | watcher/service state, generation, activity, and errors | `complete` |
| `scip-query status` | Is the index fresh, complete, and usable for this project? | freshness, generation, language shards, watcher, and optional capabilities | `complete` |
<!-- END GENERATED AGENT CONTRACT CATALOG -->
