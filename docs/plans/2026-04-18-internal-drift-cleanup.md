# Internal drift cleanup — canonicalize range and signature access

**Date:** 2026-04-18
**Status:** Proposed
**Related:** Follow-up to the line-accuracy audit completed 2026-04-18 (see commits against `query-support.ts`, `outline.ts`, `members.ts`, `change-surface.ts`, `system.ts`, `complexity-hotspots.ts`, and new `getResolvedReferenceSites`). User-visible line numbers are now correct; this plan kills the *internal* drift that remains.

---

## Problem statement

After the accuracy pass, every command that **prints** a line number routes through a canonical helper (`getDefinitionsForFile`, `getAllDefinitions`, `findFirstSymbolMatch`, `getResolvedReferenceSites`, `getSourceReferenceSites`). But four sites still use the old patterns internally, and two signature-extraction paths are duplicated in SQL:

| Site | Drift | Impact |
|---|---|---|
| `src/queries/similar.ts:271-312` (`getAllCalleeFingerprints`) | Raw `der.start_line/end_line` used as bounds for `getCalleeRowsForSymbol`. | When the raw SCIP range is too wide, callees from the next function leak into this fingerprint. `similar` scores and `convergence` recommendations silently shift. |
| `src/queries/slice.ts:82-145` (`forwardSlice`) | Single SQL query uses raw ranges AND inline correlated subquery for enclosing-symbol attribution. | Same raw-range bleed, plus the enclosing-symbol lookup disagrees with `findEnclosingDefinition` when the indexer's range differs from the corrected range. |
| `src/queries/symbols.ts:17-22` | In-SQL `REPLACE(SUBSTR(documentation, INSTR(documentation, '\|') + 1), char(10), ' ')` | Duplicated signature extraction logic. Third site (`src/queries/system.ts:94-99`) already moved it to a JS helper (`extractSignature`), creating two canonical forms. |
| `src/queries/trace.ts:17-25` | Same in-SQL expression as `symbols.ts`. | Same duplication. |

**Target state:** every range used as a callee/mention bound comes from `getDefinitionsForFile` (source-corrected). Every enclosing-symbol attribution goes through `findEnclosingDefinition`. Signature extraction lives in one helper. A short "where to get what" note at the top of `query-support.ts` makes the contract discoverable so the next drift gets caught in review.

---

## Conventions (existing patterns to match)

These are the canonical helpers every new code path must use. All citations are from `scip-query trace`.

- **Corrected ranges per file** → `getDefinitionsForFile(db, relativePath)` at `src/query-support.ts:884`. Applies `correctDefinitionRangesFromSource` then caches per-db.
- **Corrected ranges project-wide** → `getAllDefinitions(db, { scope? })` at `src/query-support.ts:1250`. Wraps `getDefinitionsForFile` per document.
- **User pattern → SymbolMatch** → `findFirstSymbolMatch(db, pattern)` at `src/query-support.ts:151`. Hydrates via `hydrateSymbolMatch`, which resolves to corrected ranges.
- **Callers/callees** → `getCallerRowsForSymbol(db, symbol)` / `getCalleeRowsForSymbol(db, symbol)` in `src/query-support.ts`. Both expect a `SymbolLocation` with corrected bounds.
- **Reference-line lookup** → `getSourceReferenceSites` (unique-leaf scan) or `getResolvedReferenceSites` (mention-resolved + in-chunk scan) in `src/query-support.ts:537,599`.
- **Enclosing symbol at a line** → `findEnclosingDefinition(definitions, line)` at `src/query-support.ts:701`. **Currently file-local**; this plan exports it.
- **Signature cleanup** → `cleanSignature(sig)` at `src/queries/clean-signature.ts:7`. This plan adds `extractSignature` beside it.

Existing example of the canonical pattern in similar.ts itself — `getAllSourceFingerprints` at line 393 — already goes through `getAllDefinitions`. The callee fingerprint path is the one outlier.

```
Source: scip-query trace getDefinitionsForFile, getAllDefinitions, findFirstSymbolMatch,
        getCalleeRowsForSymbol, getSourceReferenceSites, getResolvedReferenceSites,
        findEnclosingDefinition, cleanSignature, extractSignature
Source: scip-query code 'src/queries/similar.ts:393-405' (existing canonical usage)
```

---

## Phase A — Consolidate signature extraction (Item 3)

**Shape:** move `extractSignature` from `system.ts` into `clean-signature.ts`, replace the SQL expressions in `symbols.ts` and `trace.ts` with a call through the pair `extractSignature` → `cleanSignature`. No semantic change for any command — the JS helper is a faithful port of the SQL expression (`doc.slice(doc.indexOf('|') + 1).replace(/\n/g, ' ')`).

**Reversibility:** two-way door — pure refactor. If regressions appear, revert the three edits.

### A.1 — Add `extractSignature` to `clean-signature.ts`

- [ ] **File**: `src/queries/clean-signature.ts:7-22` (append below existing `cleanSignature`)
- **Source**: `scip-query code cleanSignature`, `scip-query code extractSignature`
- **What**: `clean-signature.ts` currently exports one function. `extractSignature` lives privately in `src/queries/system.ts:94-99`.
- **Change**: move `extractSignature` into `clean-signature.ts` and export it. Remove it from `system.ts`.
  ```ts
  /**
   * SCIP indexers store `documentation` as "docstring|signature" (pipe-delimited).
   * `extractSignature` pulls the signature half; newlines are flattened to spaces
   * so downstream one-liner rendering works. If the pipe is absent the whole
   * `documentation` string is treated as signature — matches the SQL behaviour
   * that `symbols.ts` and `trace.ts` used before this helper existed.
   */
  export function extractSignature(doc: string | null): string | null {
    if (!doc) return null;
    const pipeIdx = doc.indexOf('|');
    if (pipeIdx === -1) return doc.replace(/\n/g, ' ');
    return doc.slice(pipeIdx + 1).replace(/\n/g, ' ');
  }
  ```
- **Why**: single source of truth for the SCIP `documentation` format. If the delimiter ever changes, one place updates.

### A.2 — Update `src/queries/system.ts` to import `extractSignature`

- [ ] **File**: `src/queries/system.ts:5, 45, 94-99`
- **Source**: `scip-query code 'src/queries/system.ts:1-99'`
- **What**: `system.ts:94-99` currently defines a local `extractSignature`. The import at line 5 is `import { cleanSignature } from './clean-signature.js';`.
- **Change**: change the import to `import { cleanSignature, extractSignature } from './clean-signature.js';`. Delete the local function (lines 94-99). The call site at line 43 (`const sig = extractSignature(d.documentation);`) keeps working via the import.
- **Why**: consume the canonical helper.

### A.3 — Rewrite signature fetch in `src/queries/symbols.ts`

- [ ] **File**: `src/queries/symbols.ts:5, 17-22, 29`
- **Source**: `scip-query code 'src/queries/symbols.ts:1-32'`
- **What**: `symbols.ts` currently does `SELECT REPLACE(SUBSTR(documentation, INSTR(documentation, '|') + 1), char(10), ' ') AS sig FROM global_symbols WHERE id = ?` per symbol and passes `sig` into `cleanSignature`.
- **Change**:
  - Update import: `import { cleanSignature, extractSignature } from './clean-signature.js';`
  - Replace the SQL at lines 17-22 with `db.get<{ documentation: string | null }>('SELECT documentation FROM global_symbols WHERE id = ?', row.symbolId)`.
  - Line 29 becomes `signature: cleanSignature(extractSignature(docRow?.documentation ?? null))`.
- **Why**: same behaviour via the JS helper. Removes the third copy of the SCIP-documentation parsing logic.

### A.4 — Rewrite signature fetch in `src/queries/trace.ts`

- [ ] **File**: `src/queries/trace.ts:5, 14-25, 33, 98-115`
- **Source**: `scip-query code 'src/queries/trace.ts:1-30'`
- **What**: `trace.ts:14-25` uses the same `REPLACE(SUBSTR(...), ...)` form in a larger SELECT that also fetches `display_name`. The signature is consumed by `buildTraceSignature` (`trace.ts:98-115`).
- **Change**:
  - Update import to `import { cleanSignature, extractSignature } from './clean-signature.js';`.
  - Replace the SQL at lines 14-25 with `db.get<{ display_name: string | null; documentation: string | null }>('SELECT display_name, documentation FROM global_symbols WHERE id = ?', match.symbolId)`.
  - At line 33, compute `const sig = extractSignature(definitionMeta?.documentation ?? null);` and pass `sig` into `buildTraceSignature` instead of `definitionMeta?.sig`.
- **Why**: last copy of the SQL-based extraction removed. `trace.ts` now uses the same two helpers as every other signature-consuming query.

### A.5 — Verification

- [ ] Run `npm run typecheck` → expect clean.
- [ ] Run `npm test` → expect 111/111 passing (no new tests, pure refactor).
- [ ] Optional spot check: `scip-query symbols src/db.ts` and `scip-query trace ScipDatabase` — signatures in output should be byte-identical to the pre-change output.

---

## Phase B — Forward-slice refactor (Item 2)

**Shape:** replace the monolithic SQL in `forwardSlice` with a JS composition: `getResolvedReferenceSites` → for each ref, look up the enclosing definition with `findEnclosingDefinition` (now exported) → `getCalleeRowsForSymbol` on that enclosing → filter and dedupe. Preserves the existing output shape and filters (`LIMIT 30`, exclude same-file outputs, exclude the target and the enclosing itself).

**Reversibility:** two-way door. Swap in the JS implementation; if it regresses, revert. The SQL version is 60 lines and easy to restore.

### B.1 — Export `findEnclosingDefinition` from `query-support.ts`

- [ ] **File**: `src/query-support.ts:701`
- **Source**: `scip-query trace findEnclosingDefinition` — currently used only inside `getSourceReferenceSites` (line 571) and `getResolvedReferenceSites` (line 472). No consumers outside the file.
- **What**: the function signature is currently `function findEnclosingDefinition(...)` — no `export`.
- **Change**: change to `export function findEnclosingDefinition(...)`. No body edits.
- **Why**: `slice.ts` needs to call it. All other uses are within the file so the rename is lossless.

### B.2 — Rewrite `forwardSlice` in `src/queries/slice.ts`

- [ ] **File**: `src/queries/slice.ts:2, 82-145`
- **Source**: `scip-query code 'src/queries/slice.ts:82-145'`
- **What**: `forwardSlice` issues one SQL query (lines 85-123) that:
  - Joins `mentions` (role != 1) with the target's `symbol_id` to find reference chunks.
  - Joins `defn_enclosing_ranges` with raw `start_line/end_line` bounds to find the enclosing definition at each ref chunk.
  - Joins `mentions` again (role != 1) bounded by the enclosing definition's range to find other symbols referenced there.
  - Filters to `out_d.id != ref_d.id` (only cross-file outputs) and excludes the target + enclosing.
  - Sorts by `out_d.relative_path`, limits 30.
- **Change**: rewrite as JS composition. New imports:
  ```ts
  import {
    findEnclosingDefinition,
    findExactSymbolMatch,
    findFirstSymbolMatch,
    getCalleeRowsForSymbol,
    getDefinitionsForFile,
    getResolvedReferenceSites,
    getSourceReferenceSites,
    type SymbolMatch,
  } from '../query-support.js';
  ```
  New body (pseudocode, real TypeScript in the diff):
  ```ts
  function forwardSlice(db: ScipDatabase, match: SymbolMatch): SliceResult {
    const refs = getSourceReferenceSites(db, match).length > 0
      ? getSourceReferenceSites(db, match)
      : getResolvedReferenceSites(db, match);

    const seenOutputs = new Set<string>();
    const connected: SliceResult['connectedSymbols'] = [];

    for (const ref of refs) {
      if (connected.length >= 30) break;
      if (db.isIgnored(ref.file)) continue;

      // Enclosing symbol via corrected ranges — use the JS helper so we agree
      // with getSourceReferenceSites/getResolvedReferenceSites, which already
      // compute enclosing the same way.
      const enclosingSymbol =
        ref.enclosingSymbol ?? findEnclosingDefinition(
          getDefinitionsForFile(db, ref.file),
          ref.line,
        )?.symbol ?? null;
      if (!enclosingSymbol || enclosingSymbol === match.symbol) continue;

      const enclosingMatch = findExactSymbolMatch(db, enclosingSymbol);
      if (!enclosingMatch) continue;

      for (const callee of getCalleeRowsForSymbol(db, enclosingMatch)) {
        if (callee.symbol === match.symbol) continue;
        if (callee.symbol === enclosingSymbol) continue;
        if (callee.file === ref.file) continue;                 // `out_d.id != ref_d.id`
        if (db.isIgnored(callee.file)) continue;
        if (seenOutputs.has(callee.symbol)) continue;
        seenOutputs.add(callee.symbol);

        connected.push({
          symbol: callee.symbol,
          shortName: shortenSymbol(callee.symbol),
          file: callee.file,
          relationship: `used alongside target in ${shortenSymbol(enclosingSymbol)}`,
        });
        if (connected.length >= 30) break;
      }
    }

    connected.sort((a, b) => a.file.localeCompare(b.file));     // preserve SQL's ORDER BY
    return {
      symbol: match.symbol,
      shortName: shortenSymbol(match.symbol),
      direction: 'forward',
      connectedSymbols: connected,
    };
  }
  ```
- **Why**: every range used for bounds is now source-corrected (via `getCalleeRowsForSymbol(enclosingMatch)`, which carries the corrected range from `findExactSymbolMatch`). The enclosing-symbol attribution agrees with every other query that does the same lookup.

### B.3 — Verify the existing `queries-advanced.test.ts` forward-slice test still passes

- [ ] **File**: `tests/queries-advanced.test.ts:120`
- **Source**: `scip-query files queries-advanced.test` — test invokes `queries.slice(db, 'normalize', { direction: 'forward' })`.
- **What**: this test asserts a specific output shape for forward slice. Post-refactor, the output shape is identical but the *list of connected symbols* may shift slightly if the fixture has any ranges that the corrector changes. Expect the assertion to either (a) still pass because the fixture's ranges were already tight, or (b) need a small update to match the new (more-accurate) output.
- **Change**: run the test; if it fails, read the diff and update the expected array only if the change is a correct improvement (i.e., the new output reflects tighter enclosing attribution). Do NOT update the test to paper over a real regression.
- **Why**: fixture drift is fine if justified; real regression is not.

### B.4 — Add a new regression test that pins enclosing agreement

- [ ] **File**: `tests/queries-advanced.test.ts` (append)
- **Source**: `scip-query code 'tests/queries-advanced.test.ts:1-50'` for existing fixture setup conventions.
- **What**: there's no test today that proves `slice.forwardSlice`'s enclosing attribution matches `findEnclosingDefinition`.
- **Change**: add a test that, for the fixture's target symbol, computes enclosing for each reference site via `findEnclosingDefinition` directly, then calls `forwardSlice` and asserts that every `relationship` string contains one of those enclosing symbols' short names. This pins the invariant "forward slice's enclosing attribution goes through the canonical helper."
- **Why**: without this test, the `forwardSlice` implementation could silently drift again without anyone noticing.

### B.5 — Verification

- [ ] `npm run typecheck` → clean.
- [ ] `npm test` → 111 + new tests passing.
- [ ] `scip-query slice runHarness --forward` in the meta_harness project → spot check output reasonable.

---

## Phase C — Similar-callee fingerprint refactor (Item 1)

**Shape:** replace the raw-range SQL in `getAllCalleeFingerprints` with a JS traversal over `getAllDefinitions`. The existing `getAllSourceFingerprints` (same file, line 393) is the model — it already uses `getAllDefinitions` and proves the pattern works. All filters (minimum LOC >= 5, `isFunctionLike`, gitignore, symbol noise) move into JS, where they already run in the `getAllSourceFingerprints` path.

**Reversibility:** two-way door. The replacement is 15 lines; revert is cheap.

### C.1 — Rewrite `getAllCalleeFingerprints` in `src/queries/similar.ts`

- [ ] **File**: `src/queries/similar.ts:2-3, 263-312`
- **Source**: `scip-query code 'src/queries/similar.ts:263-313'`, `scip-query code 'src/queries/similar.ts:393-405'`
- **What**: `getAllCalleeFingerprints` at lines 263-312 issues raw SQL against `defn_enclosing_ranges` filtering by `end_line - start_line + 1 >= 5`, then in JS filters by `isFunctionLikeSymbol` and calls `getCalleeRowsForSymbol` with the raw range.
- **Change**:
  ```ts
  function getAllCalleeFingerprints(
    db: ScipDatabase,
    opts: { minCallees: number; scope?: string; excludeSymbol?: string },
  ): SymbolFingerprint[] {
    const { minCallees, scope, excludeSymbol } = opts;
    const fingerprints: SymbolFingerprint[] = [];

    for (const definition of getAllDefinitions(db, { scope })) {
      if (db.isIgnored(definition.relativePath)) continue;
      if (!definition.isFunctionLike) continue;
      if (excludeSymbol && definition.symbol === excludeSymbol) continue;
      // Minimum LOC guard matches the previous SQL filter. Keeps small helpers
      // out of the fingerprint set — their callee sets are too thin for TF-IDF
      // similarity to be meaningful.
      if ((definition.endLine - definition.startLine + 1) < 5) continue;

      const callees = new Set(
        getCalleeRowsForSymbol(db, definition).map((row) => row.symbol),
      );
      if (callees.size < minCallees) continue;

      fingerprints.push({
        symbol: definition.symbol,
        file: definition.relativePath,
        callees,
      });
    }

    return fingerprints;
  }
  ```
  Update the import at line 2 to include `getAllDefinitions`:
  ```ts
  import {
    findFirstSymbolMatch,
    getAllDefinitions,
    getCalleeRowsForSymbol,
  } from '../query-support.js';
  ```
  `getAllDefinitions` was already imported via the `similar.ts:394` path — this is a renaming/consolidation, not a new symbol.
- **Why**: `getCalleeRowsForSymbol` receives a `SymbolLocation` with source-corrected bounds. Callees from the next function (which leak through when raw bounds are too wide) stop appearing in this fingerprint. `similar`, `similarAll`, and any `convergence` call downstream benefit.

### C.2 — Add a fingerprint-isolation regression test

- [ ] **File**: `tests/command-accuracy.test.ts` (append near the `similarAll` test at line 557)
- **Source**: `scip-query code 'tests/command-accuracy.test.ts:555-595'` for the existing `similarAll` fixture.
- **What**: the current `similarAll` test checks output structure but doesn't pin the invariant that fingerprints stay within corrected ranges.
- **Change**: add a fixture with two adjacent single-line TypeScript functions where one calls `sharedOne()` and the other calls `sharedTwo()`. The SCIP raw ranges will (after conversion) overlap slightly or abut exactly. Build fingerprints via `getAllCalleeFingerprints` (or call `similarAll` and project out the internal state — simpler: just exercise `similarAll` and assert that the callee sets, as reflected in the `sharedCallees` / `uniqueToA` / `uniqueToB` returned by `similarAll`, contain only the caller's actual callee. Cross-pollution would show up as `sharedOne` appearing in the `uniqueTo` set of the function that doesn't call it.
- **Why**: locks the invariant. If someone restores raw ranges later, this test fails.

### C.3 — Verification

- [ ] `npm run typecheck` → clean.
- [ ] `npm test` → green.
- [ ] `scip-query similar runHarness --limit 5` against meta_harness → spot check — output shape unchanged, scores may shift slightly.
- [ ] Run both TypeScript *and* Python fixtures (`tests/python-accuracy.test.ts` includes one) to confirm the change is language-neutral as claimed.

---

## Phase D — Documentation (Item 4)

**Shape:** a short "where to get what" section at the top of `src/query-support.ts` so contributors find the canonical helpers before writing new SQL. Not a README.md because agents/tools already discover query-support via grep when reading queries.

**Reversibility:** obvious — it's a comment.

### D.1 — Add module-level doc comment to `src/query-support.ts`

- [ ] **File**: `src/query-support.ts:1`
- **Source**: `scip-query code 'src/query-support.ts:1-80'`
- **What**: the file has no module-level docstring today.
- **Change**: insert above line 1:
  ```ts
  /**
   * query-support — shared helpers for command queries.
   *
   * Where to get what:
   *
   *   Symbol ranges (for output OR as bounds):
   *     - Per file:   getDefinitionsForFile(db, relativePath)
   *     - Project:    getAllDefinitions(db, { scope? })
   *     - User input: findFirstSymbolMatch(db, pattern)
   *   All three return source-corrected ranges. Do NOT read
   *   defn_enclosing_ranges.start_line/end_line directly if the result
   *   will be shown to a user or used to bound a mention lookup.
   *
   *   Reference lines (where is this used?):
   *     - Primary:    getSourceReferenceSites — cross-file identifier
   *                   scan; returns [] when the leaf name is ambiguous.
   *     - Fallback:   getResolvedReferenceSites — mention-resolved
   *                   chunks with in-chunk line refinement. Always
   *                   returns a result when the symbol has mentions.
   *   Do NOT read chunks.start_line as the "line of a reference";
   *   a chunk spans many source lines.
   *
   *   Enclosing symbol at a line:
   *     - Use findEnclosingDefinition(definitions, line) with a
   *       getDefinitionsForFile result. This matches what
   *       getSourceReferenceSites and getResolvedReferenceSites use
   *       internally, so attribution stays consistent across commands.
   *
   *   Counts and existence checks only:
   *     - Direct SQL on mentions/chunks is fine here — e.g., "how many
   *       files reference this symbol" in fan.ts. Never use chunk
   *       start_line as a line number in output.
   */
  ```
- **Why**: discoverable contract. When a contributor adds a new query, the first file they read when wondering "how do I get a symbol's range" now tells them the answer.

---

## Execution order

```
Phase A (signatures)       ← pure refactor, zero semantic change
    │
    ▼
Phase B (forward slice)    ← needs A done? No. Independent. Order by preference.
    │
    ▼
Phase C (similar)          ← independent from A and B.
    │
    ▼
Phase D (docs)             ← lands last so it describes the final state.
```

All four phases are independent at the file level. The suggested ship order is A → B → C → D because A is the safest (pure refactor), then B (contained to one file's one function), then C (invariant-changing but small), then D.

Each phase is independently deployable. If something breaks, revert only that phase.

---

## Ship order

1. **Phase A**: low-risk refactor. Ship alone. Tests must be 111/111.
2. **Phase B**: slice forward-slice rewrite. Ship alone. Watch `queries-advanced.test.ts:120` — adjust only if output shift is a correct improvement.
3. **Phase C**: similar refactor. Ship alone. Spot-check `scip similar` output on both TS and Python fixtures.
4. **Phase D**: docs comment. Ship alone.

No phase is a one-way door. Nothing in this plan touches a public API, a published package, or a persistent artifact (the `file:../scip-query` symlink in meta_harness picks up each phase automatically after a local `npm run build`).

---

## Stress-test against the 11 principles

Checked every principle against every phase. Only calling out phases where the principle reveals something non-trivial.

### 1. Understand before you touch

- **Phase A**: the SQL form existed before `cleanSignature` was extracted (per the comment at `clean-signature.ts:5`: "Previously duplicated as cleanSig/cleanSignature in three files"). The SQL was how the original pre-helper state looked. Moving fully to JS completes the refactor that was started.
- **Phase B**: the one-query forward-slice design was a performance optimization when JS-side alternatives would have meant N+1 queries for ref sites. With `getResolvedReferenceSites` caching per-file definitions and `findIdentifierLines` already computing one source-scan per file, the JS version doesn't regress on query count.
- **Phase C**: the raw-range SQL filter was not load-bearing. `getAllSourceFingerprints` already proves the JS path works for the same shape of problem.

### 2. Map the blast radius

Used `scip-query rdeps` + `scip-query change-surface` on every modified file.

| File | External consumers |
|---|---|
| `src/queries/similar.ts` | 3 callers (cli.ts, health.ts, queries/index.ts) — only `similar`/`similarAll` are exported and consumed. Internal helpers changed here have 0 external consumers. |
| `src/queries/slice.ts` | 2 callers (cli.ts, queries/index.ts) — only `slice` is exported. `forwardSlice` is file-private. |
| `src/queries/symbols.ts` | 2 callers. Output shape unchanged. |
| `src/queries/trace.ts` | 2 callers. Output shape unchanged. |
| `src/queries/system.ts` | 2 callers. `extractSignature` deleted locally, but consumer (line 43) imports from the new location. |
| `src/queries/clean-signature.ts` | Was 3 consumers (symbols, trace, system); now also exports `extractSignature` consumed by those three. Adding an export doesn't break existing imports. |
| `src/query-support.ts` | 47 consumers per `rdeps`. Adding `export` to `findEnclosingDefinition` is additive; no existing consumer cares. Module-level comment is inert. |

No consumer receives a different type from any changed function. Public signatures are unchanged.

**Source**: `scip-query rdeps src/queries/{similar,slice,symbols,trace,system,clean-signature}.ts`, `scip-query change-surface src/queries/{similar,slice}.ts`.

### 3. Every intermediate state must be valid

- After A.1 alone: `extractSignature` exists in both `clean-signature.ts` (exported) and `system.ts` (local). Build passes, tests pass. A.2 deletes the local copy immediately after.
- After A.3 alone: `symbols.ts` uses the new helper; `trace.ts` still uses in-SQL. Both build, both tested, no drift introduced. A.4 closes it.
- Phase B and C each land as single commits. No half-applied state.

### 4. Reversibility

Every step is a two-way door. All revertable via `git revert`. No schema changes, no persistent artifacts.

### 5. Design for failure

- **Phase B**: `findExactSymbolMatch(db, enclosingSymbol)` can return null if the SCIP index has a mention whose enclosing definition isn't in `defn_enclosing_ranges`. Handled with `if (!enclosingMatch) continue;` — same degradation the current SQL has (the JOIN fails silently).
- **Phase B**: `getResolvedReferenceSites` can return an empty array when a symbol has no mentions at role != 1 (dead code, or an interface with no implementations). `forwardSlice` returns an empty `connectedSymbols` — same as the current SQL.
- **Phase C**: same degradation properties as the existing `getAllSourceFingerprints` path. If `getCalleeRowsForSymbol` returns empty for a definition, the fingerprint is dropped by `callees.size < minCallees`.

### 6. Assume concurrency

No new shared mutable state. `FILE_DEFINITION_CACHE` in `query-support.ts:64` is already a WeakMap keyed by db instance; the new call sites inherit that cache correctly because they pass the same `db` reference.

### 7. Defend the boundaries

All phases touch read-only query paths. No new entry point; no new user input parsed. The CLI contract is unchanged.

### 8. Protect data integrity

No schema change. No data mutation. The SQLite DB is opened read-only at `src/db.ts:28`.

### 9. Make it observable

No new error paths requiring logging. Existing `try/catch` in `cli.ts` still catches query failures. If a refactor introduces a bug, it surfaces as wrong output, not a silent swallowing.

### 10. Consider the human

Output shapes are identical. A user running `scip similar` or `scip slice --forward` before and after the change sees the same columns; the list contents may shift by 1-2 entries at most (Phase B's more-focused enclosing attribution, Phase C's cleaner fingerprints). This is a quality improvement, not a breaking change.

### 11. Match the existing system

- **Phase A**: matches the pattern `clean-signature.ts:5` already hints at.
- **Phase B**: matches how `getResolvedReferenceSites` and `getSourceReferenceSites` compose their results (reference sites → enclosing via `findEnclosingDefinition` → downstream lookup).
- **Phase C**: matches `getAllSourceFingerprints` line-for-line in structure.
- **Phase D**: matches existing module-level JSDoc conventions in `src/db.ts:5-19`.

---

## Verification (per concrete-plan workflow step 4)

- [ ] `scip-query reindex` before every phase.
- [ ] `scip-query diff-impact` after each phase — expect no cross-file surprises beyond the files we touched + their immediate consumers.
- [ ] `npm test` at the end of each phase.
- [ ] Run the meta_harness smoke battery (`scip-query symbols src/harness.ts`, `scip-query similar`, `scip-query slice --forward`) against the symlinked dev build to confirm end-to-end behaviour.

---

## Files modified / created / deleted

**Modified:**
- `src/queries/clean-signature.ts` (+ `extractSignature`)
- `src/queries/system.ts` (− local `extractSignature`, import update)
- `src/queries/symbols.ts` (SQL → JS signature extraction)
- `src/queries/trace.ts` (SQL → JS signature extraction)
- `src/queries/slice.ts` (SQL forwardSlice → JS composition)
- `src/queries/similar.ts` (SQL fingerprint fetch → `getAllDefinitions`)
- `src/query-support.ts` (export `findEnclosingDefinition`, add module doc comment)
- `tests/queries-advanced.test.ts` (+ forward-slice enclosing-agreement test)
- `tests/command-accuracy.test.ts` (+ similar fingerprint isolation test)

**Created:** none.

**Deleted:** none (only the local `extractSignature` body in `system.ts`, moved not removed).

**Net code delta:** approximately −40 SQL lines, +60 JS lines, net +20 including new tests and doc comment.
