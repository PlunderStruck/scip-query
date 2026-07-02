# Remediation Plan 2 — Round-2 findings + the regex campaign

Date: 2026-07-01
Executor: Codex (implementation) → Claude (review pass per phase)
Inputs: [Round-2 review](../reviews/2026-07-01-critical-review-round2.md) · regex inventory (this plan §12.0) · builds on [Remediation Plan 1](2026-07-01-review-remediation.md)

**Sequencing**: execute AFTER Plan 1 completes (or at least after its Phases 1–4 are committed). Phases here are numbered 11–16 to continue Plan 1's numbering. The **working agreement from Plan 1 applies verbatim** (commit per step, gates per phase, docs:commands regeneration, BLOCKED protocol, anchor re-verification ±5 lines). Three files here were also edited by Plan 1 — `cleanup-verify.ts`, `similar-signatures.ts`, `git-history.ts` — expect anchor drift there and build on the Plan-1 versions (e.g. 12.2 extends the new `decideBatchStatus`, it does not reintroduce the old logic).

## Goal

Fix every round-2 finding worth fixing, and retire every **load-bearing** regex — regexes standing in for a parser on structured input — while explicitly keeping the ones that are the right tool. Done = the metric bugs are gone with regression tests, capability output reflects runtime reality, the frontend detectors see the React/Vue code they're blind to today, non-Windows installs shrink by ~39 MB, and the "keep" regex list is documented so nobody crusades through the string-plumbing.

## Reuse Audit

- Complexity counting: reuse `getAst` (src/source/ast.ts) + existing node-walk patterns from conformance.ts/react-profile.ts — no new parser layer.
- Capability probing: reuse `getParserCtor`/grammar loading in src/source/ast/ast-runtime.ts — expose, don't duplicate.
- Citation tiering: reuse `classifyDocCitationKind` from src/queries/impact/diff-gate-doc-policy.ts in doc-drift — delete doc-drift's own weaker classification.
- Similarity: `convergence` folds into `similar` (reuse `src/analysis/similarity.ts` weighted cosine); no third similarity metric may be introduced.
- Frontend shared abstractions (`PressureAxis`, `overlapGate`): justified new units — the audit measured whole function families duplicated verbatim across react-*/vue-* files with drifted thresholds; extraction reduces net code.
- Windows scip distribution: reuse the checksum-verified on-demand fetch pattern Plan 1 adds for `tla fetch-tools`.
- Everything else is edits to existing units.

## Testability Design

| Behavior | Test seam | Injected deps | Pure core | Side-effect shell | Contract |
| --- | --- | --- | --- | --- | --- |
| Branch counting | `countBranchesFromAst(node)` | fixture source | AST walk over branch node types | `getAst` wrapper | McCabe-consistent integer |
| Capability probe | `probeLanguageRuntime(lang)` | injectable module loader | status decision | require() attempt | `'ast'\|'regex'\|'unavailable'` |
| Overlap gates | `overlapGate(buckets, thresholds)` | none | threshold arithmetic | none | boolean + reason |
| Pressure axes | `evaluatePressure(axes, profile)` | none | axis scoring | none | ranked `PressureFinding[]` |
| Scip binary fetch | `resolveScipBinary(platform, fetcher)` | fetcher fn, fs | URL/checksum selection | download+chmod | path or actionable error |
| Glob matching | `pathMatchesGlob(pattern, path)` | none | segment-aware matcher | none | boolean |

---

## Phase 11 — Metric integrity (graph/quality correctness)

### 11.1 - Parameterize scope in the 7 SQL LIKE interpolation sites
- [x] **File**: `src/queries/graph/coupling.ts:72`, `src/queries/graph/hotspots.ts:24`, `src/queries/graph/fan.ts:114,149`, `src/queries/cleanup/drift.ts:282`, `src/queries/graph/file-dep-graph.ts:199` (path may differ — locate by `LIKE '` grep), `src/queries/cleanup/redundant-reexports.ts:108`
- **What**: scope strings are string-interpolated into `LIKE '...'`; reproduced crash: `coupling -s "o'brien"` → SQL syntax error. `src/queries/impact/affected.ts:160` shows the correct bound-param pattern.
- **Change**: `LIKE ?` with bound `${scope}%`-style parameters at all 7 sites; sweep `grep -rn "LIKE '" src/` to zero unparameterized survivors.
- **Validation**: `node dist/cli.js coupling -s "o'brien"` returns empty results, no crash; add one CLI test with a quoted scope.

### 11.2 - Exclude the defining file from fan-in, bottlenecks, hotspots fileCount
- [x] **File**: `src/queries/graph/fan.ts:22-29` (fanIn/topFanIn), `src/queries/graph/bottlenecks.ts:64`, `src/queries/graph/hotspots.ts:35`
- **What**: fan-in counts same-file references (reproduced 13 vs 12 real cross-file consumers); fan-out already excludes them (`fan.ts:43-72`); bottleneck fanIn×fanOut and hotspots fileCount inherit the skew.
- **Change**: add `AND def_d.id != c.document_id` (or the file-level equivalent) to the three queries so fan-in/fan-out share one self-reference policy. Note behavior change in output docs: numbers will drop by up to 1 file per symbol.
- **Validation**: unit test on a fixture symbol with self-refs asserting fanIn == cross-file count; `fan-in <symbol>` agrees with `refs <symbol> --json` cross-file file count.

### 11.3 - Repair drift's layer policy and make staleness structurally impossible
- [x] **File**: `src/queries/cleanup/drift-policy.ts:46-77`
- **What**: `src/tla/` (and any future top-level dir) has no `allowed` entry; unlisted → violation at `policyBasis: explicit` (73% of live findings are false).
- **Change**: (a) add `tla` rules (tla → storage, symbols, queries/navigation, source, domain — verify against actual imports via `deps src/tla`). (b) Unlisted source layers now produce `policyBasis: 'unknown-layer'` at reduced confidence with remediation "add a policy entry", never `explicit`. (c) Regression test: enumerate `src/*/` dirs at test time and assert each has a policy row.
- **Validation**: `drift --json` on this repo: zero `explicit` findings for tla files; the enumeration test fails if a new src dir is added without a rule.

### 11.4 - Rebuild complexity counting on the AST; fix complexity-hotspots
- [x] **File**: `src/queries/quality/complexity.ts:113-125`; `src/queries/quality/complexity-hotspots.ts:25,44`; `src/symbols/symbol-parser.ts:309-311`
- **What**: overlapping branch regexes triple-count `else if` (~65–70% inflation, reproduced); hotspots score is size×fan with no branches and its function-like filter admits SCIP `term` symbols → interface properties rank top-5 with inherited 179-line ranges.
- **Change**: (a) `countBranchesFromAst(node)`: count `if_statement` (once), `ternary_expression`, `case`/`switch_case`, loop nodes, `catch_clause`, `&&`/`||` in conditions — McCabe-consistent; fall back to the regex path ONLY when `getAst` is unavailable, and stamp the result `estimateBasis: 'ast' | 'regex-fallback'` in output. (b) `isFunctionLikeSymbol` excludes property/field `term` symbols (keep method terms — check SCIP descriptor suffix `().` vs plain). (c) complexity-hotspots score gains a branch factor from (a); until then it must not be named "complexity" — do (a) first, same step. (d) Tests: hand-counted fixture (nested if/else-if chains, ternaries, regex literals containing `?`) asserting exact McCabe values; hotspots test asserting no `term` properties in results.
- **Validation**: `complexity countBranches` on this repo reports ≈ manual count (the audit's worked example: 15, not 25); `complexity-hotspots -n 5` returns functions only.

### 11.5 - Truthful `cycles`, real `files` glob, locality ranking, convergence fold-in
- [x] **File**: `src/queries/graph/cycles.ts:26-37`; `src/queries/navigation/files.ts:14-22`; `src/queries/cleanup/locality-candidates.ts:700-711`; `src/queries/cleanup/convergence.ts` + its descriptor
- **Change**: (a) cycles: when the DFS depth cap prunes, set `truncated: true` in JSON and append "(search truncated at depth N — deeper cycles may exist)" to the human empty/summary line; fix the help text ("bounds search depth, not cycle length"). (b) files: keep the SQL LIKE as a prefilter, then post-filter rows with a segment-aware matcher (`*` ≠ `/`, `**` crosses segments); document unsupported `[...]`/`{a,b}` in help. (c) locality: multiply (not subtract) a tier penalty so `repository-level-review` items rank below actionable tiers; test asserts a withheld-recommendation candidate never outranks an actionable one. (d) convergence: retire the command — descriptor gains deprecation note pointing at `similar <a> <b> --plan`; implement `--plan` on similar rendering the consolidation preview from similar's own weighted-cosine data; remove convergence's Jaccard so only one similarity metric exists. Keep the CLI name as a hidden alias for one release.
- **Validation**: cycles fixture with a deep cycle beyond the cap shows `truncated: true`; `files "src/queries/*.ts"` returns no nested paths; `similar --plan` output includes the consolidation sketch; `convergence` prints the deprecation pointer.

### 11.6 - Share the citation-kind classifier with doc-drift
- [x] **File**: `src/queries/cleanup/doc-drift.ts:278-281`; reuse `src/queries/impact/diff-gate-doc-policy.ts:10-62`
- **What**: diff-gate got `classifyDocCitationKind` (JSON-example/guide-reference tiering); standalone doc-drift didn't — the repo's own README declaredCouplings example is doc-drift's top finding at `actionTier: direct`.
- **Change**: doc-drift classifies citations through the shared function and tiers action accordingly; while there, capture optional `:line` suffixes in `PATH_REFERENCE_PATTERN` and record them (staleness scoring unchanged; presence enables future line-drift checks) — document "line references are recorded, not yet drift-checked" in help.
- **Validation**: `doc-drift README.md --json` no longer reports the declaredCouplings JSON example as `direct`; shared-classifier unit test covers both callers.

## Phase 12 — The regex campaign

### 12.0 - The inventory and the keep-list (documentation step, do first)
- [x] **File**: new `docs/REGEX_POLICY.md` (short)
- **Change**: Write down the policy the codebase now follows: **regex is banned as a substitute for available parsers on structured input** (source code when tree-sitter/ts-morph is loadable, TLA modules, checker diagnostics with structured formats) and **fine for flat machine-generated strings** (SCIP symbol encodings, paths, signatures — explicitly bless `symbol-parser.ts`, `scip-rows.ts`, `file-classifier.ts`, `source-stripper.ts`, `import-path-resolver.ts`, `similar-signatures.ts`'s signature normalization). List each load-bearing regex retired by this plan with its replacement. This file is the reviewer's checklist for future PRs.
- **Validation**: file exists, linked from AGENT_GUIDE's contributing notes.

### 12.1 - Complexity regexes → AST
Covered by 11.4 (same step; listed here so the campaign is complete).

### 12.2 - Checker diagnostics: per-oracle structured parsing on top of decideBatchStatus
- [x] **File**: `src/runtime/cleanup-verify.ts` (post-Plan-1 version — extend, don't rewrite)
- **What**: Plan 1 fixed the decision logic (exit codes win), but *error extraction* is still `/\berror\b/i` line matching, which under-extracts for go/ruff and makes the differential baseline coarser than it needs to be.
- **Change**: per-oracle diagnostic parsers as small pure functions: tsc (`file(line,col): error TSxxxx:`), go build (`file:line:col: message`), ruff (`file:line:col: CODE message` — prefer `ruff check --output-format json` when the flag is supported), cargo (`--message-format json`), clj-kondo (`--config {:output {:format :json}}`). Each returns `{file, line?, code?, message}[]`; the differential baseline keys on `{file, code|message}` instead of raw line text. Unknown oracle → current line heuristic, labeled `parseBasis: 'heuristic'`.
- **Testability**: table-driven parser tests from captured real outputs (fixtures checked in as text files); no spawning.
- **Validation**: the Plan-1 e2e fixture now reports structured errors with file/line; masked-duplicate case from Plan 1 still passes.

### 12.3 - Disclose the fix-commit heuristic in health output
- [x] **File**: `src/analysis/git-history.ts` (fix-commit matcher, ~:117-123 pre-Plan-1) + `src/queries/health/health-report.ts` validation-axis rendering
- **What**: the falsifiability axis is built on `/\b(fix(es|ed)?|bug|regression|hotfix)\b/i` over ≤2000 subjects — reasonable, but undisclosed; agents read the axis as measured ground truth.
- **Change**: one output line under the Validation axis: `fix-commit signal: subject-keyword heuristic over N commits`; JSON gains `validationBasis: {method: 'subject-regex', commitsScanned: N}`. Do not change the matcher itself (conventional-commit parsing is a different project; note as future work in REGEX_POLICY.md).
- **Validation**: `health --json` contains `validationBasis`; string test.

### 12.4 - TLA model parsing: SANY-derived structure replaces the module regexes
- [x] **File**: `src/tla/model-contract.ts:258-276` (`parseTlaVariables`/`parseTlaOperators`), new `src/tla/sany-facts.ts`; consumes Plan 1's `tla fetch-tools` jar plumbing
- **What**: `.tla` structure comes from two regexes (VARIABLES lines, `name ==` operators); misses nested/multi-line declarations and knows nothing about which primed variables each action touches — which is why the mapping JSON had to carry the model's semantics.
- **Change**: (a) `sany-facts.ts`: run `java -cp <jar> tla2sany.xml.XMLExporter -o <tmp> <spec>` (jar via the Plan-1 resolution chain), parse the XML for module variables, operator definitions, and per-operator primed-variable occurrences + referenced variables. (b) When the jar is available, conformance uses SANY facts: model-side per-action write set = primed vars, read set = unprimed references — compared against BOTH the mapping's declarations and the code-side scan (three-way agreement; disagreements are findings naming which pair diverges). (c) When the jar is absent, fall back to the regex parse and stamp every model-text finding `modelParse: 'regex-fallback'`; the PASS summary must say `model parsed by: sany|regex`. (d) This is the Pillar-C bridge: it makes the mapping's reads/writes *checkable against the model*, not just against code.
- **Testability**: XML fixture from a real SANY run on the dogfood spec checked into tests/; parser is pure. Conformance three-way tests: model says action writes x, mapping omits it → finding; code writes y, model doesn't prime y → finding.
- **Validation**: on the (Phase-7-fixed) dogfood spec with the jar present: `tla verify` PASS summary shows `model parsed by: sany` and per-action model-side write sets; deliberately removing an `UNCHANGED` from one action produces a three-way divergence finding.
- **Why last in the phase**: depends on Plan 1 Phase 7 landing (fetch-tools + honest PASS scaffolding).

### 12.5 - Frontend expression tokens: node-typed, not text-regexed
Covered by 14.3/14.4 (fragment/conditional/identifier handling); listed for campaign completeness.

## Phase 13 — Language & capability truth

### 13.1 - Capability matrix probes runtime reality
- [x] **File**: `src/runtime/project-readiness.ts:84-108, 215-219`; `src/source/ast/ast-runtime.ts:22-32` (expose probe); `src/language-parsers/registry.ts:96-115`
- **What**: `SOURCE_FACT_SUPPORT` is a hand-authored table; tree-sitter load failure is cached in a flag nothing reads; Clojure and Dart get different labels for the same tier; `hasIndexedGraph` is project-global but rendered per-language.
- **Change**: (a) Export `probeLanguageRuntime(lang): 'ast' | 'regex' | 'reader' | 'unavailable'` from ast-runtime (attempt `getParserCtor()` + grammar load, cached). (b) Capability rows compute status from probe × registry tier: probe=unavailable + registry says ast-based → `partial` with reason "tree-sitter native module not loadable — regex/import-only evidence". (c) Single source: derive the per-language tier from `registry.ts`'s capabilities field; delete the duplicated hand-rows in `SOURCE_FACT_SUPPORT` (keep only per-language prose notes). Clojure gets tier `reader` with an honest reason; Dart stays `partial/regex`. (d) `hasIndexedGraph` becomes per-language: check the language's shard/meta entry, not `index.db` existence.
- **Testability**: probe injectable (module loader fn); matrix tests for probe×tier combinations; per-language graph flag test on a fixture meta.json.
- **Validation**: `capability-matrix --json` on this machine reflects actual tree-sitter state; simulating load failure (inject) flips rows to `partial`.

### 13.2 - Detectors disclose when source facts are unavailable
- [x] **File**: `src/source/source-facts.ts:70-71` + the shared detector entry (post-Plan-1 labeling choke point in command-execution)
- **What**: `getAst()` null → facts builder returns null → detectors emit clean-looking empty results for non-TS languages with no explanation.
- **Change**: `loadOrBuildSourceFacts` returns `{facts: null, reason: 'parser-unavailable', language}` instead of bare null; the detector pipeline aggregates these and appends one disclosure line / JSON field: `sourceFactsUnavailable: ['ruby' (parser-unavailable)]`. Empty-with-reason ≠ empty.
- **Validation**: injected-probe test: detector run with unavailable parser emits the disclosure; TS-only repos emit nothing extra.

### 13.3 - Nested .gitignore support
- [x] **File**: `src/source/gitignore-filter.ts:60-85` (+ tests)
- **What**: comments at :21/:56-58 promise nested-file support; `findGitignoreFiles` only walks upward. Monorepo sub-package ignores are dropped.
- **Change**: walk the tree downward from project root collecting `.gitignore` files (bounded: skip already-ignored dirs while descending — use the accumulating matcher so `node_modules/` isn't traversed); apply each file's patterns relative to its directory (the `ignore` library supports this via prefixing). Cache per run.
- **Testability**: fixture repo with root + `packages/foo/.gitignore` (incl. a negation pattern); assert `packages/foo/dist/x.ts` filtered and negated file kept.
- **Validation**: new tests; existing gitignore tests unchanged.

### 13.4 - One Vue extraction path
- [x] **File**: `src/source/vue/vue-script.ts:11-23` → delegate to `src/source/vue/vue-sfc.ts:96-101` (`buildVueSfcUnit`)
- **What**: the generic-AST path takes `scriptSetup ?? script` (drops the second block) and bails on `src=`; vue-sfc.ts already handles both blocks and relative `src=`. Three paths, three capability envelopes.
- **Change**: `extractVueScriptBlock` becomes a thin adapter over `buildVueSfcUnit` (concatenated blocks with correct line offsets for range mapping); document remaining envelope differences vs the Volar augment path in the file header. Absolute-path/URL `src=` stays unsupported — now in one place.
- **Testability**: fixture SFC with both `<script>` and `<script setup>` → facts include symbols from both; fixture with `src="./x.ts"` → facts come from the external file.
- **Validation**: new tests; existing Vue tests green.

### 13.5 - Clojure gaps + per-language parser smoke tests
- [x] **File**: `src/language-parsers/languages/clojure.ts:356-358, 126-129`; new smoke tests under `tests/language-parsers/`
- **Change**: (a) Handle `#?`/`#?@` reader conditionals in require parsing: treat `#?` as reader-macro prefix and descend into each platform branch's vectors (both `:clj` and `:cljs` requires recorded). Test with a real `.cljc` ns form. (b) Add accuracy smoke tests for the untested parsers — ruby, php, dart, dotnet, jvm (java+kotlin+scala), c-like — each: one realistic fixture file, assert extracted imports + callables non-empty and exact for 3–5 known symbols (pattern-match the existing python-accuracy.test.ts). This is deliberately smoke-depth, not exhaustive.
- **Validation**: new tests pass; `.cljc` reader-conditional fixture extracts both branches' requires.

## Phase 14 — Frontend detector family

### 14.1 - React: profile class components and nested/HOC components
- [x] **File**: `src/source/react-profile.ts:346-380`
- **What**: no `class_declaration` branch (verified: grammar parses them fine); `walk()` discards named components with any function ancestor (HOC factories, render-prop returns).
- **Change**: (a) `class_declaration` whose name is PascalCase and which either extends `Component`/`PureComponent`/`React.Component` or contains a `render()` returning JSX → candidate; JSX body = the `render` method. (b) Nested named function/arrow components: instead of `!hasFunctionAncestor(node)` as a hard drop, accept PascalCase-named nested candidates (mark `nested: true`); anonymous default exports remain out of scope (document).
- **Testability**: fixtures — legacy class component pair (near-duplicates), `withAuth`-style HOC returning a named component; assert both appear in `react-component-duplicates`/`large-component-pressure` candidate sets.
- **Validation**: new tests; live run on this repo unchanged (no React code).

### 14.2 - React: fragment symmetry (and delete the dead branch)
- [x] **File**: `src/source/react-profile.ts:454-455, 463-476`
- **What**: `<>` produces a name-less jsx_element → skipped entirely; `<React.Fragment>` produces `component:React.Fragment`; the `jsx_fragment` node-type branch is dead code (grammar never emits it).
- **Change**: in `recordJsxElement`, a null tag name = fragment → add token `jsx:fragment` and still scan children/props (for `key` on Fragment); normalize `React.Fragment`/`Fragment` tags to the same `jsx:fragment` token; delete the dead branch.
- **Validation**: fixture pair identical except `<>` vs `<React.Fragment>` scores 1.0 structural similarity.

### 14.3 - Token quality: spread, conditional, identifier stoplist
- [x] **File**: `src/source/react-profile.ts:491-493, 499, 642-649, :102`; `src/source/vue/vue-template.ts:441-453`
- **Change**: (a) `prop:spread` → `prop:spread:<identifier>` when the spread argument is a simple identifier/member (`{...props}` → `prop:spread:props`), bare `prop:spread` only for complex expressions. (b) `jsx:conditional` only for actual ternary nodes (AST node type, not `?` text scan) — `?.`/`??` excluded. (c) Identifier extraction: extend the stoplist with the ubiquitous iteration/DOM idiom set (`item, index, idx, id, key, value, val, e, ev, event, err, error, data, res, result, props, state`) and drop identifiers ≤2 chars; same list shared by react-profile and vue-template (one exported constant — kills another accidental variation).
- **Validation**: fixture: two unrelated `.map((item) => …)` list renderers no longer clear the duplicate gate on idiom tokens alone; ternary-vs-`?.` fixture asserts token difference.

### 14.4 - Vue: tokenize interpolation
- [x] **File**: `src/source/vue/vue-template.ts:296-307`
- **What**: `walkTemplateChildren` skips non-ELEMENT children — `{{ expr }}` contributes nothing.
- **Change**: handle `NodeTypes.INTERPOLATION`: add `interpolation` shape token + expression identifiers via the shared (stoplisted) extractor; TEXT stays ignored; still recurse only into elements.
- **Validation**: fixture pair identical except interpolated field names scores < 1.0; interpolation-heavy template now clears `minTemplateTokens` (add fixture that previously produced zero tokens).

### 14.5 - Evidence classification for the component-duplicates pair
- [x] **File**: `src/queries/frontend/react-component-duplicates.ts:112-127` + result type; `src/queries/frontend/vue-component-duplicates.ts:118-133` + result type; reuse `src/queries/internal/frontend-behavior-evidence.ts`
- **What**: the weakest-evidence pair carries no `evidenceClass`/`actionTier`/`recommendation` (unlike hook/composable-candidates); generic native-tag overlap presents at full confidence; `behaviorSimilarity`'s `max(jaccard, overlap-coefficient)` reports 1.0 for small-subset matches.
- **Change**: (a) classify each duplicate pair through the existing evidence classifier: shared custom-component names / domain identifiers → `signal`; native-tag-and-shape-only → `support` with recommendation "generic structural overlap — verify intent before consolidating". (b) Replace `max(jaccard, overlap)` with overlap-coefficient damped by size ratio (`overlap * min(1, |small|/(0.35*|large|))`) or plain weighted Jaccard — pick one, document in code, add the 6-vs-80-token regression test asserting < 0.9. (c) Unify the unexplained React `>=4` vs Vue `>=3` shape thresholds through the shared `overlapGate` (14.6) with per-framework config and a comment citing the calibration basis (or marking it uncalibrated).
- **Validation**: fixture of two unrelated forms sharing only `div/span/button/input` reports `support`-tier, not unqualified; subset-similarity regression test.

### 14.6 - Extract shared PressureAxis + overlapGate; kill the six-file drift
- [x] **File**: new `src/queries/internal/frontend-shared.ts` (or extend frontend-behavior-evidence.ts — prefer extending); rewrite the duplicated families in `react-hook-candidates.ts`, `vue-composable-candidates.ts`, `react-large-component-pressure.ts`, `vue-large-view-pressure.ts`
- **What**: `hasMeaningfulBehaviorOverlap`, `compareProfiles`, `behaviorReason`, `pressureResult`, `dominantPressure`, `pressureKindsFor`, `recommendationFor` exist as near-identical hand-drifted copies across the react/vue pairs — the tool's own "accidental variation" pattern.
- **Change**: (a) `overlapGate(buckets, thresholds): {pass, reason}` used by all four gate sites (thresholds supplied per framework/command). (b) `PressureAxis[]` (name, measure fn, threshold, label, recommendationKind) with a single `evaluatePressure` engine; the two pressure commands supply axis tables only. (c) Keep human-facing labels byte-identical to current output where tests assert them (change tests only where the round-2 audit flagged missing coverage — and add the untested pressure kinds/evidence classes as new fixtures: `behavior-extraction`, `file-decomposition`, `component-decomposition`, `style-decomposition`, `script-behavior-extraction`, `total-size-review`, `domain-behavior`, `generic-workflow-scaffolding`).
- **Testability**: engine is pure; axis tables are data. This step is the reduction proof: net LOC across the four files must go DOWN (assert in review, not in code).
- **Validation**: all six frontend commands byte-compatible on existing fixtures except where new fields were added; new pressure-kind fixtures pass; `duplicate-bodies` (Plan-1 detector) run over `src/queries/frontend/` reports fewer groups than before the change.

## Phase 15 — Packaging & repo hygiene

### 15.1 - Stop shipping 39 MB of Windows binaries to everyone
- [x] **File**: `package.json` (`files`, optionalDependencies), `vendor/scip/`, `src/runtime/scip-cli.ts` (binary resolution), `scripts/build-scip-windows.mjs`, `.github` publish flow if present
- **What**: `vendor/scip` = 39 MB win32-x64 + win32-arm64 binaries in a 44.5 MB package; macOS/Linux users can never execute them.
- **Change**: preferred: two platform packages `@scip-query/scip-win32-x64` / `-arm64` (`os`/`cpu` fields, the esbuild pattern) listed in optionalDependencies; `scip-cli.ts` resolution order becomes: PATH → platform package → cached download (checksum-verified, reuse the fetch-tools pattern) → install instructions. Remove `vendor/scip/**` from `files` (keep LICENSE/README pointers). Fallback if publishing two packages is unwanted this release: keep binaries out of `files` and rely on the checksum download path for Windows.
- **Testability**: resolution order is a pure function over injected `{platform, existsSync, fetcher}` — table tests for all four outcomes.
- **Validation**: `npm pack --dry-run` unpacked size < 6 MB; Windows path covered by the resolution unit tests (no Windows CI assumed).
- **Why one-way door**: Windows installs change behavior — release-note prominently.

### 15.2 - Repo artifact hygiene
- [x] **File**: `reports/` (tracked generated output), root `index.db`/`index.scip`/`scip-query-0.10.1.tgz` (stale, ignored — advisory), `skills-lock.json` (Plan 1 step 8.5 if not yet done)
- **Change**: move `reports/{accuracy,debloat,verification}` under `docs/scip-query/reports/` (the single artifact root Plan 1's skills consolidation standardizes) or delete if stale; update any skill/doc references; add `reports/` to .gitignore afterward. Advisory note in the commit message for the untracked root clutter (user deletes at leisure — not ours to remove).
- **Validation**: `git ls-files reports/` empty; link-check script (Plan 1, 6.4) green.

## Phase 16 — Test debt on trust-bearing paths

### 16.1 - Cover the zero-test list
- [x] **File**: new tests for `doc-drift` (+`doc-citation-context`/`doc-terms`), `cycles` (dedicated: simple cycle, cross-SCC, truncation flag), `hierarchy`, `wrapper-candidates`, `complexity`/`complexity-hotspots` (delivered in 11.4), `convergence`-replacement `similar --plan` (delivered in 11.5)
- **Change**: for each, 2–4 assertion-backed tests on fixture repos exercising the documented contract (not snapshots). doc-drift: broken-reference case, co-change-staleness case, changelog-policy exemption, citation-kind tiering (11.6).
- **Validation**: coverage additions green; each file named in the round-2 zero-test finding has ≥1 dedicated test file.

### 16.2 - bench cold-index restore guard
- [x] **File**: `src/runtime/commands/command-handlers.ts:343-413` (bench backup/rename/restore)
- **What**: cold-bench renames the user's cache dir and restores in `finally`; a crash between rename and restore corrupts the cache with zero tests guarding it.
- **Change**: write a `bench-restore.json` marker (original path, backup path) before the rename and remove it after restore; on any bench start, if a marker exists, restore first and warn. Extract the rename/restore pair into a testable unit with injected fs.
- **Testability**: injected-fs tests: happy path, simulated crash (marker present on next run → restored), backup-missing edge.
- **Validation**: unit tests; `bench --cold-index` on this repo leaves cache intact (run once, compare `status --json` before/after).

---

## Stress-Test Findings

- **Behavior-change disclosures**: 11.2 (fan numbers drop), 11.4 (complexity numbers drop a lot — release-note "estimates were inflated; new numbers are AST-derived"), 14.x (frontend similarity scores shift; suppressed/baselined findings may churn — run `health --write-baseline` guidance in release notes), 15.1 (Windows install path — one-way door).
- **Blast radius**: 13.1 rewrites capability output consumed by `doctor`/`status`/`setup` smoke tests — update those fixtures in the same step. 14.6 touches four detector outputs — existing fixtures pin the human text; only flagged-missing coverage may change.
- **Ordering**: 11.4 before 11.5's hotspots validation; 12.4 after Plan-1 Phase 7; 14.3 before 14.5 (token quality changes similarity inputs); 15.1 last (release-shaped).
- **Failure modes**: 12.4 degrades to regex parse with disclosure when the jar is missing; 15.1 degrades to download-or-instructions; 13.3's downward walk skips ignored dirs to bound cost on huge repos.
- **Valid intermediate states**: every phase ships alone; 14.6 is the only step where four commands change in one commit — keep it a single commit for revertability.
- **Reuse**: no new similarity metric, no second citation classifier, no third Vue path — the plan deletes two of each instead.

## Execution Order

11 (correctness) → 12 (regex campaign; 12.4 waits on Plan-1 Phase 7) → 13 (capability truth) → 14 (frontend) → 16 (test debt) → 15 (packaging, release-shaped, last).

After each phase: Plan-1 working-agreement gates + review handoff.

## Summary of files

- **Create**: `docs/REGEX_POLICY.md`, `src/tla/sany-facts.ts`, `src/queries/internal/frontend-shared.ts` (or extension), platform package scaffolding (15.1), `scripts` fixtures for checker outputs + SANY XML, ~10 new test files.
- **Edit (major)**: complexity.ts, complexity-hotspots.ts, symbol-parser.ts, drift-policy.ts, fan.ts, bottlenecks.ts, hotspots.ts, coupling.ts, files.ts, cycles.ts, locality-candidates.ts, doc-drift.ts, cleanup-verify.ts, git-history.ts, health-report.ts, project-readiness.ts, ast-runtime.ts, registry.ts, source-facts.ts, gitignore-filter.ts, vue-script.ts, clojure.ts, react-profile.ts, vue-template.ts, react/vue component-duplicates + hook/composable + pressure files, scip-cli.ts, package.json, command-handlers.ts (bench).
- **Delete**: convergence.ts (folded into `similar --plan`), the dead `jsx_fragment` branch, `SOURCE_FACT_SUPPORT`'s duplicated tier rows, `vendor/scip/**` from the published `files`, tracked `reports/` artifacts.
- **Verify**: full gate suite per phase; `npm pack` < 6 MB; complexity fixture matches hand-counted McCabe; capability matrix reflects injected parser failure.
