# scip-query — Critical Review, Round 2

Date: 2026-07-01 · Companion to [round 1](2026-07-01-critical-review.md) and the [remediation plan](../plans/2026-07-01-review-remediation.md) currently being executed.

Scope: the areas round 1 did not reach — the graph/quality/navigation query internals, the multi-language and indexing layer, the React/Vue detector family, and packaging. All audits were **read-only** and deliberately avoided files the in-flight remediation is rewriting (diff-gate, symbol-lookup, cleanup-verify, agent-hooks, config, setup, self-audit), so these findings remain valid on top of that work. Where the remediation already covers something observed here, it's noted. Method: source reads with file:line verification plus live CLI runs on this repo (including direct tree-sitter/compiler probes for the frontend findings).

---

## Executive summary — round 2's biggest findings

1. **`complexity`'s cyclomatic estimate is inflated ~65–70%** — overlapping regexes triple-count `else if`; reproduced twice against manual McCabe counts. (§1.1)
2. **`complexity-hotspots`' top-5 on this repo is interface properties, not code** — SCIP `term` symbols pass the function-like filter and inherit bogus 179-line ranges; the score contains no branch counts at all despite the name. (§1.2)
3. **`drift`'s hand-written layer policy is stale: 73% of its current findings are false positives tagged `policyBasis: explicit`** — `src/tla/` was never added to the allowed-deps map, and unlisted layers default to "violation" at the highest confidence tier. (§1.3)
4. **The capability matrix is a static hand-authored table, not a runtime probe** — tree-sitter can fail to load (the documented optionalDependency degradation) and every non-TS language's callable/call-site facts silently return `null` while `capability-matrix` keeps reporting `available`. The matrix answers "did we configure support," not "does support work on this machine." (§2.1–2.2)
5. **The gitignore filter never reads nested `.gitignore` files — contradicting its own code comments** — a monorepo package's ignored `dist/` leaks into every query and detector. (§2.3)
6. **React detectors are blind to class components and HOC-returned components** — no `class_declaration` branch exists in the profiler, and named components nested inside any function are dropped rather than profiled. Legacy and HOC-heavy React codebases get silent false negatives from all three React commands. (§3.1)
7. **Vue `{{ interpolation }}` is never tokenized** — templates differing only in interpolated text look identical; interpolation-heavy templates can vanish below token minimums. (§3.2)
8. **An unparameterized scope string crashes 7 commands** — `coupling -s "o'brien"` → SQL syntax error; scope is interpolated into `LIKE` in coupling/hotspots/fan/drift/file-dep-graph/redundant-reexports while two other files do it correctly with bound params. (§1.4)
9. **`fan-in` counts the symbol's own defining file; `fan-out` excludes it** — reproduced (13 vs 12 real consumers); skews `bottlenecks`' fanIn×fanOut ranking. (§1.5)
10. **44.5 MB npm package, of which 39 MB is Windows-only scip binaries** (win32-x64 + win32-arm64 in `vendor/scip`) that every macOS/Linux user downloads and can never execute — 88% of the package. (§4.1)

The round-2 meta-pattern complements round 1's ("honesty is artisanal, not architectural"): **the same concept implemented twice with silently different semantics** — similarity (`similar` vs `convergence` report different numbers for the same pair), citation tiering (diff-gate got the classifier fix, `doc-drift` didn't), self-file exclusion (fan-in vs fan-out), capability tiers (Clojure vs Dart labeled differently for identical implementation grades), and six frontend files duplicating whole function families under identical names with drifted thresholds. For a tool whose pitch is "evidence," internal metric inconsistency is the most corrosive bug class it has.

---

## 1. Metric integrity: graph and quality commands

### 1.1 `complexity` inflates cyclomatic estimates ~65–70%
`src/queries/quality/complexity.ts:113-125` — branch regexes aren't mutually exclusive: `/\bif\b/`, `/\belse\s+if\b/`, and `/\belse\b/` all match the same `else if`, triple-counting every chained branch; the ternary regex also false-positives on regex literals and `?.`. Reproduced: manual McCabe ≈15 vs tool 25 on `countBranches`; ≈19 vs 32 on `convergence()`. No tests. **Fix**: AST walk (the repo already ships `source/ast.ts`) or de-overlap the patterns; add a test against a hand-counted fixture.

### 1.2 `complexity-hotspots` ranks interface properties as hotspots
`src/queries/quality/complexity-hotspots.ts:25,44` — score = `(loc/50)*(fanIn/5)*max(fanOut/5,1)`, no branch counting despite the command name; and `isFunctionLikeSymbol` (`src/symbols/symbol-parser.ts:309-311`) admits SCIP `term` symbols, so this repo's live top-5 is interface properties with inherited `loc: 179, fanOut: 0` ranges. No tests. **Fix**: exclude property/field terms; either fold in 1.1's real branch counts or rename to `size-hotspots`.

### 1.3 `drift`'s layer policy rotted — highest-confidence tier, 73% false
`src/queries/cleanup/drift-policy.ts:46-77` — the hand-written `allowed` map predates `src/tla/` (added Jun 30); unlisted layers default to violation (`allowed[from]?.has(to) ?? false`), so 11 of 15 live findings are legitimate deps like `tla/conformance.ts → storage/db.ts`, all tagged `policyBasis: explicit`. An agent trusting "explicit = high confidence" is misled hardest. **Fix**: add the missing entries + a regression test asserting every top-level `src/` dir has a policy row (this failure mode will recur on every new directory otherwise).

### 1.4 Scope strings interpolated into SQL in 7 files
`coupling.ts:72`, `hotspots.ts:24`, `fan.ts:114,149`, `drift.ts:282`, `file-dep-graph.ts:199`, `redundant-reexports.ts:108` — reproduced crash with `coupling -s "o'brien"`. `affected.ts:160` and `definition-catalog.ts` show the correct bound-parameter pattern. Not a security issue (local CLI), but a robustness bug on any path containing `'`. **Fix**: `LIKE ?` everywhere.

### 1.5 fan-in/fan-out disagree about self-references
`src/queries/graph/fan.ts:22-29` vs `:43-72`; `bottlenecks.ts:64` — fan-in includes the defining file's own references (reproduced: 13 reported vs 12 real cross-file consumers), fan-out excludes them; `hotspots.ts:35`'s fileCount also self-counts. Overstates blast radius and skews bottleneck scores. **Fix**: exclude the defining document in fan-in/topFanIn/bottleneckRowFor.

### 1.6 Assorted (med/low)
- **`doc-drift` never inherited diff-gate's citation-kind classifier** (`doc-drift.ts:278-281` vs `diff-gate-doc-policy.ts:10-62`): the repo's own validation ledger records fixing the README JSON-example false positive — for diff-gate only. Standalone doc-drift still reports it as its top finding at `actionTier: direct`. Share the classifier.
- **`convergence` contradicts `similar`**: plain Jaccard (0.667) vs TF-IDF-weighted cosine (0.559) for the same pair, both presented as "similarity." ~90% of convergence's payload duplicates `similar` fields; its unique content is seven canned sentences. Fold into `similar --plan` or delete.
- **`cycles --max-depth` silently truncates**: bounds DFS depth (not cycle length as the help text says) and "no circular dependencies found" carries no truncation signal. Emit `truncated: true`.
- **`files` glob is fake**: `*` and `**` both become SQL `%` (`files.ts:14-22`), so `src/queries/*.ts` returns the whole subtree; no `[...]`/`{a,b}`. Post-filter with a real glob.
- **`locality-candidates` ranks its least actionable results first** (`locality-candidates.ts:700-711`): consumer count × 10 vs a flat −8 penalty for the "suggested home withheld" tier puts the two withheld-recommendation files at the top.
- **Zero tests** on: convergence, doc-drift (+citation context/terms), complexity, complexity-hotspots, wrapper-candidates, cycles (dedicated), hierarchy, and `bench` — whose cold-index backup/rename/restore logic (`command-handlers.ts:343-413`) could corrupt a user's cache dir on a mid-run crash with no test guarding the restore path.

## 2. The multi-language reality gap

### 2.1 Capability matrix is asserted, not probed
`src/runtime/project-readiness.ts:84-108` (`SOURCE_FACT_SUPPORT`) is a hardcoded status/reason table. `src/source/ast/ast-runtime.ts:22-32` silently catches tree-sitter load failure and caches `parserUnavailable = true`; **nothing in the runtime/capability code ever reads that flag** (zero grep hits). On a machine where the optional native modules failed to install — the exact degradation the package.json comment celebrates handling gracefully — the matrix still reports `sourceFacts: available`, `detectors: available` for every language.

### 2.2 …and without tree-sitter, non-TS source facts are empty, not degraded
`src/source/source-facts.ts:70-71`: `getAst()` returns `null` → the whole facts builder returns `null` — no callables, call sites, or identifiers. The "regex fallback" documented in `ast-core.ts:1-6` exists only for the *import* path (`javascript-imports.ts:31`). So every cleanup detector that consumes source facts for non-TypeScript languages silently returns empty results while claiming availability. **Fix**: capability output must probe `getParserCtor()`/grammar load per language and downgrade to `partial`/`unavailable`; detectors should disclose "source facts unavailable (tree-sitter missing)" in output.

### 2.3 Nested `.gitignore` files are never read
`src/source/gitignore-filter.ts:60-85` walks **upward** to parents only, while the comments at `:21` and `:56-58` explicitly claim nested-subdirectory support. A monorepo package's own `.gitignore` (e.g. `packages/foo/dist/`) is silently dropped — git-ignored build artifacts leak into queries and detectors. Tests cover only a single root file, no nested or negation cases. (Pattern semantics themselves are correctly delegated to the `ignore` library — the bug is scope, not parsing.)

### 2.4 Inconsistent capability labeling: Clojure vs Dart
Two languages at the same implementation tier get different labels: Dart is honestly `status: 'partial'` / "regex-only" (`project-readiness.ts:101`), while Clojure is `available` with no qualifier (`:103-107`) despite `registry.ts:110-115` labeling its imports `regex-only` and `ast-runtime.ts:88-90` refusing to even attempt a tree-sitter grammar for it. (Fairness note: Clojure's hand-built s-expression reader in `clojure-facts.ts` is genuinely better than regex-grade — the deeper issue is that evidence-quality policy is encoded in **two** independent tables that already disagree.) Also suspected: the `#?(:clj …)` reader-conditional require idiom is dropped by the ns parser (`clojure.ts:356-358` doesn't treat `#` as a reader-macro prefix) — common in `.cljc`, untested.

### 2.5 Vue support is three different code paths with three capability envelopes
`vue-script.ts:11-23` (feeds generic AST facts) takes `scriptSetup ?? script` — a component with both blocks loses the non-setup block entirely — and bails to `null` on any `src=` external script. A second, better extractor (`vue-sfc.ts:96-101`) handles both blocks and relative `src=`; a third path (`augment-vue.ts`, Volar-based) has its own envelope. "Does scip-query understand my Vue component" has a different answer per query path.

### 2.6 Test coverage: 7 of ~11 non-TS languages have no parser accuracy tests
Only Python and Clojure have dedicated accuracy suites; ruby/php/dart/dotnet/jvm/c-like are exercised only incidentally. Also confirmed here: the `scip-clojure` indexer has `installMethods: []` (`indexers.ts:130`) and no npm package exists — a Clojure repo without a manually built binary gets source-fallback-only evidence (the degradation itself is honest; the README's install story is not — round 1 finding, now with the mechanism located).

### 2.7 Suspected: per-project `hasIndexedGraph` flag applied per-language
`project-readiness.ts:215-219` — in a TS+Clojure repo where only TS was ever indexed, Clojure's row can claim a partial indexed graph that never existed. Not reproduced.

## 3. The frontend detector family (React/Vue)

### 3.1 React: class components and HOC-returned components are invisible
`src/source/react-profile.ts:346-380` matches only `function_declaration` and `variable_declarator` — no `class_declaration` branch exists (grammar handles it fine; verified by direct tree-sitter probe). And `walk()` discards any named component that has a function ancestor, so `function withAuth(C) { return function Authed(props) {…} }` never profiles `Authed`. All three React commands give silent false negatives on legacy/class and HOC/render-prop codebases — historically the most duplication-prone React code there is.

### 3.2 Vue: `{{ interpolation }}` contributes nothing
`vue-template.ts:296-307` skips every non-ELEMENT child (TEXT/INTERPOLATION/COMMENT). Templates differing only in interpolated data fingerprint as identical; interpolation-heavy templates can fall below `minTokens` and disappear. No fixture covers `{{ }}`.

### 3.3 Fragment asymmetry + dead code
Shorthand `<>…</>` yields a name-less `jsx_element` → `recordJsxElement` (react-profile.ts:463-476) skips it entirely, while `<React.Fragment>` adds a `component:React.Fragment` token — semantically identical code, different fingerprints. The `jsx_fragment` branch at `:454-455` is dead code: this grammar never emits that node type.

### 3.4 The weakest pair has the least honesty
`react-component-duplicates`/`vue-component-duplicates` results carry **no** `evidenceClass`/`actionTier`/`recommendation` fields — unlike hook/composable-candidates, which classify domain-vs-generic evidence. Their gates count generic tokens only: two unrelated forms sharing `div/span/button/input` clear the React `shapeLike >= 4` bar with zero shared component names and present at full confidence. Compounding dilution: `prop:spread` collapses all spreads to one shared token (`:491-493`); `identifiersInText` (`:642-649`) floods fingerprints with `item/index/id/e` (6-word stoplist); `jsx:conditional` fires on `?.` and `??` (`:499`); and `behaviorSimilarity` = `max(jaccard, overlap-coefficient)` (`frontend-behavior-evidence.ts:79-83`) reports 100% when a 6-token profile is a subset of an 80-token one.
Thresholds (0.62 / 0.45 / minTokens 8 / minShared 6, plus React's `>=4` vs Vue's `>=3` overlap gates) are uncommented and divergent between frameworks with no recorded rationale.

### 3.5 Accidental variation, at home
Beyond the three shared helpers, the React/Vue pairs duplicate whole function families under identical names with hand-drifted bodies: `hasMeaningfulBehaviorOverlap`, `compareProfiles`, `behaviorReason`, `pressureResult`, `dominantPressure`, `pressureKindsFor`, `recommendationFor` — the precise pattern (`same concept, same name, silently different thresholds`) the tool's own maintainability skills hunt in user code. A shared `PressureAxis` + `overlapGate` abstraction would collapse most of it and let component-duplicates adopt the evidence-classification layer the other four already have.
Test gaps: most pressure kinds and the `domain-behavior` evidence class (the "yes, extract this" signal the README advertises) are asserted nowhere.

## 4. Packaging and repo hygiene

### 4.1 88% of the npm package is Windows binaries
`npm pack --dry-run`: 44.5 MB unpacked, 502 files; `vendor/scip` = 39 MB of `win32-x64` + `win32-arm64` scip builds shipped to every platform. **Fix**: platform-specific optional packages (the esbuild pattern) or on-demand fetch with checksum (the `tla fetch-tools` pattern from the remediation plan).

### 4.2 Committed generated artifacts
`reports/{accuracy,debloat,verification}` are tracked at the repo root — another instance of round 1's artifact-sprawl finding (skills write to five different output roots), plus the stale root `index.db`/`index.scip`/`0.10.1.tgz` clutter noted in round 1.

## 5. What round 2 confirms is genuinely good

- `slice` is real depth-bounded BFS with an honestly-disclosed single-hop forward mode; `dataflow` explicitly disclaims value-level tracing; `deep-chains` is the most rigorous graph code in the repo (iterative Tarjan SCC + longest-path DP over the condensation).
- `evidence-cache` is trust-critical infrastructure done right: content-hash + version keying, per-file digest fingerprints, structural invalidation, fail-closed on SQLite errors, and the best test coverage encountered.
- `watch` single-flight + atomic rename publish; `bench` measures real child processes, not synthetic loops; instrumentation is wired and tested, not scaffolding.
- Vue parsing rides the real `@vue/compiler-dom`/`compiler-sfc`; `<script setup>` macros and scoped slots are handled properly; JSX-in-TSX generics work (verified by probe).
- `isolated`, `stale-abstractions`, `wrapper-candidates`, `passthrough-candidates` are meaningfully distinct signals, not copies; shard reuse and the reindex lockfile are genuinely tested.
- All six frontend commands already emit `evidence: "heuristic"` in JSON (the in-flight remediation's labeling choke point reaching them), and run clean and fast on repos with no frontend code.

## 6. Fix shortlist (candidate "Phase 11" for the remediation program)

| # | Fix | Effort |
|---|---|---|
| 1 | Parameterize scope in the 7 `LIKE` interpolation sites | S |
| 2 | Exclude self-file from fan-in/bottlenecks/hotspots fileCount | S |
| 3 | Add `src/tla` to drift policy + "every src dir has a policy row" regression test | S |
| 4 | Rebuild `complexity` branch counting on the AST; fix or rename `complexity-hotspots` and exclude term symbols | M |
| 5 | Probe tree-sitter per language at capability time; disclose "source facts unavailable" in detector output; unify the two capability tables | M |
| 6 | Descend into subdirectories in `findGitignoreFiles` + nested/negation tests | S |
| 7 | Share diff-gate's citation-kind classifier with doc-drift; fold `convergence` into `similar` | S–M |
| 8 | React profiler: `class_declaration` branch + profile named nested components; kill the dead `jsx_fragment` branch and tokenize fragments symmetrically | M |
| 9 | Vue template walker: tokenize INTERPOLATION children | S |
| 10 | Add `evidenceClass`/`actionTier` to the component-duplicates pair; replace `max(jaccard, overlap)` with size-aware scoring | M |
| 11 | Extract shared `PressureAxis`/`overlapGate` across the React/Vue pairs | M |
| 12 | Platform-scoped packages or on-demand fetch for `vendor/scip` (−39 MB for non-Windows) | M |
| 13 | Real glob for `files`; `truncated` flag for `cycles`; locality tier penalty | S |

2026-07-01 remediation confirmation: the guide references in this review were
rechecked after the implementation pass. The changed files still correspond to
the same findings: drift policy now has explicit source-layer handling, graph
and quality queries now use the corrected counting and scope behavior,
React/Vue profiling now covers the missing frontend evidence, source facts now
report unavailable parsers, and TLA conformance now compares SANY-derived model
facts against mapping and code evidence.
