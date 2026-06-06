# Vega Accuracy Calibration

Date: 2026-06-06

This report records what happened when scip-query was tested against the
Vega_2.0 codebase. Treat every finding as untrusted until sampled against
source evidence.

## Vega_2.0

Path: `/Users/aydansalois/Documents/GitHub/Vega_2.0`

### Full reindex

Initial status: failed closed.

```text
Detected languages: typescript, python
Indexing typescript with scip-typescript...
Indexing python with scip-python...
Skipping python: scip-python indexer failed
Indexed 1 of 2 languages; skipped python.
error: Failed to index all required languages; preserving the previous index.
```

The full configured reindex failed closed because Vega_2.0 declares both
TypeScript and Python, and scip-query invoked `npx scip-python`. That command
asks npm for a package literally named `scip-python`, which does not exist in
the npm registry. The intended package is `scip-python-plus`.

Fix: Python indexing now prefers `scip-python-plus` and executes the bundled
optional dependency's concrete bin path when it is installed with scip-query.

After the fix, the full Vega_2.0 configured reindex succeeded:

```text
Detected languages: typescript, python
Indexing typescript with scip-typescript...
Indexing python with scip-python-plus...
Merging 2 language indexes...
Converting to SQLite...
Done in 37.6s
Indexed typescript, python in 37.6s
```

The replay cache used for command calibration was rebuilt with:

```text
SCIP_QUERY_PROJECT_ROOT=/Users/aydansalois/Documents/GitHub/Vega_2.0
SCIP_QUERY_CACHE_DIR=/tmp/scip-query-vega-full-cache
node dist/cli.js reindex --force --indexer-concurrency 1
```

The cache metadata recorded:

```text
status: complete
requestedLanguages: typescript, python
indexedLanguages: typescript, python
skipped: []
```

The installed bundled Python indexer was `scip-python-plus 0.7.4`.

### TypeScript-only calibration

A TypeScript-only index was built with an isolated cache:

```text
Indexed 1,404 files
87,428 symbols
58.7 MB
33.5s
```

Health on that TypeScript-only index:

```text
Score: 93/100
Dead code: 41 symbols, 596 LOC
Similar pairs: 50
Extract candidates: 5
Wrapper functions: 50
Passthroughs: 50
Stale abstractions: 50
```

### Verified false positive

`dead apps/api/src/db --min-loc 5 --skip-barrels --only-dead` reported:

```text
apps/api/src/db/migrate.ts
  488-560  (73 LOC)  src:db:migrate:runMigrations()
```

Source evidence showed this was wrong:

```text
apps/api/src/index.ts imports runMigrations from ./db/migrate.js
apps/api/src/index.ts awaits runMigrations() inside main()
call-graph runMigrations reports caller src:index:main()
```

Root cause: `apps/api/src/index.ts` was classified as an inactive barrel when
`--skip-barrels` was enabled. That erased the bootstrap file's reference before
dead-code classification. The fix classifies `apps/*/src/index.ts` and
`services/*/src/index.ts` as entry surfaces, not barrels.

After the fix:

```text
$ scip-query dead apps/api/src/db --min-loc 5 --skip-barrels --only-dead
No matching dead-code symbols found.
```

### Additional dead-code guardrails

- Data members are excluded from `dead` by default unless `--include-members`
  is set. Field/property liveness is weaker across SCIP indexers and should not
  be labeled safe-to-delete by default.
- Unused import bindings no longer count as liveness evidence in `dead`.
  Importing a symbol without using the local binding is not enough to mark the
  exported symbol live.
- `dead` now supplements raw mention evidence with caller-row evidence so a
  callable with a recovered call-graph caller is not reported as dead.

### Multi-language command calibration

The TypeScript+Python Vega index exposed several non-dead-code accuracy bugs:

- Fenced TypeScript signatures containing union types were split at `|`.
  Signature extraction now treats fenced code blocks as atomic signatures.
- `code` showed `[unknown]` when an index row omitted document language.
  It now falls back to the source file extension.
- Files with both primary `defn_enclosing_ranges` and role-one fallback
  definitions hid top-level singleton exports. Definition lookup now merges
  precise top-level fallback rows without reintroducing nested/property noise.
- Controller classes instantiated as exported singletons were reported as stale
  abstractions even when the singleton had real cross-file consumers. The stale
  abstraction query now recognizes that framework/controller pattern.
- Top-level constants could inherit overly wide fallback ranges and become fake
  callers. Source correction narrows top-level `const`/`let`/`var` ranges.
- `slice --forward` answered "symbols used alongside the target." It now
  answers the command's actual question: enclosing consumers that reference the
  target.
- `similar-signatures` truncated TypeScript object/generic return types during
  source fallback. It now reuses the shared SCIP signature cleaner and preserves
  object return signatures such as `Promise<{ updated: number; }>`.
- `affected` propagated through module/file symbols and plain constants. It now
  restricts propagation to executable callable definitions and type definitions.
- `similar` used lexical source-token fallback when no callee-fingerprint
  match existed but still labeled those tokens as callees. Results now expose
  the evidence basis and the CLI prints `Shared source tokens` for fallback
  matches.
- `bottlenecks` used file-level fan-out SQL and assigned that fan-out to every
  symbol in the file, which made modules, singleton variables, route variables,
  and fields look like coupling hubs. It now uses canonical callable
  definitions plus caller/callee rows.
- Python AST call resolution could cross languages when a stdlib/external leaf
  name matched a unique TypeScript symbol. For example, `os.path.exists()` in
  `scripts/generate_checklist.py` was resolved to a TypeScript `exists()`
  helper. AST leaf fallback now stays inside the source language family.

Vega spot checks after the fixes:

```text
slice buildIssueChunks --forward --depth 2
  issue-embeddings.service.ts module import
  IssueEmbeddingsService:indexIssue()

affected buildIssueChunks --max-depth 2
  depth 1: IssueEmbeddingsService:indexIssue()
  depth 2: IssueEmbeddingsService:reindexIssue()

health --scope apps/api/src/modules/issues
  Codebase Health Score: 95/100

bottlenecks --scope apps/api/src/modules/issues --limit 15
  returns callable methods/functions only

call-graph parse_cov
  no project callees for Python os.path.exists()

reindex --language python --force
  Indexed python in 4.4s with scip-python-plus
  symbols scripts/generate_checklist.py returned parse_cov() and generate_checklist()

augment-vue --project apps/web/tsconfig.json
  fails with actionable dependency guidance when @vue/language-core is absent

watch
  starts and handles SIGINT cleanly in a temp project

init / status / check-deps / install-skills
  exercised with temp HOME/project roots or the Vega cache
```

### Remaining command accuracy concerns

- `drift` is noisy at Vega scale because many sibling directories naturally
  have unique dependency edges. Unique dependency edges are observations, not
  automatic architectural violations.
- `similar` source-token fallback can still be low-signal when the shared
  tokens are common domain words. The output now identifies that evidence as
  source-token similarity rather than call-graph similarity.
