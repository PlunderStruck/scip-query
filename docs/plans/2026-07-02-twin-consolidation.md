# Twin consolidation pass — 2026-07-02

Burn down the twin-drift health dimension (currently −4/100, 32 groups counted by health, 24
same-name groups listed by `twin-drift -s src --limit 50`) before the 0.11.0 publish. Every
disposition below was triaged from the live twin list; the executor MUST verify each group's
actual bodies with `scip-query code <symbol>` / `refs` before acting — if source contradicts a
disposition, BLOCKED-note it in this file and skip, never improvise.

Working agreement: one commit per numbered step; full gates per step (`npm test`, tsc, eslint
error-count 0 on `src tests tsup.config.ts`, `npm run build`; prettier on touched files);
explicit-path staging; never git checkout/restore/stash. After any helper extraction run
`scip-query incomplete-migration`; after any new helper run `scip-query recent-duplicates`.
Consolidations must preserve behavior — where two twins' bodies differ semantically, the
DIFFERENCE is the finding: compare with the new `scip-query twin-ab` scaffold (dogfood it),
decide which behavior is correct, and lock the survivor with a test before deleting the loser.

Success criteria: health twin-drift group count materially down (target ≤ 12 with every
remaining group in the ACCEPT ledger below), score ≥ 98, byte-identical repeat runs, all gates
green, diff-gate PASS.

## T1 — trivial single-canonical consolidations (one commit per bullet or grouped, executor's call, but each verified)

- **normalizePath ×4** (`analysis/file-classifier.ts:300`, `queries/cleanup/locality-candidates.ts:815`,
  `queries/navigation/imports.ts:312`, `resolution/import-path-resolver.ts:653`; 3L each) →
  one canonical in `src/resolution/path-normalization.ts` (already the home of `pathsResolveSame`).
  Verify the four bodies agree (likely backslash→slash); if any differs, twin-ab first.
- **SUPPORTED_LANGUAGES ×3** (`runtime/commands/command-handlers.ts:68` and `:117`,
  `runtime/config.ts:17`) → `config.ts` is canonical; handlers import it. Enumeration-rot double
  win. The two handler-local copies have different shapes (1L vs 3L) — check whether one is a
  display-name map rather than the language list; if so it is NOT a twin, rename it instead.
- **DOC_FILE_PATTERN ×2** (`queries/cleanup/doc-drift.ts:118`, `queries/impact/co-change.ts:322`)
  → one shared constant ("what counts as a doc file" must have one answer; these drifting is a
  real gate-precision hazard).
- **CLOJURE_EXTENSIONS ×2** (`resolution/import-path-resolver.ts:91`, `runtime/cleanup-verify.ts:236`)
  → one shared constant.
- **isInsideProject ×2** (`reindex/typescript-projects.ts:142`, `tla/model-contract.ts:191`; 4L each)
  → shared path util (resolution/). tla importing resolution is fine (verify no cycle).
- **formatHealthScore ×2** (`runtime/health-dossier.ts:151`, `runtime/project-setup.ts:748`; 4L each)
  → one canonical, likely in the health report layer both already depend on.
- **withJsonOption ×2** (`runtime/commands/command-spec-builders.ts:30`,
  `runtime/commands/query-command-builders.ts:12`) → one canonical; the other imports.
- **hasExtension ×2** (`reindex/detect.ts:209` 7L, `resolution/import-path-resolver.ts:120` 3L) —
  verify semantics first: if both mean "path ends with one of these extensions", consolidate; if
  detect.ts's is "has a known source extension" and resolver's is "has any extension", RENAME both
  to their precise meanings instead.

## T2 — behavior-differing twins (twin-ab first, then consolidate)

- **Clojure reader trio**: `skipString` (13L vs 15L), `isReaderMacroPrefix` (3L vs 3L),
  `isTokenDelimiter` (13L vs 5L) duplicated between `language-parsers/languages/clojure.ts` and
  `source/clojure-facts.ts`. This is one hand-rolled Clojure reader living in two places — the
  13L-vs-5L isTokenDelimiter says they have ALREADY drifted behaviorally. Generate a twin-ab
  scaffold for each pair, fill the input table with delimiter/reader-macro/string edge cases
  (`"a\"b"`, `#{`, `~@`, `\newline`, unicode), run it, and record which implementation is right
  where they disagree. Then extract ONE shared reader-primitives module (respect import direction:
  check whether language-parsers/ may import source/ or vice versa — if neither, a new shared home
  under src/core/ or similar per existing convention) and delete both copies. Lock the resolved
  disagreements with unit tests.
- **languageForPath ×3** (`queries/navigation/code.ts:133` 52L, `reindex/augment.ts:158` 8L,
  `reindex/vue/augment-vue-runtime.ts:705` 22L) — three extension→language maps that WILL rot
  apart (the 52L one is presumably the superset). Consolidate to one shared mapping with the
  superset's coverage; the small ones become thin calls or direct uses. Verify no caller depends
  on the narrow maps returning undefined for languages the superset knows (twin-ab if unsure).
- **discoverWorkspacePackages ×2** (`resolution/workspace-packages.ts:26` 16L,
  `semantic/typescript/workspace-packages.ts:11` 19L) — check import-direction law first
  (semantic/ must not import source/; verify whether semantic/ → resolution/ is allowed by
  existing imports). If allowed: consolidate into resolution/, semantic imports it. If not:
  BLOCKED-note and add both to the ACCEPT ledger with the boundary as the reason.

## T3 — framework-parallel lens family (extract shared cores where near-identical, rename where domain-specific)

The react/vue/lens detector family: **compareProfiles ×5** (45–66L,
similar-files/react-component-duplicates/react-hook-candidates/vue-component-duplicates/
vue-composable-candidates), **recommendationFor ×3**, **recommendationKindFor ×2**,
**pressureResult ×2**, **behaviorReason ×2**, **hasMeaningfulBehaviorOverlap ×2**,
**ROUTE_NAME_TOKENS ×2**, **REQUEST_CALLS ×2**.

Disposition per pair/group, in this order of preference:

1. If the bodies are near-identical modulo profile field names (check `twin-drift --json`
   maxDivergence and read them), extract ONE parameterized core (e.g. a generic
   overlap/cosine comparator taking field extractors) and keep thin domain wrappers. This is
   real deduplication — five 50L comparators is how the drift got here.
2. If genuinely framework-divergent (pressureResult is: the Vue side now carries
   delegated-composable folding the React side must not get — see followup #4), RENAME to
   domain-qualified names (`vuePressureResult`/`reactPressureResult` etc.). Better names AND it
   stops the recurring twin-partner advisories. Update all references.
3. 1L constants (`ROUTE_NAME_TOKENS`, `REQUEST_CALLS`): if contents identical → one shared
   constant; if intentionally different per framework → rename with framework prefix.

Do NOT force-merge anything whose divergence is intentional; renaming is the honest resolution
for parallel-by-design.

## T4 — renames for distinct-concept same-name pairs

- **resolveIndexPaths ×2** (`resolution/path-resolver.ts:44` 3L vs `runtime/config.ts:475` 17L) —
  different jobs; rename the config one to its actual meaning (verify with `code` first).
- **namespaceImport ×2** (`language-parsers/languages/clojure.ts:68` 43L vs
  `javascript-imports.ts:122` 18L) — per-language parser internals; rename the Clojure one
  (e.g. `clojureNamespaceImport`) or scope-qualify; do not merge.

## T5 — ACCEPT ledger (remaining groups, each with a defendable reason)

Verified against source (`scip-query code` / direct reads) after T1–T4 landed. Every group the
`twin-drift` command still reports (`-s src --limit 50 --include-homonyms`) is below, with the
disposition and why merging or renaming would be wrong or pointless.

- **parseRubyImports / parseRustImports / parseRustExports** (`language-parsers/languages/ruby.ts`,
  `rust.ts` x2) — near-name (edit-distance) grouping of correctly-named, per-language dispatcher
  entry points. Each just calls its own language's `*ImportsAst` implementation; nothing to merge.
  Accepted.
- **parseRubyImportsAst / parseRustImportsAst / parseRustExportsAst** — near-name (edit distance 2)
  grouping of correctly-named parallel per-language parsers; not a concept twin. Accepted (plan's
  original entry, reconfirmed).
- **handleStats / handleStatus** (`runtime/query-commands/core.ts` vs
  `runtime/commands/command-handlers.ts`) — coincidental near-name match. `handleStatus` is the
  real `scip-query status` CLI handler (9L); `handleStats` is an unrelated 1L `dbCommand(...)`
  descriptor binding for a different command. No shared concept. Accepted.
- **SOURCE_FILES_CACHE / SOURCE_LINES_CACHE** (`source/source-fileset.ts` vs `source/source-text.ts`)
  — both are `createPerDbCache` instances following this codebase's `<THING>_CACHE` naming
  convention (see also `SOURCE_TEXT_CACHE` in the same file), but cache different things: the file
  list matching an extension/inclusion filter vs. one file's text split into lines. Accepted.
- **SUPPORTED_LANGUAGES / supportedLanguages** (`runtime/config.ts` constant vs
  `runtime/commands/command-handlers.ts` filter function) — expected leftover of the T1
  consolidation: the array is now the single source of truth, and this near-name function is a
  genuinely different thing (a `(values) => SupportedLanguage[]` filter helper) that happens to
  share a name stem with it. Accepted.
- **ensureDir / ensuredDirs** (`runtime/config.ts` function vs `instrumentation/profile.ts` Set
  variable) — a function that `mkdirSync`s and returns a path, vs. a memoization Set tracking which
  directories a completely different module has already ensured. Different kind of thing, different
  file, coincidental name closeness. Accepted.
- **productionCallableDefinitions** (`core/production-callables.ts` free function vs
  `core/project-index.ts`'s `ProjectIndex` method) — already an explicitly-annotated
  `scip-query: ignore-passthrough` facade: the method is a deliberate 1:1 delegating wrapper so
  `ProjectIndex` stays the stable consumer-facing facade while `production-callables.ts` owns the
  actual detector policy. Not an accidental duplicate. Accepted.
- **lineOf** (`language-parsers/languages/javascript-reexports.ts` vs
  `semantic/typescript/semantic-locations.ts`) — same concept ("what line is this at"), deliberately
  different mechanisms: the language-parsers copy manually counts `\n` bytes in a raw source string
  (tree-sitter layer, no other option), the semantic copy calls ts-morph's
  `SourceFile.getLineAndColumnAtPos` on a real `Node` (only available where a ts-morph `SourceFile`
  exists). Merging would mean either importing ts-morph into language-parsers (wrong layer, wrong
  dependency) or losing the ts-morph-native precision. Accepted.
- **getSourceFiles / getSourceLines** (both `source/source-fileset.ts` / `source/source-text.ts`)
  — different jobs: the project-wide list of source file paths vs. one file's content split into
  lines. Accepted.
- **fileStem / filesKey** (`analysis/git-history.ts`'s `filesKey` vs
  `queries/cleanup/recent-duplicates.ts`'s `fileStem`) — different jobs: a cache-key builder that
  joins a sorted file set, vs. a single file's basename-without-extension. Accepted.

Renamed during T4 verification (not left as accepted near-name pairs, since a precise rename was
cheap and available): `language-parsers/languages/clojure.ts`'s `parseImportClause` ->
`clojureParseImportClause` (JS/TS sibling parses a raw import-clause string, unrelated), and
`analysis/framework-patterns.ts`'s `SUPPRESS_COMMENT_RE` -> `DEAD_STALE_SUPPRESS_COMMENT_RE`
(scoped subset of `source/source-text.ts`'s same-named, broader-category regex).

No BLOCKED-notes were needed — every disposition in T1-T4 was verifiable against source, though
several corrected the plan's own initial guess (see T6 deviations).

## T6 — closeout

`scip-query reindex && scip-query diff-gate` (fix or justify), full suite, then record in this
file: health score before/after, twin-drift group count before/after, and the final ACCEPT
ledger. Update `docs/benchmarks` only via addendum if any dated scoreboard cites twin counts.

### Closeout results (2026-07-02)

**Health score**: 95/100 -> 98/100 (risk 99 unchanged; hygiene 95 -> 98). Twin-drift score
penalty: -4 -> -1.

**Twin-drift group count** (`scip-query health` breakdown, the count health scores against):
32 -> 9 groups. (`twin-drift -s src --limit 50` default divergent-only view: 24 -> 0 groups, all
consolidated or renamed away. `--include-homonyms` full view, including coincidental near-name
pairs that were never real twins: not measured at the true start, 22 -> 10 after T1 landed the
first pass, final 10; the 9 health counts are the subset of those 10 groups health's scorer
weights, all in the ACCEPT ledger above.)

**Consolidated vs renamed vs accepted**:
- Consolidated into one canonical implementation (real duplicate code removed): 9 groups --
  normalizePath (x4->1), isInsideProject (x2->1), CLOJURE_EXTENSIONS (x2->1), formatHealthScore
  (x2->1), SUPPORTED_LANGUAGES (x2->1), the Clojure reader trio (skipString,
  isReaderMacroPrefix, isTokenDelimiter; x2->1 each, 3 groups), discoverWorkspacePackages (x2->1).
- Renamed to domain-qualified/precise names (verified genuinely parallel-by-design or genuinely
  distinct concepts, not merged): 16 groups -- hasExtension/extensionSetOverlaps, DOC_FILE_PATTERN
  vs DOC_TAG_PATH_PATTERN, withJsonOption/withMetadataJsonOption, languageForPath trio (x3),
  compareProfiles (x5), pressureResult, recommendationFor (x3), recommendationKindFor,
  hasMeaningfulBehaviorOverlap, behaviorReason, REQUEST_CALLS, ROUTE_NAME_TOKENS/ROUTE_PAGE_TOKENS,
  resolveIndexPaths, namespaceImport/namespaceImports, parseImportClause (Clojure side),
  SUPPRESS_COMMENT_RE (framework-patterns.ts side).
- Accepted with a written reason (T5 ledger): 10 groups -- see T5 above.

**Clojure reader trio twin-ab verdicts** (T2, `scip-query twin-ab`, dogfooded):
- `isReaderMacroPrefix`: disagreed on `'#'`. **source/clojure-facts.ts's side was right** (should
  include `#`, Clojure's dispatch-macro prefix for `#{}`/`#()`/`#'`/`#"`); the parser's copy was
  missing it and silently mis-parsed those forms as a bogus one-character `"#"` atom.
- `isTokenDelimiter`: disagreed on `'"'` and `';'`. **language-parsers/languages/clojure.ts's side
  was right** (a bare token must terminate at a string or comment boundary with no whitespace);
  source/clojure-facts.ts's copy was missing both.
- `skipString`: no disagreement on the shared "end index" semantics across escaped quotes, escaped
  backslashes, embedded newlines, unicode, and unterminated strings -- source/clojure-facts.ts's
  extra line-tracking is additive, not diverging.
- Merged into source/clojure-facts.ts (the pre-existing shared home for `skipLineComment`, per an
  existing layer-policy comment) with both corrections applied, and locked with
  `tests/source/clojure-reader-primitives.test.ts` (direct primitive assertions + one end-to-end
  regression through the real parser for the `#` fix).

**Deviations from the plan's initial dispositions** (all verified against source before acting,
per the working rules -- none improvised silently):
- `normalizePath`/`isInsideProject`'s planned canonical home (`src/resolution/path-normalization.ts`)
  violates the explicit layer policy for two of its callers (`analysis/` and `tla/` may not depend
  on `resolution/`). Moved the whole module (including the pre-existing `pathsResolveSame`) down to
  a new `src/source/path-normalization.ts` instead -- the one layer every caller (analysis, tla,
  reindex, queries, resolution) is already allowed to import.
- `DOC_FILE_PATTERN` (T1) was planned as a straight merge; source showed the two regexes serve
  different jobs (doc-drift.ts's is a literal doc-extension test, co-change.ts's is a much broader
  directory+extension tagging heuristic used alongside sibling `*_FILE_PATTERN` constants). Renamed
  co-change.ts's copy to `DOC_TAG_PATH_PATTERN` instead of merging.
- `languageForPath` (T2) was flagged as three maps that "will rot apart," implying eventual merge
  to the superset; source showed they already serve three incompatible vocabularies (canonical
  SupportedLanguage enum, a best-effort documents-table tag, and LSP languageId strings). All three
  renamed, none merged.
- `resolveIndexPaths` is part of the published `scip-query/runtime` package export -- renaming it
  (to `resolveIndexStoragePaths`) is a public-API-surface change, accepted here since this pass is
  explicitly pre-0.11.0-publish prep per the plan header.
- Two additional near-name pairs were found and resolved while verifying the T5 ledger (not
  originally enumerated in the plan): `clojure.ts`'s `parseImportClause` ->
  `clojureParseImportClause`, and `framework-patterns.ts`'s `SUPPRESS_COMMENT_RE` ->
  `DEAD_STALE_SUPPRESS_COMMENT_RE`.
- No BLOCKED-notes were required anywhere in T1-T4.

**diff-gate vs 7922f1fd**: 1 blocking finding + 2 advisory, all accepted (not fixed) with reasons:
- `[co-change-partner]` `src/tla/model-contract.ts` changed without its 100%-coupled test file.
  The only change to this file was extracting its local `isInsideProject` to the shared
  `isPathInsideProject` (byte-for-byte identical logic, confirmed by the full suite passing before
  and after) -- a pure refactor with no observable behavior change, so no test update was needed.
  Accepted.
- `[doc-reference]` (advisory) `docs/COMMAND_REFERENCE.md` cites `co-change.ts` for its battery-
  command disclosure behavior; the only change to that file was the internal `DOC_FILE_PATTERN` ->
  `DOC_TAG_PATH_PATTERN` rename plus a clarifying comment, which doesn't touch the cited claim.
  Accepted.
- `[doc-reference]` (advisory) `docs/architecture/evidence-cache-invalidation.md` cites
  `framework-patterns.ts` and `react-profile.ts`'s cache-invalidation contract as "source bytes ...
  change" -- both files' only edits here were identifier renames (`SUPPRESS_COMMENT_RE` ->
  `DEAD_STALE_SUPPRESS_COMMENT_RE`; `REQUEST_CALLS` -> `REACT_REQUEST_CALLS`), which DO change
  source bytes, exactly the documented trigger. The doc's claim remains true. Accepted.

**Final gates**: `npx tsc --noEmit` clean, `eslint src tests tsup.config.ts` 0 errors, `npm run
build` clean, `npm test` 780/780 passing, `npm run lint` clean (prettier + eslint + skill-link
check), `scip-query drift` unchanged at the pre-existing 3 layer violations throughout (none
introduced), `scip-query incomplete-migration` / `recent-duplicates` clean after every commit.
