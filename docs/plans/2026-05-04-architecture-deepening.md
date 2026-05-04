# Architecture Deepening — 2026-05-04

A list of deepening opportunities for `scip-query`. The aim is to turn shallow modules into deep ones — surface less interface, hide more behaviour, concentrate complexity at one place instead of spreading it across callers.

Vocabulary (from `improve-codebase-architecture` skill):

- **Module** — anything with an interface and implementation.
- **Interface** — everything a caller must know: types, invariants, error modes, ordering, config.
- **Depth** — leverage at the interface. Deep = a lot of behaviour behind a small interface.
- **Seam** — a place where behaviour can be altered without editing in place.
- **Adapter** — concrete thing satisfying an interface at a seam.
- **Deletion test** — imagine deleting the module. If complexity vanishes, it was a pass-through. If complexity reappears across N callers, it was earning its keep.

Each candidate below has a friction description, a deletion-test verdict, and a `Status` field that tracks the grilling and execution state. Section order is roughly *highest leverage first*, but execution order will fall out of grilling.

---

## Process

For each candidate:

1. **Grill** — walk the design tree: constraints, dependencies, the shape of the deepened module, what sits behind the seam, what tests survive. Update this doc as decisions crystallize.
2. **Decide** — accept, reject, defer, or restructure. If rejected with a load-bearing reason, drop an ADR in `docs/adr/`.
3. **Execute** — make the changes, run tests, run smoke on `scip-query` + `Stable_Management` + `VegaAssistant`, commit.
4. **Verify** — `scip-query health` should not regress, all tests still pass, sample CLI invocations still produce sensible output.

Status legend: `pending` → `grilling` → `decided` → `executing` → `done`. `rejected` if dropped.

---

## 1. Identifier-attribution module

**Files involved:**
- `src/query-support.ts` — `hasUniqueLeafDefinition`, `sourceCandidateLines`, `importAttributedCandidateLines`, `buildSourceFallbackCallerFiles`
- `src/queries/dead.ts` — `leafToSymbolGlobal` index built locally, `resolveLeaf`

**Friction:** "Given a textual identifier hit in file F, which SCIP symbol does it resolve to?" is implemented **four** times. Each implementation reinvented the leaf-uniqueness check, the imports-as-disambiguator pass, the same-file shortcut, and the interface-impl-on-same-file fallback. The Vue and interface-dispatch fixes from the last few commits had to touch all four sites separately. Bugs found in one site silently coexist in the others.

**Deletion test:** Strong concentrate. The conceptual operation "leaf → symbol(s)" is one thing with one *correct* answer; the four current variants only differ in what they *do* with the answer (collect references vs. credit fan-in vs. flag dead).

**Status:** decided — ready to execute

**Decisions:**

- **Forward-call core.** The deep operation is per-occurrence: *"identifier `name` appears in file F — what symbol(s) does it refer to?"* Plural return handles interface-dispatch (multiple impls credited).
- **Inverse views are derived.** `findReferences(symbol)` and `findCallerFiles(symbols)` build on the forward call, with their cached inverses lazy per `ScipDatabase`.
- **Policy lives inside.** Same-file > direct import > interface-dispatch heuristic > empty-when-ambiguous is owned by the module. Callers get the answer, not raw candidates.
- **Take a leaf string** (not a `SymbolMatch`). Callers with a match write `attributeIdentifier(db, F, leafName(match.symbol))` — one line.
- **No roles for v1.** SCIP def/import/ref distinction is unused by today's four sites. Add later if a caller needs it.
- **No opt-out for the fast path.** The unique-leaf shortcut is an internal optimization; no caller benefits from picking a path manually.

**Interface:**

```ts
export interface SymbolRef {
  symbolId: number;
  relativePath: string;  // where the symbol is defined
}

// Core: forward, per-occurrence
export function attributeIdentifier(
  db: ScipDatabase,
  file: string,
  identifier: string,
): SymbolRef[];

// Derived: inverse views (cached)
export function findReferences(
  db: ScipDatabase,
  symbol: SymbolLocation,
): ReferenceSite[];

export function findCallerFiles(
  db: ScipDatabase,
  symbols: ReadonlyArray<IndexedDefinition>,
): Map<number, Set<string>>;
```

**Replaces:**
- `hasUniqueLeafDefinition` → internal helper
- `sourceCandidateLines` → folded into `findReferences` (unique-leaf fast path)
- `importAttributedCandidateLines` → folded into `findReferences` (ambiguous path)
- `buildSourceFallbackCallerFiles` → `findCallerFiles`
- `dead.ts:resolveLeaf` + `leafToSymbolGlobal` → callers use `attributeIdentifier`; leaf-index becomes a private cache inside the module

**Tests:** Existing CLI surface tests (refs/dead/dataflow command-accuracy) exercise this through unchanged commands. Add unit tests at the new boundary pinning the four disambiguation rules.

**Module location:** `src/identifier-attribution.ts` (new top-level module — peer of `symbol-parser.ts`, callable from any query without going through `query-support.ts`).

---

## 2. Split `query-support.ts` by concern

**Files involved:**
- `src/query-support.ts` (2077 LOC, 28 exports)

**Friction:** One module pretending to be four. Callers must learn 28 helper signatures because nothing is hiding behind a single concept.

**Deletion test:** Concentrate when split by concern. The 28-export grab-bag becomes four small focused modules; combined LOC is the same but you only read one at a time.

**Status:** decided — depends on #1 landing first

**Decisions:**

After #1 extracts its 5 functions, the remaining content splits into **four** modules:

| New module | Hides |
|---|---|
| `src/path-resolver.ts` | File-pattern → indexed path resolution, with on-disk fallback for unindexed types. `resolveIndexedFile`, `resolveIndexedPaths`, `resolveDocumentCandidates`, `resolveOnDiskFile` |
| `src/symbol-lookup.ts` | Symbol-pattern → `SymbolMatch`. Fuzzy match + candidate scoring. `findFirstSymbolMatch`, `getFullSymbolMatch`, `getSymbolLookupCandidates`, `scoreSymbolCandidate` |
| `src/definition-catalog.ts` | Per-file and per-project definitions, with AST-corrected ranges. `getDefinitionsForFile`, `getAllDefinitions`, `getScopedDefinitions`, `loadFileSymbols`, `findEnclosingDefinition`, `correctDefinitionRangesFromSource`, `correctDefinitionRangesFromAst` |
| `src/reference-graph.ts` | Bulk caller/callee maps. `buildCalleeMap`, `buildCrossFileCallerMap`, `buildCallerRowsMap`, `getCalleeRowsForSymbol`, `getCallerRowsForSymbol` |

- **Delete `query-support.ts`** rather than keeping as a re-export barrel. The renames force readers to know which concept they're reaching for; ~50 import-statement rewrites across queries are mechanical.
- **Types stay in `src/types.ts`.** `IndexedDefinition`, `SymbolMatch`, `SymbolLocation`, `ReferenceSite` are used across all four modules — moving them adds an import path nobody wants to relearn.
- **Layered, not parallel.** Lookup → Catalog → Graph (one-way arrows). Tests at each layer can stub the layer below.

**Tests:** Each new module gets its own focused unit-test file. Existing CLI surface tests survive unchanged.

---

## 3. Split `source-analysis.ts` by concern

**Files involved:**
- `src/source-analysis.ts` (2585 LOC, 13 exports, 6 WeakMap caches)

**Friction:** Four concerns conflated. Each WeakMap cache and helper shares the file but answers a different question.

**Deletion test:** Strong concentrate, along the concern axis (parser / identifier index / source stripper / import-path resolver).

**Status:** decided — execute together with #4

**Decisions:**

`source-analysis.ts` dissolves into four locations. Three of them are new top-level modules; the fourth is a directory of per-language adapters (locked in by #4):

| New module | Hides |
|---|---|
| `src/language-parsers/` | Per-language import/export AST parsers. One file per language. Adapter seam — see #4. |
| `src/identifier-index.ts` | `getFileIdentifiers`, `getIdentifierLineMap`, `getIdentifiersByLine`, `findIdentifierLines`, `computeIdentifierLineMap`, `collectIdentifiersOutside`, `collectMemberAccesses` |
| `src/import-path-resolver.ts` | Top-level `resolveImportPath` + the per-language path resolvers (`resolvePythonImportPath`, `resolveRustImportPath`, `resolveJavaScriptImportPath`, `resolveQualifiedImportPath`, etc.) |
| `src/source-stripper.ts` | `stripCommentsAndStrings`, `getStrippedLines`, `getStrippedSource`, `buildUsageBody`, `hasIdentifierUsage`. Used only by regex-fallback paths after the AST migration; small. |

- **Delete `source-analysis.ts`.** The aggregator role isn't carrying weight; consumers import from the right module.
- **`getSourceImports` / `getSourceExports`** — the per-language dispatcher functions become thin wrappers in `src/language-parsers/index.ts` (the registry — see #4).
- **`getReExports` / `getReExportsAst`** — JS/TS-specific re-export parsing, lives in `src/language-parsers/javascript.ts` alongside `parseJavaScriptImportsAst`.
- **Vue helpers** (`collectVueNonScriptIdentifiers`) — lives in `src/identifier-index.ts` near the other identifier walks, not in language-parsers (it's an identifier-collection variant, not an import parser).

**Tests:** Existing `tests/source-backed-accuracy.test.ts`, `tests/python-accuracy.test.ts`, `tests/import-fallbacks.test.ts` continue to work — they exercise public commands, not the internal split.

---

## 4. Per-language parser adapter seam

**Files involved:**
- 11 sibling functions inside `src/source-analysis.ts`: `parseJavaScriptImportsAst`, `parseJavaImportsAst`, `parseKotlinImportsAst`, `parseScalaImportsAst`, `parseRubyImportsAst`, `parseCLikeImportsAst`, `parseCSharpImportsAst`, `parsePhpImportsAst`, `parseVbImportsAst`, `parseRustImportsAst`, `parsePythonImportsAst`, plus their regex-fallback siblings, plus the dispatcher in `getSourceImports`.

**Friction:** Eleven adapters with the same shape but no named interface. Adding a language means hand-editing the dispatcher + source-extension list + AST language enum + adding a sibling function in 4 places.

**Deletion test:** Textbook *two-or-more adapters → real seam.* Naming the seam concentrates the eleven scattered patterns into one interface with eleven adapters.

**Status:** decided — execute together with #3

**Decisions:**

```ts
// src/language-parsers/types.ts
export interface LanguageParser {
  language: string;                // 'javascript' | 'java' | ...
  extensions: readonly string[];   // ['.js', '.jsx', '.mjs', '.cjs', '.vue']
  parseImports(db: ScipDatabase, importerPath: string, source: string): ParsedSourceImport[];
  parseExports?(db: ScipDatabase, importerPath: string, source: string): ParsedSourceExport[];
}
```

- **One adapter per language.** Layout: `src/language-parsers/javascript.ts`, `src/language-parsers/python.ts`, …, `src/language-parsers/vb.ts` (12 files including Vue treated as a JS variant).
- **Registry in `src/language-parsers/index.ts`.** Exports `getSourceImports(db, path)` and `getSourceExports(db, path)` — same interface today's callers use. Internally maps extension → adapter; falls back to `[]` when no adapter matches.
- **Each adapter owns AST + regex fallback.** A language file looks like:
  ```ts
  export const javascript: LanguageParser = {
    language: 'javascript',
    extensions: ['.js', '.jsx', '.mjs', '.cjs', '.vue'],
    parseImports(db, path, source) {
      const tree = getAst(db, path);
      if (tree) return parseJavaScriptImportsAst(db, path, tree);
      return parseJavaScriptImportsRegex(db, path, source);
    },
  };
  ```
  Both AST and regex helpers live in the same file. No more "scroll up 1500 lines to find the regex twin."
- **Adding a language = one new file + one registry entry.** No cross-cutting edits.

**Tests:** Add `tests/language-parsers/<lang>.test.ts` per language, exercising `parseImports` directly on a fixture file. The current import/export test files (`tests/import-fallbacks.test.ts`, `tests/source-backed-accuracy.test.ts`) still exercise the registry through public commands.

---

## 5. Source-fileset module

**Files involved:**
- `src/query-support.ts` — `listAuxiliarySourceFiles`, `collectAuxFiles`, `AUX_EXTENSIONS`, `AUX_SKIP_DIRS`
- `src/queries/dead.ts` — `collectSourceFilesInProject`, `SOURCE_EXTENSIONS` (its own set), `SKIP_DIRS`
- `src/source-analysis.ts` — `SOURCE_EXTENSIONS` (a third, different set)

**Friction:** Three different walks, three different extension sets, three different skip-dir lists. Vue support touched all three.

**Deletion test:** Concentrate. One module with a clear interface ("project source fileset, gitignore-aware, with extension filters") replaces three walks.

**Status:** decided — execute *before* #1 so attribution can use it

**Decisions:**

```ts
// src/source-fileset.ts
export interface SourceFilesetOptions {
  /** Include indexed files (the SCIP `documents` table). Default true. */
  includeIndexed?: boolean;
  /** Include on-disk source files of unindexed types like .vue. Default true. */
  includeAuxiliary?: boolean;
  /** Restrict to these extensions. Default: every supported source extension. */
  extensions?: readonly string[];
  /** Skip files matching gitignore. Default true. */
  respectGitignore?: boolean;
}

export function getSourceFiles(
  db: ScipDatabase,
  opts?: SourceFilesetOptions,
): string[];

/** Cheaper variant — just the auxiliary set, no SCIP query. */
export function getAuxiliarySourceFiles(
  db: ScipDatabase,
  opts?: { extensions?: readonly string[] },
): string[];
```

- **One owner for "what's a source file."** The module owns the master extension list (TS / JS / Rust / Python / Vue / Java / Kotlin / Scala / Ruby / C / C++ / C# / PHP / Dart / VB) and the skip-dir list (`node_modules`, `.git`, `target`, `dist`, `build`, `.next`, `.nuxt`, `.cache`, `.turbo`, `out`, `coverage`, `.scipquery-cache`, `__pycache__`).
- **Cached per-DB.** `getSourceFiles(db)` materializes once per (DB, options-hash); subsequent calls hit cache (uses #8's per-DB cache).
- **Replaces** `listAuxiliarySourceFiles` (query-support.ts), `collectSourceFilesInProject` (dead.ts), and the local `SOURCE_EXTENSIONS` arrays in dead.ts and source-analysis.ts.

**Tests:** Add `tests/source-fileset.test.ts` covering: extension filtering, skip-dir traversal, gitignore respect, indexed-vs-auxiliary union behavior.

---

## 6. Split `ast.ts` — runtime vs framework-knowledge

**Files involved:**
- `src/ast.ts` (1207 LOC, 20 exports)

**Friction:** Three concerns share the file because they all use tree-sitter.

**Deletion test:** Concentrate. AST runtime is genuinely deep and used everywhere; framework-knowledge is per-language registry data that grows independently of the runtime.

**Status:** decided

**Decisions:**

Three modules:

| Module | Hides |
|---|---|
| `src/ast.ts` (kept, slimmed) | AST runtime + generic symbol discovery. `loadGrammar`, `getParser`, `getAst`, `compileQuery`, `getVueScriptAst`, `extractVueScriptBlock`, `runCachedAstWalk`, `detectAstLanguage`, `isVueSfcPath`, `getCallableSites`, `getCallSites`, `getCallableSignature`, `extractCallLeaf`, types (`Tree`, `SyntaxNode`, `QueryInstance`, `AstLanguage`) |
| `src/framework-patterns.ts` (new) | Per-language framework patterns that static analysis can't see. `getDefinitionExclusions`, `getJsTestExclusions`, `getRustExclusions`, `collectSuppressionExclusions`, `isSuppressionComment`, `getCrossLanguageDispatchNames` |
| `src/passthrough-detect.ts` (new) | Body-shape passthrough detection (used by `passthrough-candidates` query). `isLiteralPassthrough`, `buildPassthroughIndex`, `isPassthroughBody` |

- **Why split passthrough out separately?** It's used by exactly one query (`passthrough-candidates`); pulling it out narrows `ast.ts`'s public surface to what every query uses (runtime + symbol discovery).
- **`framework-patterns.ts` keeps growing.** Each new framework pattern (Vue's defineProps, React server components, Tauri commands) gets a function in this file. The growth is per-language registry-style — no architectural pressure on `ast.ts`.
- **Don't touch the per-language exclusion logic itself.** It's correct as-is; just relocate.

**Tests:** Existing `tests/queries.test.ts`, `tests/queries-advanced.test.ts` exercise these through dead-code and passthrough-candidates queries. Move-only refactor; no test changes needed.

---

## 7. CLI rendering registry

**Files involved:**
- `src/cli.ts` (1688 LOC, ~54 `program.command(...).action(...)` blocks)

**Friction:** Every command duplicates parse opts → run query → render output. Improving consistency hits 54 places.

**Deletion test:** Moderate concentrate. A renderer registry with 5 shared shapes replaces ~800 LOC.

**Status:** decided — execute *last* (largest LOC change, lowest architectural risk)

**Decisions:**

```ts
// src/render.ts
export const render = {
  /** Items grouped by `relativePath`, lines ascending within group. Used by refs/dead/symbols/outline/system/surface. */
  groupedByFile<T extends { relativePath: string; startLine?: number }>(
    items: T[],
    formatItem: (item: T) => string,
  ): void;

  /** Title banner + body + footer line. Used by trace/dataflow/system/surface. */
  sectionedReport(sections: Array<{ title: string; explanation?: string; rows: string[] }>): void;

  /** One row per item, no grouping. Used by files/deps/rdeps/imports/imported-by. */
  list<T>(items: T[], formatItem: (item: T) => string): void;

  /** Aligned table with header. Used by hotspots/bottlenecks/fan-in/fan-out/complexity-hotspots. */
  table(headers: readonly string[], rows: readonly string[][]): void;

  /** Empty-state message. */
  empty(message: string): void;
};
```

- **Commander stays.** No declarative-command rework; the leverage of just centralizing rendering is enough.
- **Each command's `.action(...)` becomes ~3 lines:** `const result = queries.X(...); if (result.length === 0) return render.empty('...'); render.shape(result, formatItem);`
- **Per-command rendering can still customize.** A command needing a shape not in the registry inlines its own. The 5 shapes cover ~90% of current commands.
- **Utility helpers (`displayRange`, `formatLoc`)** move into `render.ts`.

**Tests:** Capture golden output for ~20 representative commands before, byte-diff after. No public-CLI behavior changes.

---

## 8. Per-DB cache module

**Files involved:**
- 12 `WeakMap<ScipDatabase, ...>` cache declarations across `src/query-support.ts`, `src/source-analysis.ts`, `src/source-text.ts`, `src/entry-surfaces.ts`, `src/ast.ts`

**Friction:** Same boilerplate 12 times. No central invalidation hook, no observability, no warming.

**Deletion test:** Concentrate boilerplate, preserve per-module ownership. The risk of over-centralizing is real — solve by keeping the cache *declaration* in each module, just sharing the *implementation*.

**Status:** decided — execute *first* (foundational helper, low risk, makes other refactors smaller)

**Decisions:**

```ts
// src/per-db-cache.ts
export interface PerDbCache<K, V> {
  /** Get-or-compute. Computes once per (db, key); subsequent calls hit cache. */
  get(db: ScipDatabase, key: K, compute: () => V): V;
  /** Drop one key for one DB (e.g., after a file change). */
  invalidate(db: ScipDatabase, key: K): void;
  /** Drop all keys for one DB (e.g., after reindex). */
  invalidateAll(db: ScipDatabase): void;
  /** For observability. */
  size(db: ScipDatabase): number;
}

export function createPerDbCache<K, V>(name: string): PerDbCache<K, V>;
```

- **Each module owns its cache *declaration*** — `const FILE_DEFINITION_CACHE = createPerDbCache<string, IndexedDefinition[]>('file-definitions');` — so cache lookups read normally and ownership stays clear.
- **`name` parameter** for future observability (a `--cache-stats` debug command, watch-induced invalidation logging).
- **Replaces** all 12 `WeakMap<ScipDatabase, Map<...>>` declarations and the `getCachedMap` helper.
- **Doesn't introduce a registry of all caches.** Each module still imports its own; we just stop hand-rolling the lookup.
- **`watch.ts` integration** stays a separate concern — when a file changes, watch.ts can call `cache.invalidate(db, file)` on the caches it knows about. No magic global invalidation.

**Tests:** Add `tests/per-db-cache.test.ts` covering get-or-compute, per-DB isolation, invalidation. The 12 modules' existing tests confirm cache behavior end-to-end.

---

## 9. Entry-point classifier

**Files involved:**
- `src/entry-surfaces.ts` — `isBarrelFile`, `isWorkerEntrySurface`, `isStructuralEntrySurface`, `getLiveBarrelPaths`, `getInactiveBarrelPaths`
- Informal use in `src/queries/dead.ts`, `src/queries/health.ts`, `src/queries/cycles.ts`, `src/queries/drift.ts`

**Friction:** Multiple competing definitions of "entry point" / "barrel" / "structural". Consumers can't tell which to use; per-query divergence creeps in.

**Deletion test:** Concentrate. One classifier with a small interface used uniformly everywhere lets every consumer make consistent decisions.

**Status:** decided

**Decisions:**

```ts
// src/file-classifier.ts (renames + replaces src/entry-surfaces.ts)

export type FileKind =
  | 'entry'      // CLI/server bootstraps, main.rs, index.ts at the project root, src/bin/*, scripts
  | 'barrel'     // re-export-only modules: index.ts/index.js, mod.rs, __init__.py
  | 'worker'     // background workers, child-process entry points
  | 'test'       // matches TEST_FILE_PATTERNS / TEST_SUPPORT_PATH_PATTERNS
  | 'source';    // everything else — regular code

export function classifyFile(db: ScipDatabase, file: string): FileKind;

/** Convenience predicates. Each is a single-property check on classifyFile's result. */
export function isEntry(db: ScipDatabase, file: string): boolean;
export function isBarrel(db: ScipDatabase, file: string): boolean;
export function isWorker(db: ScipDatabase, file: string): boolean;
export function isTest(db: ScipDatabase, file: string): boolean;
export function isSource(db: ScipDatabase, file: string): boolean;

/** Live-barrel transitive-closure (used by dead-code skip-barrels). */
export function getLiveBarrelPaths(db: ScipDatabase): Set<string>;
export function getInactiveBarrelPaths(db: ScipDatabase): Set<string>;
```

- **One classification function** owns every per-language heuristic. `dead`/`health`/`cycles`/`drift` each call the same `classifyFile` with consistent results.
- **`FileKind` is a closed enum.** When a future contributor wants a new category they edit the type; the compiler then forces every consumer's switch to handle it.
- **Replaces** `src/entry-surfaces.ts` (renamed + restructured) and removes the `isEntrySurface` / `isBarrelFile` / `isWorkerEntrySurface` / `isStructuralEntrySurface` ad-hoc set.
- **Test-file detection consolidates here** too — `TEST_FILE_PATTERNS` / `TEST_SUPPORT_PATH_PATTERNS` move from `query-support.ts` into this module, since "is this a test file?" is one of the file-kind questions.

**Tests:** Add `tests/file-classifier.test.ts` covering each `FileKind` case across languages. `tests/debloat-health.test.ts` continues to exercise the integration through `health`.

---

## 10. Similarity-math module

**Files involved:**
- `src/queries/similar.ts` (517 LOC) — TF-IDF over callees
- `src/queries/similar-files.ts` (151 LOC) — Jaccard over file deps
- `src/queries/similar-chains.ts` (314 LOC) — similarity over dep chains
- `src/queries/similar-signatures.ts` (279 LOC) — similarity over signatures

**Friction:** Same TF-IDF / Jaccard / weighted-cosine math implemented four times; only the input shape changes.

**Deletion test:** Concentrate. One math kernel; each query becomes a thin input-shape-mapper.

**Status:** decided — execute *near the end*; small duplication per query, lower urgency

**Decisions:**

```ts
// src/similarity.ts — generic over feature type T
export interface SimilarityKernel<T> {
  /** Compute IDF weights across a corpus. */
  idf(documents: ReadonlyArray<Set<T>>): Map<T, number>;

  /** Cosine similarity weighted by IDF. Returns the score plus shared and unique splits. */
  weightedCosine(
    a: Set<T>,
    b: Set<T>,
    weights: Map<T, number>,
  ): { similarity: number; sharedSignificant: T[]; sharedTrivial: T[]; uniqueA: T[]; uniqueB: T[] };

  /** Plain Jaccard for sets where IDF isn't appropriate. */
  jaccard(a: Set<T>, b: Set<T>): number;

  /** Find pairs (i, j) with similarity ≥ threshold. Inverted-index optimized. */
  rankPairs<I>(
    items: ReadonlyArray<I>,
    extractFeatures: (item: I) => Set<T>,
    opts: { minSimilarity: number; minShared?: number; minSignificantShared?: number; limit: number },
  ): Array<{ a: I; b: I; similarity: number; shared: T[] }>;
}

export function createSimilarityKernel<T>(): SimilarityKernel<T>;
```

- **Generic over feature type `T`.** `similar.ts` uses `T = string` (callee symbol). `similar-files.ts` uses `T = string` (file path). `similar-signatures.ts` uses `T = string` (signature shape token). Each query just passes `extractFeatures` and gets ranked pairs.
- **Kernel is stateless** (apart from the math) — no caching inside. Callers (the query modules) own caching of the corpus they extract.
- **Replaces** `computeIdf`, `weightedSimilarity`, `intersection`, `difference`, `comparePair` in all four `similar*` files. Each query file shrinks to ~50–80 LOC focused on what features to extract from a definition.

**Tests:** `tests/similarity.test.ts` covering TF-IDF correctness, weighted-cosine edge cases (empty intersection, weight=0), and `rankPairs` thresholds. The four `similar*` queries' existing tests confirm end-to-end behavior.

---

## Explicitly skipped

These were considered and rejected as not worth deepening — listed so future architecture reviews don't re-suggest them:

- **`src/symbol-parser.ts`** — already a deep module hiding SCIP grammar. Sole external dependency is `types.ts`. Leave alone.
- **`src/db.ts`** — appropriately shallow for its scope. Callers actually use the SQL-fragment composition; deepening into a query-builder would hurt flexibility.
- **`src/reindex/`** — clean internal structure (detect / install / indexers / merge). Only friction is two callers (`cli.ts` + `reindex-worker.ts`) re-orchestrating; minor.

---

## Execution order

Dependencies + risk dictate the sequence. Each step ships independently — build, install globally, run tests + smoke on `Stable_Management` and `VegaAssistant`, commit.

| # | Order | Why this slot |
|---|---|---|
| **#8** Per-DB cache | 1st | Foundational helper. Other refactors are smaller because they use it. Low risk. |
| **#5** Source-fileset | 2nd | #1 needs it. #3 wants it too. Replaces 3 walks today. |
| **#9** File classifier | 3rd | Independent of others. Small. Tightens semantics for downstream consumers. |
| **#1** Identifier-attribution | 4th | Highest leverage. Replaces 4 reimplementations. Uses #5 + #8. |
| **#4** Per-language adapters | 5th | Sets up the seam #3 will collapse around. |
| **#3** Split source-analysis | 6th | Together with #4. Biggest single refactor. |
| **#2** Split query-support | 7th | After #1 carved its 5 functions out, the remaining 23 split cleanly into 4. |
| **#6** Split ast.ts | 8th | Independent move-only refactor. |
| **#10** Similarity module | 9th | Lower urgency; small per-query duplication. |
| **#7** CLI render registry | 10th | Largest LOC change but lowest architectural risk; do last so it doesn't block earlier work. |

## Ship sequence (one-liner per step)

1. `src/per-db-cache.ts` + replace 12 cache declarations
2. `src/source-fileset.ts` + replace `listAuxiliarySourceFiles` + `collectSourceFilesInProject`
3. `src/file-classifier.ts` (rename of `entry-surfaces.ts`) + consolidate test-file detection
4. `src/identifier-attribution.ts` + delete the 4 reimplementations
5. `src/language-parsers/{js,py,rust,...}.ts` + registry
6. Split `source-analysis.ts` → `identifier-index.ts` + `import-path-resolver.ts` + `source-stripper.ts`; delete `source-analysis.ts`
7. Split `query-support.ts` → `path-resolver.ts` + `symbol-lookup.ts` + `definition-catalog.ts` + `reference-graph.ts`; delete `query-support.ts`
8. Split `ast.ts` → keep `ast.ts` (slim) + `framework-patterns.ts` + `passthrough-detect.ts`
9. `src/similarity.ts` + collapse the four `similar*` queries
10. `src/render.ts` + collapse 54 inline renderers
