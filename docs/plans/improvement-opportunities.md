# Improvement Opportunities

Self-audit of the scip-query codebase using its own analysis tools. Each finding includes the command that surfaced it, what it means, and what the fix looks like.

---

## 1. Replace 26 inline `symbolNoise` filters with `db.symbolNoise`

**Found by:** `grep` on `similar` output (78-80% callee overlap driven by shared SQL boilerplate)

**Problem:** The fragment `AND gs.symbol NOT LIKE '%typeLiteral%'` appears 26 times across 16 query files. The companion `AND gs.symbol NOT LIKE '%().(%'` appears in most of those too. `db.symbolNoise` was added as a reusable getter but never wired in.

**Files affected:**
- `bottlenecks.ts`, `by-kind.ts`, `call-graph.ts` (3 occurrences), `dead.ts`, `doc-coverage.ts` (3), `extract-candidates.ts` (2), `fan.ts`, `hotspots.ts`, `isolated.ts`, `members.ts`, `methods.ts`, `outline.ts`, `similar.ts` (4), `symbols.ts`, `system.ts`, `test-coverage.ts` (2), `trace.ts` (2)

**Fix:** Replace each inline `AND gs.symbol NOT LIKE '%typeLiteral%' AND gs.symbol NOT LIKE '%().(%'` with `AND ${db.symbolNoise}` (or a string interpolation of the getter). This cuts ~50 lines and ensures the noise filter is defined in one place — if we need to add a new pattern (e.g., filtering out synthetic generics), it changes in one spot.

---

## 2. Replace 32 inline `node_modules` exclusions with `db.pathExclusions`

**Found by:** `grep` on `similar-files` output (100% dep-profile similarity across all query modules)

**Problem:** `d.relative_path NOT LIKE 'node_modules/%'` appears 32 times across 18 files. Often paired with `.git/%` exclusions. The `db.pathExclusions` getter exists but isn't used.

**Files affected:** Every query file.

**Fix:** Same pattern as #1 — interpolate `${db.pathExclusions}` where applicable. Some queries use different table aliases (`def_d`, `ref_d`, `d1`, `d2`) so the getter may need a parameter for the alias, or we add alias-specific variants.

---

## 3. Extract shared `buildFileDepGraph()` helper

**Found by:** `similar-chains`, `cycles`, `deep-chains`, `similar-files` all contain identical graph-building SQL

**Problem:** Four query modules build the exact same file dependency graph:
- `cycles.ts:17-35`
- `deep-chains.ts:16-34`
- `similar-chains.ts:125-143`
- `similar-files.ts:66-84`

Each runs this ~18-line SQL query, builds a `Map<string, Set<string>>` adjacency list, and filters by gitignore. The code is identical except for the `scopeFilter` variable name.

**Fix:** Extract a shared `buildFileDepGraph(db, scope?)` helper that returns a `Map<string, Set<string>>`. All four modules import and call it. Saves ~54 lines and ensures graph-building logic stays consistent (e.g., if we later add `.d.ts` exclusions, it changes in one place).

---

## 4. Extract shared test-file pattern constants

**Found by:** `grep` on test-pattern strings

**Problem:** Test file path patterns (`%/__tests__/%`, `%.test.%`, `%.spec.%`, etc.) are defined:
- As an array in `test-coverage.ts:7-16`
- As individual SQL fragments in `dead.ts:34-37`
- As individual SQL fragments in `isolated.ts:35-37`

Three different representations of the same concept.

**Fix:** Export a `TEST_FILE_PATTERNS` constant (and a `testFileExclusionSql(alias)` helper that generates the SQL) from a shared location. `dead.ts`, `isolated.ts`, and `test-coverage.ts` all import it.

---

## 5. `queries/index.ts` barrel has score 136 bottleneck

**Found by:** `bottlenecks` command

**Problem:** The barrel re-export file (`queries/index.ts`) has fan-in=2, fan-out=68. Every query symbol is re-exported through it, so any consumer (`cli.ts`, `index.ts`) pulls the entire query surface. This is fine for a CLI tool, but if this package is used as a library, consumers pay for every query module even if they use one.

**Fix (for later):** Support tree-shaking by also exporting individual query modules:
```ts
// Direct import for library consumers
import { hotspots } from 'scip-query/queries/hotspots';
```
This needs `exports` map entries in `package.json`. Not urgent — the barrel is correct for CLI use.

---

## 6. `cli.ts` is the highest fan-out non-barrel file (23 external symbols)

**Found by:** `fan-out` command

**Problem:** `cli.ts` imports from 8 internal modules and references 23 external symbols. It's a 770+ line file that defines 34 commands inline. Each command's `.action()` handler does its own `openDb()` / `queries.X()` / `console.log()` / `db.close()` dance.

**Fix:** This isn't a bug — CLIs are inherently high fan-out. But if the file keeps growing, the repetitive `openDb` → query → format → `close` pattern could be extracted into a `runQuery(queryFn, formatter)` wrapper that handles the lifecycle. Each command would then be ~3 lines instead of ~15.

---

## 7. `similar-files` shows 100% similarity across all query modules

**Found by:** `similar-files --min-similarity 0.7`

**Problem:** Every query file depends on the same 3 files: `db.ts`, `types.ts`, `symbol-parser.ts`. This makes the file-level similarity metric saturate at 100%. It's not a code quality issue — it's a signal that the dependency profile is too uniform to distinguish files at this level.

**Implication for the tool itself:** The `similar-files` command should probably discount "universal" dependencies (files imported by >50% of the codebase) to surface more meaningful similarity. Universal deps like `types.ts` are infrastructure, not similarity signals.

---

## 8. Callee-set queries repeat identical SQL in `similar.ts` and `extract-candidates.ts`

**Found by:** `similar` command (78% overlap between those two files)

**Problem:** Both `similar.ts` and `extract-candidates.ts` run the same "find all callees of a symbol within its definition range" SQL query. `similar.ts` has it in `findCallees()` (line ~120) and `getAllCalleeFingerprints()` (line ~175). `extract-candidates.ts` has it inline (line ~55).

**Fix:** Extract a `getCalleesForSymbol(db, documentId, startLine, endLine, symbolId)` helper. Used by `similar.ts` (twice) and `extract-candidates.ts` (once). Also usable by `call-graph.ts` which runs a similar query.

---

## 9. Deep chains are all rooted at `queries/index.ts` → `cli.ts`

**Found by:** `deep-chains --min-depth 4`

**Problem:** Every deep chain starts at `index.ts` or `cli.ts` because they're the barrel/entry points. The chains themselves are only depth 4-5, which is healthy. No action needed — this confirms the architecture is flat.

**Assessment:** Not an issue. Healthy architecture signal.

---

## 10. No circular dependencies

**Found by:** `cycles` command

**Assessment:** Clean. No action needed.

---

## Summary

| # | Finding | Severity | Effort | Lines saved |
|---|---------|----------|--------|-------------|
| 1 | Inline `symbolNoise` filters (26x) | Medium | Low | ~50 |
| 2 | Inline `node_modules` exclusions (32x) | Medium | Low | ~30 |
| 3 | Duplicated graph-building SQL (4 files) | Medium | Low | ~54 |
| 4 | Duplicated test-file patterns (3 files) | Low | Low | ~15 |
| 5 | Barrel bottleneck (tree-shaking) | Low | Medium | 0 (structure) |
| 6 | CLI fan-out / repetitive handlers | Low | Medium | ~100 |
| 7 | `similar-files` universal dep discount | Low | Medium | 0 (algorithm) |
| 8 | Duplicated callee-set SQL | Medium | Low | ~30 |
| 9 | Deep chains rooted at entry points | None | — | — |
| 10 | No cycles | None | — | — |

**Quick wins (items 1-4, 8):** ~180 lines eliminated, 5 shared helpers, ~30 minutes of work. All low-risk mechanical extractions.

**Structural improvements (items 5-7):** Algorithm and architecture changes that improve the tool's own quality and the accuracy of its similarity detection. Medium effort, high value for the product.
