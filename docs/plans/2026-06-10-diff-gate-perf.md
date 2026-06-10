# Diff-gate performance & coverage overhaul

Date: 2026-06-10
Status: implemented (same day)

> Course correction during implementation: the plan placed the semantic-callee
> persistent-cache hook in `src/semantic/shared-primitives.ts` (4.3). The
> repo's own drift detector flagged that as a layer violation
> (`semantic/ -> source/source-text`), so the wrapper lives in
> `src/symbols/call-graph-evidence.ts` (`cachedSemanticCalleeMap`) instead —
> the symbols layer already imports both source and semantic. Write-through is
> additionally gated on provider availability so "ts-morph missing" is never
> frozen into the cache as an empty result. `semanticCalleeMap` itself is
> unchanged.
>
> Measured on this repo (9 files / 114 changed symbols, all caps removed):
> cold 7.0s (old capped behavior: 7.7s while silently checking 10 symbols;
> old uncapped: 33s), warm 3.7s.
>
> Validated on Vega_2.0 (92k symbols — a "large index"): published 0.9.0 took
> 59s checking 10/59 symbols (and its echo looked cheap only because the first
> 10 symbols were non-function-like and early-returned; real function diffs
> rebuilt the unbounded corpus per symbol — the historical 3-4 minute runs).
> New: cold 4:25 once (full ts-morph pass over ~5,150 callables, announced via
> a stderr notice on large+cold-cache), warm 11.6s with 96/96 symbols and
> 21/21 helpers checked. Two follow-on fixes landed during validation:
> doc-path-token extraction cached in evidence.db (the doc-reference regex
> scan was 7.6s/run on doc-heavy repos), and `synchronous = NORMAL` + batched
> semantic-callee writes (per-row autocommit fsync).

## Gate A — Goal

`scip-query diff-gate` (and the standalone detectors it wraps) must check **every** changed
symbol and **every** new helper — no silent 10-symbol caps — while getting *faster*, not
slower. Today a diff-gate run on a large repo takes 3-4 minutes with the caps on; raising
`--max-echo-checks` makes it linearly worse (measured: 7.7s → 33s on this repo for 269
symbols), and the incomplete-migration cap can't be raised from diff-gate at all.

Done means:

1. Diff-gate checks all changed symbols (echo) and all new helpers (incomplete-migration)
   by default, at roughly today's *capped* cost.
2. Warm runs only pay analysis cost proportional to the diff (per-file evidence persisted
   across processes, invalidated by content hash).
3. The ts-morph `findReferences` storm in `diffImpact` only runs for symbols whose SCIP
   fan-in is 0 (the only case where it can change a diff-gate outcome).
4. Users can bound or skip individual checks: `--max-helpers`, `--skip <check>`.

Accuracy contract: no check may report *fewer* true findings than today. Coverage may only
go up (cap removal). The one deliberate evidence change (Phase 3) is proven
outcome-equivalent for diff-gate below.

## Gate B — Current end-to-end flow

`scip-query diff-gate` → `handleDiffGate` (`src/runtime/query-commands/impact.ts:94`,
Source: `scip-query outline src/runtime/query-commands/impact.ts`) → `diffGate()`
(`src/queries/diff-gate.ts:63-99`, Source: `scip-query plan-context src/queries/diff-gate.ts`):

1. `diffImpact(db, { base })` (`src/queries/diff-impact.ts:45-61`) → `diffImpactPartial`
   (`:84-118`) collects defs from changed files, then calls
   `semanticCallerMap(db, defs)` (`src/semantic/shared-primitives.ts:25-43`) which runs
   ts-morph `referencesFor` → `identifier.findReferences()` — a **whole-project reference
   search per definition** — for every def, before SCIP fan-in is even read
   (`addChangedDefinitionImpact`, `:226-252`, computes
   `fanIn = max(scipFanIn, semanticConsumers.size)`).
   Source: `scip-query outline src/queries/diff-impact.ts`, `scip-query code` on each.
2. `runEchoCheck` (`src/queries/diff-gate.ts:101-129`) calls `similar()` per changed symbol
   (cap `maxEchoChecks`, default 10). Each `similar()` call
   (`src/queries/similar.ts:44-61`) rebuilds the **entire corpus** via
   `getAllCalleeFingerprints` (`:272-298` — `productionCallableDefinitions` +
   `calleeMap(semantic: true)` over every production callable) and recomputes IDF
   (`computeIdf`, `src/analysis/similarity.ts:66-82`). When callee results are empty it
   falls back to `similarBySourceShape` (`:308-348`) which rebuilds
   `getAllSourceFingerprints` (`:376-390`) — another full-corpus pass per symbol.
   Source: `scip-query plan-context src/queries/similar.ts`, `scip-query refs getAllCalleeFingerprints`.
3. `runIncompleteMigrationCheck` (`src/queries/diff-gate.ts:131-155`) calls
   `incompleteMigration(db, { base })` (`src/queries/incomplete-migration.ts:72-174`) —
   `maxHelpers` defaults to 10 and **is not plumbed** from diff-gate; only the standalone
   command exposes `--max-helpers` (`src/runtime/query-commands/impact.ts:65-92, 170-184`).
   It builds the same fingerprint corpus again (`:107`,
   Source: `scip-query refs getAllCalleeFingerprints` → incomplete-migration.ts lines 7, 107).
4. Remaining checks (co-change-partner, doc-reference, unused-params, new-dead, baseline)
   are comparatively cheap; baseline is skipped without `.scipquery-baseline.json`.

Caching today is **per-process only**: `SOURCE_FACTS_CACHE` is a WeakMap on the parsed
tree (`src/source/source-facts.ts:40-54`), the ts-morph provider memoizes per-definition
results in instance Maps (`src/semantic/typescript/ts-morph-provider.ts:76-83`), and
git-history uses `createPerDbValue` revalidated by HEAD (`src/analysis/git-history.ts:57-69`).
A fresh CLI process repays everything. CPU profile (this repo, 22 files / 269 symbols,
8.7s): tree-sitter source-facts ~42%, ts-morph ~20%, GC/native ~13%, git spawns ~5%,
SQLite ~1%.

Non-obvious invariants the current code already handles (must be preserved):

- `ScipDatabase` opens index.db **readonly** (`src/storage/db.ts:44-49`,
  Source: `scip-query code src/storage/db.ts:37-60`), and reindex **replaces** index.db
  wholesale via temp-file promotion (`publishFreshReindexArtifacts`,
  `src/reindex/index.ts:310-342`). Any persistent cache must live in a *separate* file.
- `createTsMorphProvider` is **eager** — project construction happens at provider creation
  (`src/semantic/typescript/ts-morph-provider.ts:52-72`,
  Source: `scip-query code createTsMorphProvider`). A persistent-cache hit path must not
  touch `getSemanticProvider` at all, or the win evaporates.
- `similar()` excludes the target from the corpus via `excludeSymbol` and computes IDF
  over `[target, ...candidates]` (`src/queries/similar.ts:69-75`).
- The standalone `diff-impact` command batches files into isolated subprocesses
  (`runDiffImpactBatchProcess`, `src/runtime/cli-support.ts:204-219`,
  `DIFF_IMPACT_BATCH_SIZE = 10` at `:13`) — diff-gate uses the in-process path; both go
  through `diffImpactPartial`.
- `incompleteMigration` deliberately uses asymmetric containment, not cosine, and
  deliberately avoids IDF gating (docstring, `src/queries/incomplete-migration.ts:49-71`).
- diff-gate `--hook` mode must stay silent-on-pass / exit-2-on-findings
  (`handleDiffGate`, `src/runtime/query-commands/impact.ts:94-130`).

## Gate C — Reuse audit

| Proposed new code | Reuse target / justification |
|---|---|
| Per-process memo for fingerprint corpora | **Reuse** `createPerDbCache` / `createPerDbValue` (`src/storage/per-db-cache.ts:53-107`) + `registerCacheClear` (`src/storage/cache-registry.ts:50-52`) — the established per-db cache lifecycle (Source: `scip-query outline src/storage/per-db-cache.ts`). No new cache machinery. |
| Content hashing | **Reuse** the `createHash('sha256')` idiom already in `resolveCacheDir` (`src/runtime/config.ts:63-66`, Source: `scip-query code resolveCacheDir`). |
| Evidence-cache file location | **Reuse** the cache-dir convention: index.db lives in `resolveIndexPaths().cacheDir` (`src/runtime/config.ts:75-88`); the evidence DB is a sibling `evidence.db` via `dirname(db.config.dbPath)`. |
| Writable SQLite handle | **New module** `src/storage/evidence-cache.ts` — justified: `ScipDatabase` is readonly by design (`src/storage/db.ts:47`) and is replaced on reindex; no existing writable, reindex-surviving store exists (Source: `scip-query refs createHash`, `scip-query files fingerprint` — no persistent query-time cache anywhere). Uses better-sqlite3, same library as `ScipDatabase`. |
| Cache version key | **Reuse** `loadCliPackageInfo()` (`src/runtime/cli-support.ts:18-27`) — same version source as `--version`/update notice. |
| Repeatable `--skip` option | **Reuse** `collectValues` parser (`src/runtime/command-spec-builders.ts:4`, Source: `scip-query code src/runtime/command-spec-builders.ts:1-40`). |
| Corpus sharing across checks | **No new API.** Memoizing `getAllCalleeFingerprints` itself (keyed by options, `excludeSymbol` filtered post-hoc) means `similar()`, `similarAll()`, `incompleteMigration()`, and the baseline's `similarAll` all share one corpus per process with zero signature changes. |

Queries run: `similar-chains` not needed (no new end-to-end flow); `recent-duplicates`
run at verify time; `refs getAllCalleeFingerprints / semanticCallerMap / incompleteMigration / diffGate`
for consumer inventories.

---

## Phase 1 — Memoize the fingerprint corpora (per-process)

### 1.1 — Memoize `getAllCalleeFingerprints`

- [ ] **File**: `src/queries/similar.ts:272-298`
- **Source**: `scip-query plan-context src/queries/similar.ts`; `scip-query refs getAllCalleeFingerprints` (consumers: similar.ts:69,148; incomplete-migration.ts:107)
- **What**: Rebuilds `productionCallableDefinitions({minLoc: 5, excludeSymbol, ...})` +
  `index.calleeMap(candidates, {semantic})` + per-candidate `callableSignature` on every
  call. Called once per echo symbol, once per `similarAll`, once per `incompleteMigration`.
- **Change**: Introduce a module-level `createPerDbCache<SymbolFingerprint[]>('callee-fingerprints',
  { clearGroups: ['whole-project', 'source-file'] })`. Key =
  `${minCallees}|${scope ?? ''}|${scanLimit ?? ''}|${semantic !== false}` — **excludeSymbol
  is removed from the corpus build** and applied as a post-filter
  (`corpus.filter(fp => fp.symbol !== excludeSymbol)`), preserving identical output.
  The cached array is treated as immutable (all three consumers only iterate — verified by
  `scip-query code` on `compareAgainstFingerprints`, `similarAll`, `incompleteMigration`).
- **Why**: This is the single change that makes "check every symbol" affordable: corpus
  cost becomes once-per-process instead of once-per-target.

### 1.2 — Memoize `getAllSourceFingerprints`

- [ ] **File**: `src/queries/similar.ts:376-390`
- **Source**: `scip-query plan-context src/queries/similar.ts` (consumer: `similarBySourceShape:308-348`, reached per echo symbol with <3 callee matches)
- **What**: Rebuilds source-token fingerprints for every production callable on each
  fallback call.
- **Change**: Same `createPerDbValue` memoization (no parameters → single value,
  `clearGroups: ['whole-project', 'source-file']`).
- **Why**: Without this, symbols that hit the lexical fallback still trigger full-corpus
  scans per symbol once the cap is lifted.

## Phase 2 — Lift the caps; plumb `--max-helpers`; add `--skip`

### 2.1 — diff-gate defaults: uncapped echo, uncapped helpers

- [ ] **File**: `src/queries/diff-gate.ts:63-99` (`diffGate` opts + defaults), `:101-129`
  (`runEchoCheck`), `:131-155` (`runIncompleteMigrationCheck`)
- **Source**: `scip-query plan-context src/queries/diff-gate.ts`
- **What**: `maxEchoChecks = 10` hardcoded default; `incompleteMigration(db, { base })`
  passes no `maxHelpers`; skip entries announce the caps.
- **Change**: Default `maxEchoChecks` to `Number.POSITIVE_INFINITY`; add
  `maxHelpers?: number` (default `Infinity`) and `skip?: DiffGateCheck[]` to `diffGate`
  opts. Pass `maxHelpers` through to `incompleteMigration`. Each `run*Check` is bypassed
  when its check is in `skip`, recording
  `{ check, reason: 'skipped via --skip' }` in `result.skipped`. The cap-skip entries
  remain for explicitly bounded runs (`changedSymbols.length > maxEchoChecks` is false at
  Infinity, so the message disappears by default).
- **Why**: The user-facing goal: every symbol checked by default, caps become opt-in
  bounds instead of silent truncation.

### 2.2 — incomplete-migration default cap removal

- [ ] **File**: `src/queries/incomplete-migration.ts:72-104`
- **Source**: `scip-query outline src/queries/incomplete-migration.ts`; `scip-query code incompleteMigration`
- **What**: `maxHelpers = 10` default at `:83`; `result.note` announces the cap at `:104`.
- **Change**: Default `maxHelpers` to `Number.POSITIVE_INFINITY` (`newDefs.slice(0, Infinity)`
  is a full copy — keep the slice only when finite, or guard with
  `Number.isFinite(maxHelpers)`). Note text unchanged when a finite cap is given.
- **Why**: Per-helper scoring against a memoized corpus is sub-millisecond containment
  arithmetic; the cap no longer buys anything by default.

### 2.3 — CLI flags

- [ ] **File**: `src/runtime/query-commands/impact.ts:94-130` (`handleDiffGate`),
  `:132-199` (descriptors)
- **Source**: `scip-query outline src/runtime/query-commands/impact.ts`; `scip-query code src/runtime/query-commands/impact.ts:94-130`
- **What**: diff-gate exposes `--base`, `--min-together`, `--max-echo-checks` (default 10),
  `--hook`. `--max-echo-checks` and `--max-helpers` defaults are 10 in the descriptors.
- **Change**:
  - Drop the `10` defaults from `--max-echo-checks` (diff-gate) and `--max-helpers`
    (incomplete-migration command) so undefined → Infinity in the query layer; update
    descriptions to say "default: all".
  - Add `option('--max-helpers <n>', 'Maximum new helpers to score for incomplete-migration (default: all)', parseInteger)` to diff-gate.
  - Add `option('--skip <check>', 'Skip a check (repeatable): echo, incomplete-migration, co-change-partner, doc-reference, unused-params, new-dead, baseline', collectValues)`;
    validate against the `DiffGateCheck` union, exiting with a clear error on unknown names.
- **Why**: Answers both user asks: helper cap reachable from diff-gate, and per-check
  control (e.g. `--skip doc-reference`) instead of a hardcoded opinion.

### 2.4 — Regenerate command reference

- [ ] **File**: `docs/COMMAND_REFERENCE.md` (diff-gate / incomplete-migration sections)
- **Source**: memory `scip-query-command-registration-ripple` — `npm run docs:commands`
  prints to stdout; splice the changed sections manually.
- **Change**: Splice regenerated diff-gate + incomplete-migration entries.
- **Why**: doc-reference check (correctly) fires when commands change and docs don't.

## Phase 3 — Gate `semanticCallerMap` to SCIP-fan-in-0 definitions

### 3.1 — Reorder fan-in evidence in `diffImpactPartial`

- [ ] **File**: `src/queries/diff-impact.ts:84-118` (`diffImpactPartial`), `:226-252`
  (`addChangedDefinitionImpact`)
- **Source**: `scip-query outline src/queries/diff-impact.ts`; `scip-query code diffImpactPartial`
- **What**: `semanticCallerMap(db, defs)` runs ts-morph `findReferences` for **all** defs
  (`:98`), then `addChangedDefinitionImpact` computes
  `fanIn = max(scipFanIn(db, id), semanticConsumers.size)` (`:235`).
- **Change**: Compute `scipFanIn` for every def first (cheap SQL, `:254-267`), then call
  `semanticCallerMap(db, defs.filter(d => scipFanIn === 0))`. Pass the precomputed fan-in
  into `addChangedDefinitionImpact` instead of recomputing.
- **Why**: For defs with `scipFanIn > 0`, semantic callers cannot change any diff-gate
  outcome: `new-dead` only tests `fanIn > 0` (`src/queries/diff-gate.ts:233`), and
  `max(n, m) > 0` already holds. **Outcome-equivalence proof**: semantic evidence runs
  for exactly the defs where it can flip `fanIn` from 0.
- **Accepted tradeoff** (documented here deliberately): the `diff-impact` command's
  `affectedConsumers` list loses semantic-only consumer *files* for symbols that already
  have ≥1 SCIP consumer. Changed-symbol fan-in classification is unaffected. This is the
  same staleness class the SCIP index itself already accepts.

## Phase 4 — Persistent evidence cache (`evidence.db`)

### 4.1 — New module `src/storage/evidence-cache.ts`

- [ ] **File**: new — `src/storage/evidence-cache.ts`
- **Source**: reuse audit above; lifecycle facts from `scip-query code src/storage/db.ts:37-60`
  and `scip-query code publishFreshReindexArtifacts`
- **Change**: Lazily-opened writable better-sqlite3 DB at
  `join(dirname(db.config.dbPath), 'evidence.db')`, `journal_mode = WAL`,
  `busy_timeout = 5000`. Schema (created with `CREATE TABLE IF NOT EXISTS`):
  - `source_facts(relative_path TEXT PRIMARY KEY, content_hash TEXT NOT NULL, version TEXT NOT NULL, payload TEXT NOT NULL)`
  - `semantic_callees(relative_path TEXT NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, leaf TEXT NOT NULL, content_hash TEXT NOT NULL, deps_digest TEXT NOT NULL, version TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (relative_path, start_line, end_line, leaf))`
  - `version` = `loadCliPackageInfo().version` — cache self-invalidates on upgrade, no
    schema-bump bookkeeping.
  - Every operation wrapped: first SQLite error disables the cache for the process
    (degrade to uncached, never crash a query). Corrupt payload JSON → treat as miss,
    overwrite.
  - Per-file sha256 content hashes memoized per-process via `createPerDbValue`.
- **Why**: index.db is readonly and replaced on reindex; evidence keyed by content hash
  survives both reindex and upgrades-of-source, making warm runs O(diff).

### 4.2 — Hook `getSourceFacts`

- [ ] **File**: `src/source/source-facts.ts:42-54`
- **Source**: `scip-query refs getSourceFacts` consumers (ast-facts.ts, project-index.ts
  `callableSignature`, others); current behavior from `scip-query code getSourceFacts`
- **What**: `getSourceFacts` parses the tree (`getAst`) and walks it (`buildSourceFacts`)
  on first access per process — the 42% tree-sitter cost.
- **Change**: Before `getAst`: look up `source_facts` by path; on
  `content_hash`+`version` match, deserialize and return **without parsing**. On miss,
  build as today and write through. Serialization: `SourceFacts` Maps/Sets ↔ JSON
  (`typeContainerMap`, `identifierLineMap`, `identifiersByLine`, `fileIdentifiers`,
  `rustAttrReferencedNames`, `crossLanguageDispatchNames` converted explicitly; `callables`
  and `callSites` are already plain). Keep the in-process WeakMap in front (but key the
  in-process layer per `(db, path)` via `createPerDbSourceCache` semantics rather than the
  Tree, since on a persistent hit no Tree exists).
- **Why**: Biggest single cost in the profile; pure function of (content, language,
  extractor version) — zero accuracy risk.

### 4.3 — Hook `semanticCalleeMap`

- [ ] **File**: `src/semantic/shared-primitives.ts:48-60`
- **Source**: `scip-query outline src/semantic/shared-primitives.ts`; eagerness of provider from `scip-query code createTsMorphProvider`
- **What**: Per definition, gets the provider (constructing the ts-morph project on first
  touch) and computes callees.
- **Change**: Per definition, first consult `semantic_callees` keyed by
  `(relative_path, startLine, endLine, leaf)` validated against `content_hash`,
  `deps_digest`, `version`. Only on miss: `availableTypeScriptProvider` → compute → write
  through. `deps_digest` = sha256 over the sorted `(depPath, depContentHash)` pairs of the
  file's direct dependencies from `buildFileDepGraph` (memoized per-db). A full-hit run
  never constructs the ts-morph project.
  `referencesFor`/`findReferences` results are **deliberately not persisted** — they
  depend on the whole project, so per-file keys would be unsound; Phase 3 handles that
  cost instead.
- **Why**: Removes the remaining ~20% (and on large repos, the dominant ts-morph project
  load) from warm runs. Direct-dep digest catches the realistic cross-file invalidation
  (import/barrel changes); residual deeper-transitive staleness is the same class the
  SCIP index already accepts between reindexes.
- **Accepted approximation**: callees cached when both the file and its direct deps are
  byte-identical. A transitive-only change that alters resolution without touching the
  file or its direct deps serves stale callees until any of them change.

### 4.4 — Tests

- [ ] **File**: new `tests/evidence-cache.test.ts`; extend `tests/source-facts.test.ts`,
  `tests/incomplete-migration.test.ts`
- **Source**: `ls tests/` (tests are not SCIP-indexed — memory `scip-query-command-registration-ripple`)
- **Change**: Cover: cold build → warm hit (no parse — assert via spy/marker), content
  change → invalidation, version change → invalidation, corrupt payload → recompute,
  readonly cache dir → silent degradation, `--skip` validation, `--max-helpers`
  plumbing, fan-in-0 gating (def with SCIP consumers gets no semantic lookup; def with 0
  gets one).

## Stress-test findings (11 principles)

1. **Understand**: each modified function's purpose documented in Gate B; the deliberate
   design notes in `incompleteMigration`'s and `buildCalleeMap`'s docstrings are preserved
   (no evidence-merge changes anywhere).
2. **Blast radius**: `diffGate` consumers: `queries/index.ts`, `impact.ts` handler,
   `agent-setup.ts` (`DiffGateResult` shape only gains optional fields — Source:
   `scip-query refs diffGate`, `scip-query plan-context src/queries/diff-gate.ts` SURFACE).
   `getAllCalleeFingerprints` consumers (similar.ts ×2, incomplete-migration.ts) all
   iterate-only. `semanticCallerMap` consumers: `reference-callers.ts`, `change-surface.ts`,
   `diff-impact.ts` (Source: `scip-query refs semanticCallerMap`) — only the diff-impact
   call site changes. `getSourceFacts` is the riskiest hook (many consumers via ast-facts);
   mitigated by serialization round-trip test asserting deep equality on a fixture corpus.
3. **Intermediate states**: Phases ship independently in order 1 → 2 → 3 → 4; phase 2
   without phase 1 would be a perf regression (uncapped × rebuild), hence the order.
   Phases 3 and 4 are independent of each other.
4. **Reversibility**: all two-way doors. evidence.db is derived data — delete to reset.
   CLI default changes (uncapped) are behavioral but flag-reversible (`--max-echo-checks 10`).
5. **Failure**: cache I/O failures degrade to uncached computation (4.1); corrupt rows
   are misses; `git show` failures already return null (`fileContentAtBase:201-216`).
6. **Concurrency**: WAL + busy_timeout for concurrent CLI runs; writes are idempotent
   INSERT OR REPLACE of content-addressed rows — racing writers store identical payloads.
7. **Boundaries**: no new entry points; `--skip` values validated against the
   `DiffGateCheck` union before use.
8. **Data integrity**: evidence.db is a cache, never source of truth; content-hash keys
   make stale reads structurally impossible for single-file facts.
9. **Observability**: cache disable-on-error records the reason once on stderr when
   `SCIP_QUERY_DEBUG=1` (matches existing quiet-by-default CLI behavior); diff-gate
   `skipped` entries continue to name every check not run and why.
10. **Human**: default behavior change is strictly "more findings, faster"; skip
    messages for caps disappear by default (nothing silently truncated anymore);
    `--skip` makes the doc-reference opinion user-controllable.
11. **Reuse**: see Gate C table — per-db cache machinery, hash idiom, version source,
    `collectValues` all reused; one justified new module.

**Co-change partners** (Source: HISTORY section of `scip-query plan-context src/queries/similar.ts`;
`scip-query co-change`): `similar.ts` historically moves with `extract-candidates.ts` (85%),
`passthrough-candidates.ts` (71%), `wrapper-candidates.ts`, `dead.ts`, `stale-abstractions.ts` —
those co-changes track the shared *candidate-gate contract*
(`productionCallableDefinitions`), which this plan does not alter; partners untouched by
design. `diff-impact.ts` partners (`stale-abstractions.ts`, `wrapper-candidates.ts`, 67%)
co-changed for detector-profile reasons; the Phase 3 change is internal to
`diffImpactPartial` and alters no shared surface.

## Execution order

1 (memoize) → 2 (caps/flags) → 3 (fan-in gate) → 4 (persistent cache).
1, 3, 4 independently deployable; 2 depends on 1.

## Ship order / verification

After each phase: `npm run typecheck && npm test`. After all:
`npm run build && node dist/cli.js reindex && node dist/cli.js diff-gate --base <pre-work-commit>`
plus matching detectors (`recent-duplicates` for new helpers, `unused-params`,
`co-change` on schema-ish changes), and re-time the Gate A benchmark (`diff-gate --base HEAD~8`
capped-vs-uncapped, cold vs warm).

## Summary

- Modified: `src/queries/similar.ts`, `src/queries/diff-gate.ts`,
  `src/queries/incomplete-migration.ts`, `src/queries/diff-impact.ts`,
  `src/runtime/query-commands/impact.ts`, `src/source/source-facts.ts`,
  `src/semantic/shared-primitives.ts`, `docs/COMMAND_REFERENCE.md`
- Created: `src/storage/evidence-cache.ts`, `tests/evidence-cache.test.ts`,
  `docs/plans/2026-06-10-diff-gate-perf.md`
- Net delta: ~+450 lines (cache module + tests dominate)
