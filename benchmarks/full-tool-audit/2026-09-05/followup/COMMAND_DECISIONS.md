# Command decisions — 2026-09-05

The original 98-command inventory becomes 97 after removing TLA. Each row records the retained purpose and its limits. Test passes establish the listed cases, not a global accuracy percentage. Exact CLI assertions use a hand-written 13-file TypeScript fixture. Framework and lifecycle positive cases use isolated regression fixtures; an empty scanner response is not recall evidence.

| Command | Decision | Evidence in this sweep | Purpose and limits |
| --- | --- | --- | --- |
| `search` | retain | 2 fixture claims; 2 regression files; CLI passed | Exact literal positions and symbol identity, with current-text/freshness coverage. |
| `outline` | retain | 2 regression files; CLI passed | Indexed nesting in one file; omitted/unindexed definitions depend on index coverage. |
| `entrypoints` | retain | 1 fixture claims; 3 regression files; CLI passed | Detected external roots and entry-surface candidates; exported names alone do not establish ingress. |
| `evidence` | retain | 1 fixture claims; 4 regression files; CLI passed | Explicit typed graph projections; exact/candidate strengths and folds constrain every claim. |
| `inspect` | retain | 4 regression files; CLI passed | Batch source needed to explain behavior; source freshness and bounded units remain explicit. |
| `code` | retain | 1 fixture claims; 3 regression files; CLI passed | Exact source bytes and selectors; aligned compiler bindings are a separate fact. |
| `files` | retain | 1 fixture claims; 2 regression files; CLI passed | Current project file inventory, respecting declared exclusions; not just the index. |
| `session` | retain | 1 regression files; CLI passed | Inspect session receipts; requires an explicit session for suppression of repeated evidence. |
| `methods` | retain | 1 fixture claims; 1 regression files; CLI passed | Exactly resolved class methods; ambiguous and missing targets fail explicitly. |
| `refs` | retain | 1 fixture claims; 3 regression files; CLI passed | Reference occurrences, not executable calls; output pages and index coverage matter. |
| `trace` | retain | 1 regression files; CLI passed | Definition plus references; callsite argument claims require their own complete support. |
| `deps` | retain | 1 fixture claims; 3 regression files; CLI passed | Outgoing static file dependencies including resolved imports; not runtime scheduling. |
| `rdeps` | retain | 1 fixture claims; 2 regression files; CLI passed | Reverse static file dependencies; absence limited to indexed/resolved coverage. |
| `system` | retain | 3 fixture claims; 3 regression files; CLI passed | Directory membership and one-hop dependencies; fixed exact directory resolution. |
| `surface` | retain | 2 fixture claims; 3 regression files; CLI passed | Symbols externally referenced through a file/module selection; no ownership verdict. |
| `hotspots` | retain | 2 regression files; CLI passed | Cross-file reference counts; does not measure runtime traffic or contention. |
| `imports` | retain | 1 fixture claims; 2 regression files; CLI passed | Imported bindings resolved to files; source fallbacks disclose their basis. |
| `imported-by` | retain | 2 regression files; CLI passed | Files importing the selected symbol; not every dynamic loader. |
| `members` | retain | 1 fixture claims; 2 regression files; CLI passed | Direct children, including occurrence-only indexed fields; declaration or identifier ranges. |
| `fan-in` | retain | 1 fixture claims; 2 regression files; CLI passed | Number of reference files for exact symbol identities, not call frequency. |
| `fan-out` | retain | 2 regression files; CLI passed | External symbol count for files; module/type references are included. |
| `coupling` | retain | 2 regression files; CLI passed | Shared-symbol counts; candidates for coordination review, not conceptual similarity. |
| `cycles` | retain | 1 fixture claims; 2 regression files; CLI passed | Every cyclic static file component with a witness; not every simple cycle or a runtime failure. |
| `architecture` | retain | 2 fixture claims; 2 regression files; CLI passed | Validate explicit project boundaries, allowances and limits; coverage exposes unmapped files. |
| `bottlenecks` | retain | 2 regression files; CLI passed | Incoming evidence files times outgoing targets; ranking for inspection only. |
| `by-kind` | retain | 2 regression files; CLI passed | Compiler-indexed symbol kinds; source-only symbols depend on provider coverage. |
| `kind-counts` | retain | 2 regression files; CLI passed | Counts of compiler symbol kinds; not a count of domain concepts. |
| `dependency-depth` | retain | 2 regression files; CLI passed | Longest paths after condensing cyclic file groups; not execution depth. |
| `hierarchy` | retain | 2 fixture claims; 1 regression files; CLI passed | Actual indexed lexical ancestors; descriptor-only invented identities removed. |
| `entry-map` | retain | 1 fixture claims; 1 regression files; CLI passed | Static call graph from a detected ingress; rejects ordinary non-entry callables. |
| `call-graph` | retain | 1 fixture claims; 4 regression files; CLI passed | Static may-call evidence with candidate neighbors separate; nested owner and warm cache repaired. |
| `affected` | retain | 1 fixture claims; 3 regression files; CLI passed | Conservative reverse caller/reference closure; an affected consumer may need no edit. |
| `change-surface` | retain | 1 regression files; CLI passed | Consumers, published API and operational roots before a change; explained risk signals. |
| `co-change` | retain | 1 regression files; CLI passed | Git co-change without a dependency edge; historical association is not causation. |
| `incomplete-migration` | retain | 1 regression files; CLI passed | New helpers plus similar unwired sites; migration candidates need source confirmation. |
| `reference-neighborhood` | retain | 2 regression files; CLI passed | Definition/reference sites plus incoming/outgoing calls; deliberately no dataflow claims. |
| `value-flow` | retain | 2 fixture claims; 2 regression files; CLI passed | Proved argument/parameter and bounded value transfers; no general heap/effect proof. |
| `dependence-slice` | retain | 2 fixture claims; 1 regression files; CLI passed | One occurrence through local value/control dependencies; alias/delete gaps now incomplete. No general interprocedural slice. |
| `reference-reachability` | retain | 2 regression files; CLI passed | Legacy caller/reference-owner reachability; retained for graph consumers, not a program slice. |
| `diff-impact` | retain | 2 fixture claims; 3 regression files; CLI passed | Changed symbols and downstream consumers from a Git base; coverage includes attribution gaps. |
| `dead` | retain | 2 regression files; CLI passed | Repository-dead and file-local evidence with implicit-use counterevidence; no automatic deletion. |
| `unused-imports` | retain | 3 regression files; CLI passed | Unused local imported bindings; provider coverage limits absence claims. |
| `isolated` | retain | 1 regression files; CLI passed | Zero discovered references; unindexed/dynamic consumers may still exist. |
| `similar` | retain | 1 regression files; CLI passed | Function callee-fingerprint candidates; shared calls do not prove equivalent behavior. |
| `similar-files` | retain | 1 regression files; CLI passed | Dependency-profile similarity; not duplicate source or equivalent modules. |
| `react-component-duplicates` | retain | 2 regression files; CLI passed | Heuristic JSX structure candidates; confirm behavior, state and binding differences. |
| `react-hook-candidates` | retain | 2 regression files; CLI passed | Shared React state/effect/request structure; extraction requires lifetime review. |
| `react-large-component-pressure` | retain | 1 regression files; CLI passed | Size, JSX and hooks pressure; not proof of too many responsibilities. |
| `vue-component-duplicates` | retain | 1 regression files; CLI passed | Heuristic template structure candidates; confirm scripts, directives and bindings. |
| `vue-composable-candidates` | retain | 1 regression files; CLI passed | Shared Vue state/effect/request patterns; no automatic composable extraction. |
| `vue-large-view-pressure` | retain | 2 regression files; CLI passed | Template/script/style size pressure, including external scripts; not a quality grade. |
| `similar-chains` | retain | 1 regression files; CLI passed | Dependency-flow fingerprint candidates; paths are not identical algorithms. |
| `extract-candidates` | retain | 1 regression files; CLI passed | Contiguous callee-isolated regions; not a proven safe extraction or local slice. |
| `locality-candidates` | retain | 1 fixture claims; 2 regression files; CLI passed | Consumer directory ancestry suggests placement; fixed symbol/file confusion. Business ownership needs review. |
| `cleanup-plan` | retain | 2 regression files; CLI passed | Orders dead-code candidates and possible cascades; each deletion still needs usage verification. |
| `recent-duplicates` | retain | 2 regression files; CLI passed | Recent-to-established duplication candidates; age and similarity do not justify substitution. |
| `doc-drift` | retain | 1 regression files; CLI passed | Code continued changing after related docs; candidate, not proof of false documentation. |
| `unused-params` | retain | 1 regression files; CLI passed | TS/JS trailing parameters unused in bodies; interface/callback contracts can require them. |
| `drift` | retain | 2 regression files; CLI passed | Unused import and explicit boundary violations; does not infer architectural intent. |
| `wrapper-candidates` | retain | 1 regression files; CLI passed | Retain as optional exploration only: single-consumer wrappers can be intentional and useful. |
| `passthrough-candidates` | retain | 1 regression files; CLI passed | Forwarding wrappers with signature checks; layering can justify keeping them. |
| `stale-abstractions` | retain | 1 regression files; CLI passed | Retain as optional exploration only: few consumers do not establish a bad abstraction. |
| `complexity-hotspots` | retain | 1 regression files; CLI passed | LOC times fan-in/out ranking; distinct from cyclomatic/cognitive measurement. |
| `slice-cohesion` | retain | 3 regression files; CLI passed | Disconnected local output computations; only covered local flow can support the candidate. |
| `self-audit` | retain | 2 regression files; CLI passed | Agreement between cheap and richer providers; they can share bugs. Diagnostic, not ground-truth accuracy. |
| `complexity` | retain | 1 fixture claims; 3 regression files; CLI passed | Documented function-local branch/cyclomatic counts and exact/candidate callees; nested scopes repaired. |
| `redundant-reexports` | retain | 1 regression files; CLI passed | Unused barrel routing candidates; public/external API consumers require review. |
| `duplicate-bodies` | retain | 1 fixture claims; 2 regression files; CLI passed | Exact small-body token candidates; identical text can still reference different bindings. |
| `twin-drift` | retain | 2 regression files; CLI passed | Same/near-name divergent bodies; similarity of names does not establish common responsibility. |
| `not-implemented` | retain | 1 regression files; CLI passed | Reachable stub patterns; deliberate defaults/abstract hooks need confirmation. |
| `decorative-checkers` | retain | 1 regression files; CLI passed | Checker-shaped functions lacking known failure exits; naming and external effects limit inference. |
| `test-quality` | retain | 1 regression files; CLI passed | Assertion-free, skipped and mock-echo candidates; custom helpers can encode valid assertions. |
| `similar-signatures` | retain | 1 regression files; CLI passed | Near-identical type shapes; many distinct operations legitimately share a signature. |
| `review` | retain | 4 fixture claims; 5 regression files; CLI passed | Current TS/JS diff metrics/findings, including untracked functions; CRAP requires source-matched measured coverage. |
| `reindex` | retain | 4 regression files | Publish compiler index generations and SQLite; incremental refusal and explicit full fallback are intentional. |
| `augment-sources` | retain | 2 regression files | Add missing source documents; does not manufacture compiler symbols. |
| `augment-vue` | retain | 2 regression files | Add compiler-resolved Vue references through isolated workers; requires the Vue tooling/provider. |
| `stats` | retain | 2 regression files; CLI passed | Index statistics; they describe the indexed generation, not all current source. |
| `context` | retain | 2 regression files; CLI passed | Aggregate known symbol/file/module evidence with reusable consumer reads; no inferred task relevance. |
| `health` | retain | 2 fixture claims; 5 regression files; CLI passed | First-use TS/JS source scan for measured complexity, token duplicates and imports; no general conceptual ownership verdict. |
| `install-skills` | retain | 6 regression files | Install owned guidance files; verify through temporary roots, never user-global audit mutation. |
| `check-deps` | retain | 7 regression files; CLI passed | Report executable/provider readiness; not semantic accuracy. |
| `capabilities` | retain | 3 regression files; CLI passed | Report provider support and coverage; available does not mean complete analysis. |
| `init` | retain | 2 regression files | Write project configuration; existing configuration must be preserved. |
| `config-validate` | retain | 1 fixture claims; 3 regression files; CLI passed | Validate configuration, architecture and suppression structure; no proof of written justification. |
| `suppress` | retain | 4 regression files | Record reviewed exceptions with reason and target-content hashes; all target files required for automatic acceptance. |
| `doctor` | retain | 7 regression files; CLI passed | Diagnose configuration, tools and freshness; readiness diagnostics, not correctness certification. |
| `setup` | retain | 7 regression files | Compose install/guidance/index readiness; temporary-root regression coverage, not a global install trial. |
| `setup-agent` | retain | 2 regression files | Write marked project guidance without replacing unrelated text. |
| `uninstall` | retain | 6 regression files | Remove selected tool-owned guidance/installations; preserve unrelated user content. |
| `watch` | retain | 4 regression files | Foreground/background refresh lifecycle and cancellation; OS/process behavior remains environment-dependent. |
| `status` | retain | 2 regression files; CLI passed | Index generation/freshness status; not a repository quality summary. |
| `tla` | remove | 7 regression files | Removed: model generation, TLA verification and trace conformance are outside exploration and change-quality scope. |
| `continue` | retain | 2 regression files | Immutable output cursor transport; expire/missing/page behavior covered independently. |
| `hook-architecture-stop` | retain-internal | 2 regression files | Internal hook checks explicit architecture after source changes; no extra analytic capability. |
| `__diff-impact-batch` | retain-internal | 3 regression files | Internal isolated impact worker protocol; not a user-facing analysis choice. |
| `__health-phase` | retain-internal | 3 regression files | Internal isolated health worker protocol; not a user-facing analysis choice. |
| `__health-semantic-prewarm` | retain-internal | 4 regression files | Internal semantic cache prewarm protocol; not a separate detector. |
