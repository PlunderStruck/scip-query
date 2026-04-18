# Language-Dispatch Consolidation

**Date**: 2026-04-15
**Scope**: Consolidate duplicated language-dispatch code, extract shared helpers, delete dead code
**Baseline health score**: 78/100
**Target health score**: 83+/100

---

## Problem Statement

The codebase contains systematic duplication rooted in per-language dispatch:

1. **13 `get*SourceCalleeRows` functions** (src/query-support.ts lines 636-953) each resolve call targets for a single language. All share the same `(db, symbol, limit?) => CalleeRow[]` signature and 7 common callees. The only variation is the language predicate and the call-target resolver. These are dispatched by `getSourceBackedCalleeRows()` (lines 894-953, cyclomatic complexity 15).

2. **12 `is*Document` functions** (src/query-support.ts lines 2034-2179) each query `SELECT language FROM documents` then check a language string and file extension. Every function is structurally identical; only the language name and extension pattern vary.

3. **12 `is*SourcePath` functions** (src/source-analysis.ts lines 1510-1548) each call `extname().toLowerCase()` against a constant array. Pure boilerplate; the only variation is which constant array.

4. **4 identical `getScopedDefinitions` copies** across extract-candidates.ts:144, passthrough-candidates.ts:63, wrapper-candidates.ts:75, stale-abstractions.ts:77. Character-for-character identical.

5. **4 dead symbols**, **2 unused types**, **2 duplicated `isCallableSymbol` functions**.

This duplication accounts for ~550 LOC of pure structural repetition and makes adding a new language require touching 3+ locations.

---

## Discovery Evidence

All claims below cite the specific scip-query command that produced them.

### 1. Callee-row functions (13 variants)

**Source**: `scip-query symbols src/query-support.ts` (b2)

| Function | Lines | Shape |
|---|---|---|
| `getPythonSourceCalleeRows` | 636-689 | Complex resolver (imports + bindings + `resolvePythonCallTarget`) |
| `getJavaScriptSourceCalleeRows` | 691-744 | Complex resolver (imports + bindings + `resolveJavaScriptCallTarget`) |
| `getJavaSourceCalleeRows` | 746-759 | Simple resolver (`parseJavaFieldBindings` + `resolveSimpleSourceCallees`) |
| `getKotlinSourceCalleeRows` | 761-774 | Simple resolver (`parseKotlinFieldBindings` + `resolveSimpleSourceCallees`) |
| `getScalaSourceCalleeRows` | 776-788 | Simple resolver (no bindings + `resolveSimpleSourceCallees`) |
| `getCSharpSourceCalleeRows` | 790-802 | Simple resolver (no bindings + `resolveSimpleSourceCallees`) |
| `getVisualBasicSourceCalleeRows` | 804-816 | Simple resolver (no bindings + `resolveSimpleSourceCallees`) |
| `getCppSourceCalleeRows` | 818-831 | Simple resolver (`parseCppReceiverBindings` + `resolveSimpleSourceCallees`) |
| `getRustSourceCalleeRows` | 833-845 | Simple resolver (no bindings + `resolveSimpleSourceCallees`) |
| `getRubySourceCalleeRows` | 847-864 | Simple resolver (special: `allowInstanceVariables`, `allowBareMemberCalls`) |
| `getDartSourceCalleeRows` | 866-878 | Simple resolver (no bindings + `resolveSimpleSourceCallees`) |
| `getPhpSourceCalleeRows` | 880-892 | Simple resolver (no bindings + `resolveSimpleSourceCallees`) |
| `getSourceBackedCalleeRows` (dispatch) | 894-953 | 12-branch if/else chain |

**Verified source**: `scip-query code <each symbol>` (b6-b18)

**Similarity**: `scip-query similar getJavaSourceCalleeRows` (b63) confirms 100% callee overlap for 5 pairs, 68% for 6 pairs.

**Two shape classes emerge**:

- **Complex**: Python and JavaScript use `getSourceImports`, `getSourceConstructorBindings`, `getSourceCalls`, and a language-specific `resolve*CallTarget` function. These iterate calls inline and build rows.
- **Simple**: All others call `getSimpleSourceCalls` + an optional binding parser + `resolveSimpleSourceCallees`.

### 2. is*Document functions (12 variants)

**Source**: `scip-query code isPythonDocument`, `isJavaScriptDocument`, etc. (b19-b22, b27)

Every function:
1. Runs `SELECT language FROM documents WHERE relative_path = ? LIMIT 1`
2. Checks `row?.language === '<name>'`
3. Falls back to a file-extension regex/endsWith check

Variations:
- `isJavaScriptDocument` checks two language values (`'typescript'`, `'javascript'`) and uses a regex
- `isCppDocument` checks `'CPP'` and uses a regex for multiple extensions
- All others check a single language value and use `endsWith`

**Callers**: Each is called only within query-support.ts itself (b33, b34, b52). Zero external consumers confirmed by `scip-query change-surface src/query-support.ts` (b67).

### 3. is*SourcePath functions (12 variants)

**Source**: `scip-query code isJavaScriptSourcePath`, etc. (b23-b26, b50)

Every function calls `extname(relativePath).toLowerCase()` and checks against a constant array. Exception: `isVisualBasicSourcePath` hardcodes `=== '.vb'`.

**Extension constants** (source-analysis.ts lines 48-56, from b54):
- `SOURCE_EXTENSIONS`, `PYTHON_SOURCE_EXTENSIONS`, `JVM_SOURCE_EXTENSIONS`, `RUST_SOURCE_EXTENSIONS`, `RUBY_SOURCE_EXTENSIONS`, `C_LIKE_SOURCE_EXTENSIONS`, `DOTNET_SOURCE_EXTENSIONS`, `DART_SOURCE_EXTENSIONS`, `PHP_SOURCE_EXTENSIONS`

**Callers**: All within source-analysis.ts (b51). Used by `getSourceImports`, `getSourceCalls`, `getSourceConstructorBindings`, `extensionFamilyFor`, and the import-parsing dispatch.

### 4. getScopedDefinitions (4 identical copies)

**Source**: `scip-query code` for each copy (b28). All 4 are character-for-character identical.

**Callers**: Each called once in its own file (b56):
- `src/queries/extract-candidates.ts` line 1
- `src/queries/passthrough-candidates.ts` line 1
- `src/queries/wrapper-candidates.ts` line 1
- `src/queries/stale-abstractions.ts` line 1

**Callees**: All 4 call `db.pathExclusionsFor()`, `getDefinitionsForFile()`, `db.isIgnored()` (b55).

### 5. Dead symbols

**Source**: `scip-query dead --min-loc 3` (b5) + `scip-query refs` (b36) confirm zero external references.

| Symbol | Location | LOC |
|---|---|---|
| `testFileMatchSql()` | src/query-support.ts:82-87 | 6 |
| `setPathFilter()` | src/db.ts:33-35 | 3 |
| `filterPaths()` | src/db.ts:43-45 | 3 |
| `Watcher.getStatus()` | src/watch.ts:111-113 | 3 |

### 6. Unused types

**Source**: `scip-query refs` (b60, b61)

| Type | Location | Referenced by |
|---|---|---|
| `InstallMethod` | src/types.ts:509-518 | Only by `IndexerConfig.installMethods` field (line 562) |
| `IndexerOverrides` | src/types.ts:603-606 | Only by `ProjectConfig.indexer` field (line 587) |

**Important**: `InstallMethod` is referenced by `IndexerConfig.installMethods` (line 562, b58). `IndexerOverrides` is referenced by `ProjectConfig.indexer` (line 587, b59). Both types are used only as field types in other interfaces. Removing them requires also removing the referencing fields, which are themselves unused. Verify at implementation time with `scip-query refs` for those specific fields.

### 7. Duplicate isCallableSymbol

**Source**: `scip-query code` (b31), `scip-query convergence` (b64)

Both copies at methods.ts:37 and surface.ts:76 are identical:
```typescript
function isCallableSymbol(rawSymbol: string): boolean {
  return rawSymbol.endsWith('().') || leafSuffix(rawSymbol) === 'method';
}
```

100% callee overlap. Single shared callee: `leafSuffix()` from symbol-parser.ts. Each called once within its own file (b38).

---

## Design

### Phase 1: Delete Dead Code and Unused Types (zero-risk)

**Files modified**: src/query-support.ts, src/db.ts, src/watch.ts, src/types.ts

1. **Delete `testFileMatchSql()`** at src/query-support.ts:82-87
   - Source: `scip-query code src:query-support:testFileMatchSql()` (b29)
   - Refs: zero (b36)
   - Action: Remove the 6-line exported function

2. **Delete `setPathFilter()`** at src/db.ts:33-35
   - Source: `scip-query code src:db:ScipDatabase:setPathFilter()` (b29)
   - Refs: zero (b36)
   - Action: Remove the 3-line method. Also remove the `pathFilter` property if it becomes unused after this + filterPaths removal.

3. **Delete `filterPaths()`** at src/db.ts:43-45
   - Source: `scip-query code src:db:ScipDatabase:filterPaths()` (b29)
   - Refs: zero (b36)
   - Action: Remove the 3-line method

4. **Delete `Watcher.getStatus()`** at src/watch.ts:111-113
   - Source: `scip-query code src:watch:Watcher:getStatus()` (b29)
   - Refs: zero (b36)
   - Action: Remove the 3-line method. Keep the `status` field (used by `setStatus`).

5. **Delete `InstallMethod`** at src/types.ts:509-518
   - Source: `scip-query code src:types:InstallMethod` (b30)
   - Refs: only self-definition (line 509) and IndexerConfig.installMethods (line 561) (b60)
   - Action: Remove the 10-line interface AND the `installMethods?: InstallMethod[]` field from IndexerConfig (line 562). Verify no runtime code reads `installMethods` with `scip-query refs` at implementation time.

6. **Delete `IndexerOverrides`** at src/types.ts:603-606
   - Source: `scip-query code src:types:IndexerOverrides` (b30)
   - Refs: only self-definition (line 603) and ProjectConfig.indexer (line 587) (b61)
   - Action: Remove the 4-line interface AND the `indexer?` field from ProjectConfig (line 588). Verify no runtime code reads `indexer` with `scip-query refs` at implementation time.

**Net delta**: ~-32 LOC
**Validation**: `npm run build` must succeed. `scip-query dead --min-loc 3` must no longer list these 4 symbols. `scip-query refs` for each removed symbol must return nothing.

### Phase 2: Merge Duplicate isCallableSymbol

**Files modified**: src/queries/methods.ts, src/queries/surface.ts, src/query-support.ts (or a shared util)

1. **Extract `isCallableSymbol`** into src/query-support.ts as an exported function
   - Source: `scip-query convergence src:queries:methods:isCallableSymbol() src:queries:surface:isCallableSymbol()` (b64) confirms 100% overlap
   - Placement rationale: query-support.ts already exports symbol-classification helpers like `isCallableDefinition()` (line 1402). Both methods.ts and surface.ts already import from query-support.ts.
   - If query-support.ts is judged too large, place in symbol-parser.ts (which already exports `leafSuffix`, the sole callee).

2. **Update methods.ts** (line 37-39): Replace local definition with import from query-support.ts
   - Caller at methods.ts line 1 (b38)

3. **Update surface.ts** (line 76-78): Replace local definition with import from query-support.ts
   - Caller at surface.ts line 1 (b38)

**Net delta**: ~-3 LOC (one definition removed, one import added per consumer)
**Validation**: `npm run build` must succeed. `scip-query refs src:query-support:isCallableSymbol()` must show both methods.ts and surface.ts as consumers.

### Phase 3: Extract Shared getScopedDefinitions

**Files modified**: src/query-support.ts, src/queries/extract-candidates.ts, src/queries/passthrough-candidates.ts, src/queries/wrapper-candidates.ts, src/queries/stale-abstractions.ts

1. **Add `getScopedDefinitions` to src/query-support.ts** as an exported function
   - Source: any of the 4 copies (b28) -- they are identical
   - Signature: `(db: ScipDatabase, scope?: string) => IndexedDefinition[]`
   - Implementation: verbatim copy of any existing version

2. **Replace each local copy** with an import from query-support.ts:
   - extract-candidates.ts:144-160 (b28)
   - passthrough-candidates.ts:63-79 (b28)
   - wrapper-candidates.ts:75-91 (b28)
   - stale-abstractions.ts:77-93 (b28)

**Net delta**: ~-51 LOC (4 x 17 LOC removed, 1 x 17 LOC added)
**Validation**: `npm run build` must succeed. `scip-query refs src:query-support:getScopedDefinitions()` must list all 4 consumer files.

### Phase 4: Consolidate is*SourcePath into Lookup Table

**Files modified**: src/source-analysis.ts

1. **Create a `LANGUAGE_EXTENSIONS` map** near line 48 (after the existing constants):
   ```typescript
   const LANGUAGE_EXTENSIONS: ReadonlyMap<string, readonly string[]> = new Map([
     ['javascript', SOURCE_EXTENSIONS],
     ['python', PYTHON_SOURCE_EXTENSIONS],
     ['jvm', JVM_SOURCE_EXTENSIONS],
     ['rust', RUST_SOURCE_EXTENSIONS],
     ['ruby', RUBY_SOURCE_EXTENSIONS],
     ['c-like', C_LIKE_SOURCE_EXTENSIONS],
     ['dotnet', DOTNET_SOURCE_EXTENSIONS],
     ['dart', DART_SOURCE_EXTENSIONS],
     ['php', PHP_SOURCE_EXTENSIONS],
   ]);
   ```

2. **Create `isSourcePathForFamily(relativePath, family)`** generic checker:
   ```typescript
   function isSourcePathForFamily(relativePath: string, family: string): boolean {
     const extensions = LANGUAGE_EXTENSIONS.get(family);
     return extensions ? extensions.includes(extname(relativePath).toLowerCase() as any) : false;
   }
   ```

3. **Replace each `is*SourcePath` function** with a one-liner delegation:
   - `isJavaScriptSourcePath` -> `isSourcePathForFamily(relativePath, 'javascript')` (line 1510-1512)
   - `isPythonSourcePath` -> `isSourcePathForFamily(relativePath, 'python')` (line 1514-1516)
   - `isJvmSourcePath` -> `isSourcePathForFamily(relativePath, 'jvm')` (line 1518-1520)
   - `isRustSourcePath` -> `isSourcePathForFamily(relativePath, 'rust')` (line 1522-1524)
   - `isRubySourcePath` -> `isSourcePathForFamily(relativePath, 'ruby')` (line 1526-1528)
   - `isCLikeSourcePath` -> `isSourcePathForFamily(relativePath, 'c-like')` (line 1530-1532)
   - `isDotNetSourcePath` -> `isSourcePathForFamily(relativePath, 'dotnet')` (line 1534-1536)
   - `isDartSourcePath` -> `isSourcePathForFamily(relativePath, 'dart')` (line 1542-1544)
   - `isPhpSourcePath` -> `isSourcePathForFamily(relativePath, 'php')` (line 1546-1548)

4. **Handle `isVisualBasicSourcePath` special case**: Currently hardcodes `=== '.vb'` (line 1539). The DOTNET_SOURCE_EXTENSIONS array is `['.cs', '.vb']`, so VB is a subset. Keep the named function as a one-liner delegation or fold into dotnet.

5. **Rewrite `extensionFamilyFor`** (lines 1550-1559) to iterate the map instead of a chain of if-statements.

**Rationale for keeping named functions**: The 12 callers (b51) all use the named `is*SourcePath` form. Keeping thin wrappers avoids a blast-radius explosion and preserves readability at call sites. The deduplication win is that the actual extension logic lives in one place.

**Net delta**: ~-10 LOC (12 functions shrink to 1-liners, one generic + map added)
**Validation**: `npm run build` must succeed. Manually verify `extensionFamilyFor` returns the same values for representative paths.

### Phase 5: Consolidate is*Document into Lookup Table

**Files modified**: src/query-support.ts

1. **Create a `DOCUMENT_LANGUAGE_TABLE`** near line 2034:
   ```typescript
   const DOCUMENT_LANGUAGE_TABLE: ReadonlyArray<{
     languages: readonly string[];
     extensionPattern: RegExp;
   }> = [
     { languages: ['python'], extensionPattern: /\.(?:py|pyi)$/ },
     { languages: ['typescript', 'javascript'], extensionPattern: /\.(?:[cm]?[jt]sx?)$/ },
     { languages: ['java'], extensionPattern: /\.java$/ },
     { languages: ['kotlin'], extensionPattern: /\.(?:kt|kts)$/ },
     { languages: ['scala'], extensionPattern: /\.scala$/ },
     { languages: ['C#'], extensionPattern: /\.cs$/ },
     { languages: ['Visual Basic'], extensionPattern: /\.vb$/ },
     { languages: ['CPP'], extensionPattern: /\.(?:cc|cpp|cxx|hpp|hh|hxx)$/ },
     { languages: ['Rust'], extensionPattern: /\.rs$/ },
     { languages: ['ruby'], extensionPattern: /\.rb$/ },
     { languages: ['Dart'], extensionPattern: /\.dart$/ },
     { languages: ['PHP'], extensionPattern: /\.php$/ },
   ];
   ```

2. **Create `isDocumentLanguage(db, relativePath, entry)`** generic checker:
   ```typescript
   function isDocumentLanguage(
     db: ScipDatabase,
     relativePath: string,
     entry: typeof DOCUMENT_LANGUAGE_TABLE[number],
   ): boolean {
     const row = db.get<{ language: string | null }>(
       `SELECT language FROM documents WHERE relative_path = ? LIMIT 1`,
       relativePath,
     );
     return entry.languages.includes(row?.language ?? '')
       || entry.extensionPattern.test(relativePath);
   }
   ```

3. **Replace each `is*Document` function** body with a one-liner calling `isDocumentLanguage`. Keep the named functions as thin wrappers (they're called by name throughout lines 636-953 and in `getSourceBackedCalleeRows`). This preserves all call-site semantics and avoids touching 24+ call sites.

**Net delta**: ~-90 LOC (12 x 11 LOC functions collapse to 12 x 3 LOC wrappers + 1 generic + 1 table)
**Validation**: `npm run build` must succeed. For each language, verify the wrapper returns the same result as the original by checking the language string and extension pattern match.

### Phase 6: Consolidate get*SourceCalleeRows into Generic Dispatch

**Files modified**: src/query-support.ts

This is the highest-risk phase. The 13 functions (12 language-specific + 1 dispatch) span lines 636-953.

**Analysis of variation points** (from scip-query code reads b6-b18):

**Shape A -- "Complex resolver" (Python, JavaScript)**:
- Gets `match` via `getFullSymbolMatch`, checks `is*Document`
- Gets `definitions`, `imports`, `constructorBindings`
- Iterates `getSourceCalls(db, ...)` and calls a language-specific `resolve*CallTarget` function
- Builds rows with `chunkId = 1_000_000_000 + call.line`

**Shape B -- "Simple resolver" (Java, Kotlin, Scala, C#, VB, C++, Rust, Dart, PHP)**:
- Gets `match` via `getFullSymbolMatch`, checks `is*Document`
- Calls `getSimpleSourceCalls(db, ...)` with optional language-specific options
- Calls an optional binding parser (`parseJavaFieldBindings`, `parseKotlinFieldBindings`, `parseCppReceiverBindings`, `parseRubyReceiverBindings`, or `new Map()`)
- Delegates to `resolveSimpleSourceCallees(db, match, calls, bindings, limit)`

**Shape B-special -- Ruby**:
- Calls `getSimpleSourceCalls` twice with different options (`allowInstanceVariables`, `allowBareMemberCalls`)
- Uses whichever returns more results

**Design**:

1. **Define a `LanguageCalleeConfig` type**:
   ```typescript
   type LanguageCalleeConfig =
     | {
         kind: 'complex';
         isDocument: (db: ScipDatabase, path: string) => boolean;
         resolveCallTarget: (
           db: ScipDatabase,
           current: IndexedDefinition,
           definitions: IndexedDefinition[],
           imports: ReturnType<typeof getSourceImports>,
           bindings: Map<string, string>,
           receiverName: string | null,
           calleeName: string,
         ) => IndexedDefinition | null;
       }
     | {
         kind: 'simple';
         isDocument: (db: ScipDatabase, path: string) => boolean;
         getBindings: (db: ScipDatabase, source: string) => Map<string, string>;
         callOpts?: { allowInstanceVariables?: boolean; allowBareMemberCalls?: boolean };
         /** Ruby special: try a second set of callOpts and use whichever yields more */
         fallbackCallOpts?: { allowInstanceVariables?: boolean; allowBareMemberCalls?: boolean };
       };
   ```

2. **Define `LANGUAGE_CALLEE_CONFIGS: LanguageCalleeConfig[]`** with one entry per language.

3. **Implement `getLanguageSourceCalleeRows(db, symbol, config, limit)`**:
   - For `kind: 'complex'`: replicate the Python/JS pattern (lines 637-689)
   - For `kind: 'simple'`: replicate the Java/Kotlin/etc. pattern (lines 747-759), with the Ruby fallback special case

4. **Rewrite `getSourceBackedCalleeRows`** to iterate `LANGUAGE_CALLEE_CONFIGS` and return the first match:
   ```typescript
   function getSourceBackedCalleeRows(db, symbol, limit?) {
     const match = getFullSymbolMatch(db, symbol);
     if (!match) return [];
     for (const config of LANGUAGE_CALLEE_CONFIGS) {
       if (config.isDocument(db, match.relativePath)) {
         return getLanguageSourceCalleeRows(db, match, config, limit);
       }
     }
     return [];
   }
   ```

5. **Delete all 12 individual `get*SourceCalleeRows` functions**.

6. **Update `getPythonSourceCallerRows`** (line 956): It currently calls `getPythonSourceCalleeRows` directly. After consolidation, it must call the generic function with the Python config entry. Alternatively, inline a `getLanguageSourceCalleeRows(db, candidate, pythonConfig)` call.

**Net delta**: ~-200 LOC (12 functions deleted, 1 generic + config table + dispatch rewrite added)

**Validation**:
- `npm run build` must succeed
- `scip-query reindex` + `scip-query call-graph getCalleeRowsForSymbol` must show equivalent downstream behavior
- Test with representative symbols from each language to verify callee resolution unchanged

---

## Stress-Test Against 11 Principles

### 1. Understand before you touch
**Finding**: Every function, its callers, callees, and blast radius has been traced with `scip-query code`, `scip-query refs`, `scip-query call-graph`, `scip-query affected`, `scip-query similar`, and `scip-query convergence`. The two shape classes (complex vs simple resolver) are clearly documented. No function is touched without first reading its source.

### 2. Map the blast radius
**Finding**: `scip-query affected getSourceBackedCalleeRows` (b53) shows 44 transitively affected files across all query modules. However, `scip-query change-surface src/query-support.ts` (b67) confirms all 13 callee-row functions have **0 external consumers**. The only exported entry points are `getCalleeRowsForSymbol` (11 consumers) and `getCallerRowsForSymbol` (7 consumers). The refactoring is entirely internal to query-support.ts for Phases 4-6, so the blast radius is contained.

**Risk**: Phase 6 changes internal behavior of `getSourceBackedCalleeRows` which is called by `getCalleeRowsForSymbol` (11 consumers across bottlenecks, call-graph, complexity, convergence, dataflow, extract-candidates, isolated, passthrough-candidates, similar, slice). All consumers see the same `CalleeRow[]` return type and are unaffected by internal dispatch changes.

### 3. Every intermediate state must be valid
**Finding**: Each phase is independently deployable:
- Phase 1 (dead code): Pure deletion, no consumers
- Phase 2 (isCallableSymbol): Extract then replace, no behavior change
- Phase 3 (getScopedDefinitions): Extract then replace, no behavior change
- Phase 4 (is*SourcePath): Add generic + table, rewire internals
- Phase 5 (is*Document): Add generic + table, rewire internals
- Phase 6 (callee rows): Add generic + config, rewire dispatch, delete old functions

Each phase should be a separate commit. If any phase fails, the previous state is valid.

### 4. Reversibility determines rigor
**Finding**: Phases 1-3 are trivially reversible (git revert). Phases 4-5 preserve the named wrapper functions, so a revert just restores the function bodies. Phase 6 is the only high-risk change, but it's the last phase and the previous 5 phases are already committed.

**Mitigation for Phase 6**: Implement the generic function first, then one-by-one convert each language from the old function to the new config entry. Run `npm run build` after each conversion. This gives 12 intermediate revert points.

### 5. Design for failure, not success
**Finding**: The `is*Document` functions run a SQL query that could return null. The consolidated version preserves this null handling (checking `row?.language`). The callee-row generic preserves the early-return-on-null pattern for `getFullSymbolMatch`.

**Mitigation**: The generic functions use the exact same error handling as the originals. No new failure modes are introduced.

### 6. Assume concurrency
**Finding**: `scip-query` is single-threaded (Node.js, synchronous SQLite via better-sqlite3). No concurrency concerns. The `Watcher` class (src/watch.ts) does use async reindexing, but the dead `getStatus()` we're deleting is not involved in any concurrent path.

### 7. Defend the boundaries
**Finding**: All consolidated functions are file-internal (0 external consumers per b67). The public API (`getCalleeRowsForSymbol`, `getCallerRowsForSymbol`) is unchanged. No exported signatures change.

**Exception**: Phase 2 adds a new export (`isCallableSymbol`) to query-support.ts. This is intentional and widens the public surface by one well-defined function.

Phase 3 adds a new export (`getScopedDefinitions`) to query-support.ts. Same rationale.

### 8. Protect data integrity
**Finding**: No database writes in any of these functions. All are read-only query helpers. The `is*Document` functions read from the `documents` table; the callee-row functions read from `mentions`, `chunks`, `defn_enclosing_ranges`. Consolidation does not alter query logic.

### 9. Make it observable
**Finding**: The codebase has no logging/tracing in these functions currently. The consolidation should not add any. If debugging is needed in the future, the generic functions are actually easier to instrument (one function to add a log to, not 13).

### 10. Consider the human
**Finding**: Adding a new language currently requires adding functions in 3+ files. After consolidation, it requires adding one entry to each of 3 tables (`DOCUMENT_LANGUAGE_TABLE`, `LANGUAGE_EXTENSIONS`, `LANGUAGE_CALLEE_CONFIGS`). This is significantly more discoverable and less error-prone.

The named wrapper functions (`isPythonDocument`, etc.) are preserved where they have callers, maintaining readability at call sites.

### 11. Match the existing system
**Finding**: The codebase already uses the pattern of dispatching via predicates (e.g., `getSourceImports` at line 57-97 dispatches via `isJavaScriptSourcePath`, `isPythonSourcePath`, etc.). The consolidation follows the same style: table-driven dispatch with named predicates. No new patterns are introduced.

**No circular dependencies** exist currently (`scip-query cycles` returned clean, b66). The new exports from query-support.ts do not create any cycles because all consumers already import from query-support.ts.

---

## Execution Order

| Order | Phase | Risk | Depends on | Separate commit? |
|---|---|---|---|---|
| 1 | Phase 1: Delete dead code + unused types | None | Nothing | Yes |
| 2 | Phase 2: Merge isCallableSymbol | None | Nothing | Yes |
| 3 | Phase 3: Extract getScopedDefinitions | None | Nothing | Yes |
| 4 | Phase 4: Consolidate is*SourcePath | Low | Nothing | Yes |
| 5 | Phase 5: Consolidate is*Document | Low | Nothing | Yes |
| 6 | Phase 6: Consolidate get*SourceCalleeRows | Medium | Phase 5 (uses is*Document wrappers) | Yes |

Phases 1-3 can be executed in any order. Phase 6 must come after Phase 5 because it references the `is*Document` functions that Phase 5 modifies.

## Ship Order

Ship in the same order as execution. Each commit is independently shippable and reversible.

If time is constrained, Phases 1-3 deliver value with zero risk and should ship regardless.

---

## Summary

### Files Modified

| File | Phases | Changes |
|---|---|---|
| `src/query-support.ts` | 1, 2, 3, 5, 6 | Delete dead `testFileMatchSql`; add exported `isCallableSymbol`, `getScopedDefinitions`; consolidate 12 `is*Document` into table; consolidate 13 `get*SourceCalleeRows` into generic dispatch |
| `src/source-analysis.ts` | 4 | Consolidate 12 `is*SourcePath` into lookup table |
| `src/db.ts` | 1 | Delete dead `setPathFilter`, `filterPaths` |
| `src/watch.ts` | 1 | Delete dead `Watcher.getStatus()` |
| `src/types.ts` | 1 | Delete unused `InstallMethod`, `IndexerOverrides` and their referencing fields |
| `src/queries/methods.ts` | 2 | Replace local `isCallableSymbol` with import |
| `src/queries/surface.ts` | 2 | Replace local `isCallableSymbol` with import |
| `src/queries/extract-candidates.ts` | 3 | Replace local `getScopedDefinitions` with import |
| `src/queries/passthrough-candidates.ts` | 3 | Replace local `getScopedDefinitions` with import |
| `src/queries/wrapper-candidates.ts` | 3 | Replace local `getScopedDefinitions` with import |
| `src/queries/stale-abstractions.ts` | 3 | Replace local `getScopedDefinitions` with import |

### Files Created
None.

### Files Deleted
None.

### Net Code Delta
~-386 LOC across 11 files (estimated breakdown: Phase 1 -32, Phase 2 -3, Phase 3 -51, Phase 4 -10, Phase 5 -90, Phase 6 -200).

### Post-Implementation Verification
After all phases:
1. `npm run build` succeeds
2. `scip-query reindex` succeeds
3. `scip-query health` score >= 83 (baseline 78)
4. `scip-query dead --min-loc 3` no longer lists the 4 deleted symbols
5. `scip-query cycles` still returns clean
6. `scip-query call-graph getCalleeRowsForSymbol` shows same structure
7. `scip-query similar getJavaSourceCalleeRows` returns no results (function deleted)
