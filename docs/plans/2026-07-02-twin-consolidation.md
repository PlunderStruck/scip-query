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

Create/extend a short section in this file listing every group still reported after T1–T4 with
its acceptance reason. Known entries:

- **parseRubyImportsAst / parseRustImportsAst / parseRustExportsAst** — near-name (edit distance 2) grouping of correctly-named parallel per-language parsers; not a concept twin. Accepted.
- Anything BLOCKED-noted above.

## T6 — closeout

`scip-query reindex && scip-query diff-gate` (fix or justify), full suite, then record in this
file: health score before/after, twin-drift group count before/after, and the final ACCEPT
ledger. Update `docs/benchmarks` only via addendum if any dated scoreboard cites twin counts.
