# Maintainability Implementation Tracker

Date: 2026-06-09. Source: `docs/plans/2026-06-09-maintainability-register.md`.
Goal: fix the scattered-policy smells, raise detector accuracy, and make the health
score reflect what it can mechanically see.

## Phases

### Phase 1 — Finding gate (register ledger 1, C1) — accuracy core ✅ DONE
Design changed on evidence: `productionCallableDefinitions` (project-index.ts:43) already IS the
candidate-level gate (test files, rust test mods, ignored, suppressions) — wrapper/passthrough/extract
were already on it. The real gaps were the public-API policy and a second test-file mechanism.
- [x] NEW `src/analysis/package-surface.ts`: derive externally-live files from package.json
      (exports/main/module/types/browser/bin; dist→src mapping; wildcard→prefixes). Per-db cached.
      6 unit tests in `tests/package-surface.test.ts`.
- [x] `isRootedSymbol` (file-classifier.ts) now merges package surface + entryRoots config —
      the "published API is externally live" policy no longer requires hand-config.
- [x] `productionCallableDefinitions` gained `excludeRootedSymbols`; wrapper + passthrough opt in
      ("inline this" is wrong advice for published API).
- [x] `stale-abstractions.ts` candidates now exclude rooted symbols + test files → the 11
      published-type false positives are gone (verified: 0 findings on this repo, fresh index).
- [x] `dead-candidate-gate.ts` test-file policy delegates to `classifyFile` — deleted the parallel
      SQL-LIKE mechanism (`TEST_FILE_PATTERNS`/`TEST_SUPPORT_PATH_PATTERNS` removed, no users).
- [x] `similar.ts` `getAllSourceFingerprints` adopts `productionCallableDefinitions` (gains
      ignored-path + suppression exclusions it lacked).
- [x] All 203 tests pass unchanged; health on this repo: staleTypes 11→0, no new findings.
- Decision: wrapper's consumer-file filter (barrel/entry/test at wrapper-candidates.ts:138) left
  as-is — consumer-side evidence policy (file-kind) vs stale's reference-shape partition are
  genuinely different evidence models; merging would be false compression.
- Decision: extract-candidates does NOT exclude rooted symbols — extracting helpers from inside a
  public function body doesn't change the API.

### Phase 2 — similar-files scoring accuracy ✅ DONE
- [x] Distinctive-evidence gate in `similar-files.ts`: a pair must share ≥2 deps with low global
      fan-in (≤ max(3, 3% of files)). Calibrated on real data: parser-family shared deps have
      fan-in 9–22 (infra), watch/cli-context shared deps have fan-in 3–5 (genuine cluster).
- [x] Result: all 8 language-parser false pairs gone (essential variation — different grammars,
      shared SDK). watch/cli-context retained — 3 distinctive shared deps is real related-work
      evidence, and it surfaced a genuine new finding (plan-context.ts ↔ planning.ts share 9
      distinctive query imports at 50%).
- [x] Existing fixture test passes unchanged (true positive preserved); policy documented in the
      detector's doc comment.

### Phase 3 — Cache self-registration (ledger 4 + 7, C2) ✅ DONE
- [x] NEW `src/storage/cache-registry.ts`: caches declare `clearGroups` at creation (REQUIRED
      param — compile error on omission is the enforcement); registry soundness: registration
      and population share module scope, so coverage can never lag a populated cache.
- [x] All 19 factory call sites declare membership; read-only-index caches declare explicit `[]`
      with a comment. Non-factory caches (semantic provider, strip-source singleton) register
      via `registerCacheClear` escape hatch.
- [x] `cache-invalidation.ts` rewritten to iterate the registry — `CACHE_REGISTRY` and
      `WHOLE_PROJECT_CACHE_KINDS` hand-lists deleted; public API unchanged.
- [x] Deleted: `symbols/symbol-evidence-cache.ts` (whole file) + 10 passthrough clear wrappers
      across 8 modules + 2 barrel re-exports.
- [x] Three latent gaps fixed by declaration: `live-barrels` (derived from dep graph but survived
      whole-project clears), `vue-non-script-identifiers` (source-derived, never cleared),
      `definition-consumer-file-usage` (cleared only by health's bespoke call — now registered;
      bespoke call deleted).
- [x] 3 new registry tests (`tests/cache-registry.test.ts`); typecheck clean; 203+3 tests pass.

### Phase 4 — Lifecycle merge (ledger 2) ✅ DONE
- [x] `stale-abstractions.ts` migrated onto `runCandidateAnalysis()` — batch row-builder became a
      per-candidate `staleCandidateRow()`; all filters preserved inside `evaluate`.
- [x] `extract-candidates.ts` migrated — direct fit, behavior identical.
- [x] Template adoption now 4 of 5 candidate-style detectors; `dead.ts` (multi-source evidence
      merge) and `similar-files.ts` (pairwise comparison) stay off — essential variation.

### Phase 5 — Single public-query manifest (ledger 3, C3) ✅ DONE
- [x] NEW `src/queries/public-query-entries.ts`: `PUBLIC_QUERY_ENTRIES` + `PRIVATE_QUERY_MODULES`.
- [x] `tsup.config.ts` imports the manifest (hand list deleted); build verified.
- [x] `cli-contract.test.ts`: bidirectional package.json check (exported query subpaths ≡ manifest)
      + filesystem completeness check (every `src/queries/*.ts` classified public or private).
      Both hand lists deleted — the list now exists in exactly one place.

### Phase 6 — Contract-test reach (ledger 5, 6, 9, C4) ✅ DONE
- [x] Documented-command scan extended to all `skills/*/SKILL.md` (via readdirSync — new skills
      are scanned automatically). Immediately caught REAL drift: 10 references to the removed
      `symbols` command across 5 skill files (fixed → `outline`), plus 4 prose lines now
      backticked. 14 fixes from one test extension.
- [x] `setup.test.ts`: `BUILTIN_SKILLS` ≡ `readdirSync('skills/')`, bidirectional.
- [x] Deleted `src/domain/query-result-types.ts` (3-line `export {}` signpost); comment moved to
      the `domain/types.ts` barrel.

### Phase 7 — Health-score integration ✅ DONE (detector deferred, with rationale)
- [x] Health flows through all gated detectors automatically (it calls them directly):
      staleTypes 11 → 0 on this repo (false positives), similar-files family noise gone,
      wrapper/passthrough no longer give "inline this" advice about published API.
- [x] DEFERRED: `sync-risk` detector (duplicated literal lists across files). Rationale: the only
      calibration instance in this repo (tsup/test twin lists) was just eliminated by the manifest,
      so a new heuristic could not be verified against real positives here — and an uncalibrated
      detector would re-introduce exactly the false-positive class this work removed. Revisit when
      a repo with live instances is available. The concept-level version (recognizing two
      mechanisms implement one policy) is not graph-computable; that remains review work.

### Phase 8 — Verification + bookkeeping ✅ DONE
- [x] Full suite: 207 tests pass (was 203 — net +4 after adding 6 package-surface, 3 registry,
      1 manifest-completeness and replacing/merging others). `npm run build`: all three tsup
      configs succeed off the manifest. Typecheck clean.
- [x] Fresh-index probe sweep: dead 0, cycles 0, drift 0, staleTypes 0 (was 11, all false),
      wrappers 0, passthroughs 0, similarPairs 0, extraction 1 (augment-vue — deferred in the
      register). similar-files: 2 pairs, both evidence-backed (watch/cli-context distinctive
      cluster; plan-context/planning 9 shared query imports — a genuine review candidate for
      the in-flight feature).
- [x] The tool reviewed its own patch: it flagged my new `isPackageSurfaceFile` (kept, suppressed
      with reason), `CacheClearGroup` (contract vocabulary, suppressed with reason), and the
      factory similarity (shared WeakMap-ensure extracted; the remaining source-equality
      difference declared essential and suppressed with reason).

## Decisions log
- `productionCallableDefinitions` was already the candidate gate — the register's "create a new
  finding-gate module" plan was revised to "fill the gaps in the existing gate" after reading
  the code. Evidence beats the plan.
- Wrapper's consumer-file filter (file-kind) vs stale's consumer partition (reference-shape):
  two evidence models, not one policy — left separate (false compression).
- `dead.ts` and `similar-files.ts` stay off `runCandidateAnalysis` — multi-source merge and
  pairwise comparison are different lifecycle shapes.
- `sync-risk` detector deferred: no live calibration instance remains in this repo; shipping
  uncalibrated heuristics would re-create the false-positive class this work removed.
- Skill-doc prose lines that start with `scip-query <word>` must backtick the tool name — the
  contract scan treats line-anchored mentions as command references (this is deliberate: it is
  the same convention the README/AGENT_GUIDE scan always used).
